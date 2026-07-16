import type { AttachmentObjectStore } from '../attachmentObjectStore';

export const ATTACHMENT_PART_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_PARTS = 10;
export const ATTACHMENT_TOTAL_MAX_BYTES = ATTACHMENT_PART_BYTES * ATTACHMENT_MAX_PARTS;
export const ATTACHMENT_UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const ATTACHMENT_FILENAME_MAX_BYTES = 255;
export const ATTACHMENT_METADATA_MAX_BYTES = 16 * 1024;

export type AttachmentOwner = {
  scope: 'material' | 'task_sop' | 'requirement';
  uid: string;
};

export type AttachmentPartReceipt = {
  partNumber: number;
  etag: string;
  sizeBytes: number;
};

export type DirectAttachmentPartReceiptInput = AttachmentIdentityInput & AttachmentPartReceipt;

export type AttachmentUploadSession = {
  owner: AttachmentOwner;
  uid: string;
  objectKey: string;
  uploadId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  publicUrl?: string;
  metadata: Record<string, unknown>;
  parts: AttachmentPartReceipt[];
};

export type AttachmentMetadata = Omit<AttachmentUploadSession, 'uploadId' | 'parts'> & {
  uploadedAt?: string;
};

/**
 * Persistence is deliberately narrow: upload session state and completed
 * metadata live in D1, while this service never owns or deletes object bytes.
 */
export interface AttachmentStateStore {
  getUpload(uid: string): Promise<AttachmentUploadSession | undefined>;
  createUpload(value: AttachmentUploadSession): Promise<void>;
  reservePart(uid: string, uploadId: string, partNumber: number, reservationToken: string): Promise<boolean>;
  recordPart(
    uid: string,
    uploadId: string,
    reservationToken: string,
    receipt: AttachmentPartReceipt,
  ): Promise<void>;
  releasePart(uid: string, uploadId: string, partNumber: number, reservationToken: string): Promise<void>;
  completeUpload(uid: string, uploadId: string, value: AttachmentMetadata): Promise<void>;
  removeUpload(uid: string, uploadId: string): Promise<void>;
  getAttachment(uid: string): Promise<AttachmentMetadata | undefined>;
  removeAttachment(uid: string): Promise<boolean>;
}

export type AttachmentByteProvider = Pick<AttachmentObjectStore,
  'createAttachmentUpload' | 'createAttachmentPartUploadUrl' | 'uploadAttachmentPart' |
  'completeAttachmentUpload' | 'abortAttachmentUpload' | 'headAttachment'>;

export type InitializeAttachmentInput = {
  owner: AttachmentOwner;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  publicUrl?: string;
  metadata?: Record<string, unknown>;
};

export type UploadAttachmentPartInput = {
  owner: AttachmentOwner;
  uid: string;
  partNumber: number;
  body: ArrayBuffer;
};

export type AttachmentIdentityInput = {
  owner: AttachmentOwner;
  uid: string;
};

const encoder = new TextEncoder();
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const forbiddenClientKeyFields = ['key', 'objectKey', 'storageKey'] as const;

function boundaryError(message: string): Error {
  return new Error(`Attachment boundary: ${message}`);
}

function assertNoClientObjectKey(input: object): void {
  for (const field of forbiddenClientKeyFields) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw boundaryError('client object key substitution is not allowed');
    }
  }
}

function assertNoClientUid(input: object): void {
  if (Object.prototype.hasOwnProperty.call(input, 'uid')) {
    throw boundaryError('client attachment uid is not allowed');
  }
}

function assertSafeSegment(value: string, field: string): void {
  if (!safeSegment.test(value)) throw boundaryError(`${field} is invalid`);
}

function validateOwner(owner: AttachmentOwner): void {
  if (!['material', 'task_sop', 'requirement'].includes(owner.scope)) throw boundaryError('owner scope is invalid');
  assertSafeSegment(owner.uid, 'owner uid');
}

function ownersEqual(left: AttachmentOwner, right: AttachmentOwner): boolean {
  return left.scope === right.scope && left.uid === right.uid;
}

function requireOwner(actual: AttachmentOwner, expected: AttachmentOwner): void {
  if (!ownersEqual(actual, expected)) throw boundaryError('attachment owner does not match');
}

function validateFilename(filename: string): void {
  const size = encoder.encode(filename).byteLength;
  if (!filename || /[\u0000-\u001f\u007f]/.test(filename) || size > ATTACHMENT_FILENAME_MAX_BYTES) {
    throw boundaryError('filename must be non-empty and at most 255 UTF-8 bytes');
  }
}

function validateMediaType(mediaType: string): void {
  if (!mediaType || mediaType.length > 255 || /[\u0000-\u001f\u007f]/.test(mediaType)) {
    throw boundaryError('media type is invalid');
  }
}

function validateSize(sizeBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > ATTACHMENT_TOTAL_MAX_BYTES) {
    throw boundaryError('attachment size must be between 1 byte and 100 MiB');
  }
}

function validatePublicUrl(value?: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (value.trim() !== value) throw boundaryError('public URL must be an absolute credential-free HTTPS URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw boundaryError('public URL must be an absolute credential-free HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw boundaryError('public URL must be an absolute credential-free HTTPS URL');
  }
  return value;
}

function normalizeMetadata(value?: Record<string, unknown>): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw boundaryError('metadata must be a JSON object');
  try {
    const encoded = JSON.stringify(value);
    const decoded = JSON.parse(encoded) as unknown;
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new TypeError('not an object');
    return decoded as Record<string, unknown>;
  } catch {
    throw boundaryError('metadata must be a JSON object');
  }
}

function assertMetadataSize(value: AttachmentMetadata): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw boundaryError('metadata must be JSON serializable');
  }
  if (encoder.encode(encoded).byteLength > ATTACHMENT_METADATA_MAX_BYTES) {
    throw boundaryError('serialized attachment metadata must not exceed 16 KiB');
  }
}

export function attachmentObjectKey(owner: AttachmentOwner, uid: string): string {
  validateOwner(owner);
  assertSafeSegment(uid, 'attachment uid');
  return `attachments/${owner.scope}/${owner.uid}/${uid}`;
}

export function attachmentResourceName(uid: string): string {
  assertSafeSegment(uid, 'attachment uid');
  return `attachments/${uid}`;
}

function publicObjectUrl(baseUrl: string | undefined, objectKey: string): string | undefined {
  if (!baseUrl) return undefined;
  const validated = validatePublicUrl(baseUrl);
  if (!validated) return undefined;
  const base = new URL(validated);
  if (base.search || base.hash) throw boundaryError('public URL base cannot contain a query or fragment');
  base.pathname = `${base.pathname.replace(/\/+$/u, '')}/${objectKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
  return validatePublicUrl(base.toString());
}

function expectedPartCount(sizeBytes: number): number {
  return Math.ceil(sizeBytes / ATTACHMENT_PART_BYTES);
}

function expectedPartBytes(sizeBytes: number, partNumber: number): number {
  const count = expectedPartCount(sizeBytes);
  return partNumber < count
    ? ATTACHMENT_PART_BYTES
    : sizeBytes - ATTACHMENT_PART_BYTES * (count - 1);
}

async function requireUpload(
  state: AttachmentStateStore,
  input: AttachmentIdentityInput,
): Promise<AttachmentUploadSession> {
  validateOwner(input.owner);
  assertSafeSegment(input.uid, 'attachment uid');
  const upload = await state.getUpload(input.uid);
  if (!upload) {
    if (await state.getAttachment(input.uid)) throw boundaryError('attachment is already completed');
    throw boundaryError('attachment upload was not found');
  }
  requireOwner(upload.owner, input.owner);
  const expectedKey = attachmentObjectKey(input.owner, input.uid);
  if (upload.objectKey !== expectedKey) throw boundaryError('stored attachment object key is invalid');
  return upload;
}

async function completedAttachment(
  state: AttachmentStateStore,
  input: AttachmentIdentityInput,
): Promise<AttachmentMetadata | undefined> {
  validateOwner(input.owner);
  assertSafeSegment(input.uid, 'attachment uid');
  const attachment = await state.getAttachment(input.uid);
  if (!attachment) return undefined;
  requireOwner(attachment.owner, input.owner);
  if (attachment.objectKey !== attachmentObjectKey(input.owner, input.uid)) {
    throw boundaryError('stored attachment object key is invalid');
  }
  return attachment;
}

function partReceiptsMatch(left: AttachmentPartReceipt, right: AttachmentPartReceipt): boolean {
  return left.partNumber === right.partNumber && left.etag === right.etag && left.sizeBytes === right.sizeBytes;
}

function validateDirectPartReceipt(receipt: AttachmentPartReceipt, expectedBytes: number): void {
  if (!Number.isInteger(receipt.partNumber) || receipt.partNumber < 1 || receipt.partNumber > ATTACHMENT_MAX_PARTS) {
    throw boundaryError('attachment part number is invalid');
  }
  if (receipt.sizeBytes !== expectedBytes) throw boundaryError(`part ${receipt.partNumber} size is invalid`);
  if (!receipt.etag || receipt.etag.length > 1024 || /[\u0000-\u001f\u007f]/.test(receipt.etag)) {
    throw boundaryError(`part ${receipt.partNumber} ETag is invalid`);
  }
}

async function releasePartReservation(
  state: AttachmentStateStore,
  upload: AttachmentUploadSession,
  reservationToken: string,
  partNumber: number,
  cause: unknown,
): Promise<never> {
  try {
    await state.releasePart(upload.uid, upload.uploadId, partNumber, reservationToken);
  } catch (releaseError) {
    throw new AggregateError([cause, releaseError], 'Attachment part persistence and reservation release both failed');
  }
  throw cause;
}

async function persistPartReceipt(
  state: AttachmentStateStore,
  upload: AttachmentUploadSession,
  reservationToken: string,
  receipt: AttachmentPartReceipt,
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await state.recordPart(upload.uid, upload.uploadId, reservationToken, receipt);
      return;
    } catch (error) {
      failure = error;
      let current: AttachmentUploadSession | undefined;
      try {
        current = await state.getUpload(upload.uid);
      } catch {
        // A bounded second write attempt can recover a transient D1 failure
        // while this request still owns the durable reservation.
      }
      if (current?.uploadId === upload.uploadId) {
        const committed = current.parts.find((part) => part.partNumber === receipt.partNumber);
        if (committed) {
          if (partReceiptsMatch(committed, receipt)) return;
          return releasePartReservation(
            state,
            upload,
            reservationToken,
            receipt.partNumber,
            boundaryError(`stored receipt for part ${receipt.partNumber} does not match the provider result`),
          );
        }
      }
    }
  }
  return releasePartReservation(state, upload, reservationToken, receipt.partNumber, failure);
}

export function createAttachmentService(options: {
  provider: AttachmentByteProvider;
  state: AttachmentStateStore;
  createUid?: () => string;
  publicBaseUrl?: string;
}) {
  const createUid = options.createUid ?? (() => crypto.randomUUID());

  return {
    async initialize(input: InitializeAttachmentInput) {
      assertNoClientObjectKey(input);
      assertNoClientUid(input);
      validateOwner(input.owner);
      validateFilename(input.filename);
      validateMediaType(input.mediaType);
      validateSize(input.sizeBytes);
      const requestedPublicUrl = validatePublicUrl(input.publicUrl);
      const metadata = normalizeMetadata(input.metadata);
      const uid = createUid();
      assertSafeSegment(uid, 'server-generated attachment uid');
      const objectKey = attachmentObjectKey(input.owner, uid);
      const publicUrl = requestedPublicUrl ?? publicObjectUrl(options.publicBaseUrl, objectKey);
      if (await options.state.getUpload(uid) || await options.state.getAttachment(uid)) {
        throw boundaryError('server-generated attachment uid already exists');
      }
      const completed: AttachmentMetadata = {
        owner: { ...input.owner },
        uid,
        objectKey,
        filename: input.filename,
        mediaType: input.mediaType,
        sizeBytes: input.sizeBytes,
        publicUrl,
        metadata,
      };
      assertMetadataSize(completed);
      if (await options.provider.headAttachment(objectKey)) {
        throw boundaryError('derived attachment object key already exists; overwrite is forbidden');
      }

      const providerSession = await options.provider.createAttachmentUpload({
        storageKey: objectKey,
        contentType: input.mediaType,
      });
      if (providerSession.storageKey !== objectKey) {
        throw boundaryError('provider returned a different attachment object key');
      }
      const session: AttachmentUploadSession = {
        ...completed,
        uploadId: providerSession.uploadId,
        parts: [],
      };
      await options.state.createUpload(session);
      return {
        uid,
        uploadId: session.uploadId,
        objectKey,
        partSizeBytes: ATTACHMENT_PART_BYTES,
        partCount: expectedPartCount(input.sizeBytes),
        maxSizeBytes: ATTACHMENT_TOTAL_MAX_BYTES,
        uploadMode: options.provider.createAttachmentPartUploadUrl ? 'direct' : 'proxy',
        publicUrl,
      };
    },

    async createPartUploadUrl(input: AttachmentIdentityInput & { partNumber: number }) {
      assertNoClientObjectKey(input);
      const upload = await requireUpload(options.state, input);
      const partCount = expectedPartCount(upload.sizeBytes);
      if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > partCount) {
        throw boundaryError(`part number must be between 1 and ${partCount}`);
      }
      if (upload.parts.some((part) => part.partNumber === input.partNumber)) {
        throw boundaryError(`part ${input.partNumber} was already uploaded`);
      }
      if (!options.provider.createAttachmentPartUploadUrl) {
        throw boundaryError('direct attachment upload is not available');
      }
      return options.provider.createAttachmentPartUploadUrl({
        storageKey: upload.objectKey,
        uploadId: upload.uploadId,
        partNumber: input.partNumber,
        expiresInSeconds: ATTACHMENT_UPLOAD_URL_TTL_SECONDS,
      });
    },

    async recordDirectPart(input: DirectAttachmentPartReceiptInput): Promise<AttachmentPartReceipt> {
      assertNoClientObjectKey(input);
      const upload = await requireUpload(options.state, input);
      const partCount = expectedPartCount(upload.sizeBytes);
      if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > partCount) {
        throw boundaryError(`part number must be between 1 and ${partCount}`);
      }
      const expectedBytes = expectedPartBytes(upload.sizeBytes, input.partNumber);
      const receipt = { partNumber: input.partNumber, etag: input.etag, sizeBytes: input.sizeBytes };
      validateDirectPartReceipt(receipt, expectedBytes);
      const existing = upload.parts.find((part) => part.partNumber === input.partNumber);
      if (existing) {
        if (partReceiptsMatch(existing, receipt)) return existing;
        throw boundaryError(`stored receipt for part ${input.partNumber} does not match the direct upload`);
      }
      const reservationToken = crypto.randomUUID();
      if (!await options.state.reservePart(upload.uid, upload.uploadId, input.partNumber, reservationToken)) {
        const current = await options.state.getUpload(upload.uid);
        const raced = current?.parts.find((part) => part.partNumber === input.partNumber);
        if (raced && partReceiptsMatch(raced, receipt)) return raced;
        throw boundaryError(`part ${input.partNumber} is already being recorded`);
      }
      await persistPartReceipt(options.state, upload, reservationToken, receipt);
      return receipt;
    },

    async uploadPart(input: UploadAttachmentPartInput): Promise<AttachmentPartReceipt> {
      assertNoClientObjectKey(input);
      const upload = await requireUpload(options.state, input);
      const partCount = expectedPartCount(upload.sizeBytes);
      if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > partCount || input.partNumber > ATTACHMENT_MAX_PARTS) {
        throw boundaryError(`part number must be between 1 and ${partCount}`);
      }
      if (!(input.body instanceof ArrayBuffer)) throw boundaryError('part body must be an ArrayBuffer');
      const expectedBytes = expectedPartBytes(upload.sizeBytes, input.partNumber);
      if (input.body.byteLength !== expectedBytes) {
        const expectation = input.partNumber < partCount ? 'exactly 10 MiB' : `exactly ${expectedBytes} bytes`;
        throw boundaryError(`part ${input.partNumber} must be ${expectation}`);
      }
      if (upload.parts.some((part) => part.partNumber === input.partNumber)) {
        throw boundaryError(`part ${input.partNumber} was already uploaded; overwrite is forbidden`);
      }

      // Claim the part in durable state before touching R2. This prevents two
      // Pages isolates from both overwriting the same multipart part while
      // only one receipt wins the D1 compare-and-set.
      const reservationToken = crypto.randomUUID();
      if (!await options.state.reservePart(upload.uid, upload.uploadId, input.partNumber, reservationToken)) {
        throw boundaryError(`part ${input.partNumber} is already uploaded or in progress`);
      }
      let result;
      try {
        result = await options.provider.uploadAttachmentPart({
          storageKey: upload.objectKey,
          uploadId: upload.uploadId,
          partNumber: input.partNumber,
          body: input.body,
        });
      } catch (error) {
        await options.state.releasePart(upload.uid, upload.uploadId, input.partNumber, reservationToken);
        throw error;
      }
      if (!result.etag) {
        return releasePartReservation(
          options.state,
          upload,
          reservationToken,
          input.partNumber,
          boundaryError('provider returned an empty part ETag'),
        );
      }
      const receipt = { partNumber: input.partNumber, etag: result.etag, sizeBytes: input.body.byteLength };
      await persistPartReceipt(options.state, upload, reservationToken, receipt);
      return receipt;
    },

    async complete(input: AttachmentIdentityInput): Promise<AttachmentMetadata> {
      assertNoClientObjectKey(input);
      const existing = await completedAttachment(options.state, input);
      if (existing) return existing;
      const upload = await requireUpload(options.state, input);
      const count = expectedPartCount(upload.sizeBytes);
      if (upload.parts.length !== count || upload.parts.some((part, index) =>
        part.partNumber !== index + 1 || part.sizeBytes !== expectedPartBytes(upload.sizeBytes, part.partNumber))) {
        throw boundaryError('all expected attachment parts must be uploaded before completion');
      }
      await options.provider.completeAttachmentUpload({
        storageKey: upload.objectKey,
        uploadId: upload.uploadId,
        parts: upload.parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
        expectedSizeBytes: upload.sizeBytes,
      });
      const { uploadId: _uploadId, parts: _parts, ...metadata } = upload;
      try {
        await options.state.completeUpload(upload.uid, upload.uploadId, metadata);
      } catch (error) {
        // The D1 write may have committed even when the response was lost, or a
        // concurrent completion may have won. Return that durable result when
        // present; otherwise preserve the upload receipts for a later retry.
        const completed = await completedAttachment(options.state, input);
        if (completed) return completed;
        throw error;
      }
      return await completedAttachment(options.state, input) ?? metadata;
    },

    async abort(input: AttachmentIdentityInput): Promise<void> {
      assertNoClientObjectKey(input);
      const upload = await requireUpload(options.state, input);
      if (await options.provider.headAttachment(upload.objectKey)) {
        throw boundaryError('attachment bytes are already completed; retry completion instead of aborting');
      }
      await options.provider.abortAttachmentUpload({ storageKey: upload.objectKey, uploadId: upload.uploadId });
      await options.state.removeUpload(upload.uid, upload.uploadId);
    },

    async unlink(input: AttachmentIdentityInput): Promise<boolean> {
      assertNoClientObjectKey(input);
      validateOwner(input.owner);
      assertSafeSegment(input.uid, 'attachment uid');
      const attachment = await options.state.getAttachment(input.uid);
      if (!attachment) return false;
      requireOwner(attachment.owner, input.owner);
      return options.state.removeAttachment(input.uid);
    },

    async getMetadata(input: AttachmentIdentityInput): Promise<AttachmentMetadata | undefined> {
      validateOwner(input.owner);
      assertSafeSegment(input.uid, 'attachment uid');
      const attachment = await options.state.getAttachment(input.uid);
      if (attachment) requireOwner(attachment.owner, input.owner);
      return attachment;
    },
  };
}
