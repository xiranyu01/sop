import type { AttachmentObjectStore } from '../attachmentObjectStore';

export const ATTACHMENT_PART_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_PARTS = 10;
export const ATTACHMENT_TOTAL_MAX_BYTES = ATTACHMENT_PART_BYTES * ATTACHMENT_MAX_PARTS;
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

export type AttachmentMetadata = Omit<AttachmentUploadSession, 'uploadId' | 'parts'>;

/**
 * Persistence is deliberately narrow: upload session state and completed
 * metadata live in D1, while this service never owns or deletes object bytes.
 */
export interface AttachmentStateStore {
  getUpload(uid: string): Promise<AttachmentUploadSession | undefined>;
  createUpload(value: AttachmentUploadSession): Promise<void>;
  replaceUpload(value: AttachmentUploadSession): Promise<void>;
  completeUpload(uid: string, uploadId: string, value: AttachmentMetadata): Promise<void>;
  removeUpload(uid: string, uploadId: string): Promise<void>;
  getAttachment(uid: string): Promise<AttachmentMetadata | undefined>;
  removeAttachment(uid: string): Promise<boolean>;
}

export type AttachmentByteProvider = Pick<AttachmentObjectStore,
  'createAttachmentUpload' | 'uploadAttachmentPart' | 'completeAttachmentUpload' | 'abortAttachmentUpload' | 'headAttachment'>;

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

export function createAttachmentService(options: {
  provider: AttachmentByteProvider;
  state: AttachmentStateStore;
  createUid?: () => string;
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
      const publicUrl = validatePublicUrl(input.publicUrl);
      const metadata = normalizeMetadata(input.metadata);
      const uid = createUid();
      assertSafeSegment(uid, 'server-generated attachment uid');
      const objectKey = attachmentObjectKey(input.owner, uid);
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
        publicUrl,
      };
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

      const result = await options.provider.uploadAttachmentPart({
        storageKey: upload.objectKey,
        uploadId: upload.uploadId,
        partNumber: input.partNumber,
        body: input.body,
      });
      if (!result.etag) throw boundaryError('provider returned an empty part ETag');
      const receipt = { partNumber: input.partNumber, etag: result.etag, sizeBytes: input.body.byteLength };
      await options.state.replaceUpload({
        ...upload,
        parts: [...upload.parts, receipt].sort((left, right) => left.partNumber - right.partNumber),
      });
      return receipt;
    },

    async complete(input: AttachmentIdentityInput): Promise<AttachmentMetadata> {
      assertNoClientObjectKey(input);
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
      await options.state.completeUpload(upload.uid, upload.uploadId, metadata);
      return metadata;
    },

    async abort(input: AttachmentIdentityInput): Promise<void> {
      assertNoClientObjectKey(input);
      const upload = await requireUpload(options.state, input);
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
