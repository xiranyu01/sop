export const MAX_ATTACHMENT_PART_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENT_PARTS = 10_000;

export type AttachmentUploadInput = { storageKey: string; contentType: string };
export type AttachmentUploadSession = { uploadId: string; storageKey: string };
export type AttachmentPartInput = {
  storageKey: string;
  uploadId: string;
  partNumber: number;
  body: ArrayBuffer;
};

export type AttachmentPartUploadUrlInput = Omit<AttachmentPartInput, 'body'> & {
  expiresInSeconds: number;
};

export type AttachmentPartUploadUrlOutput = {
  uploadUrl: string;
  expiresAt: string;
};
export type AttachmentPartOutput = { etag: string };
export type AttachmentCompleteInput = {
  storageKey: string;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
  expectedSizeBytes?: number;
};
export type AttachmentAbortInput = { storageKey: string; uploadId: string };

export type AttachmentObjectMetadata = {
  storageKey: string;
  sizeBytes: number;
  contentType?: string;
  etag?: string;
  sha256?: string;
};

export type AttachmentObject = {
  body: ReadableStream<Uint8Array>;
  metadata: AttachmentObjectMetadata;
  /** Compatibility with the Cloudflare R2 response shape. */
  httpMetadata?: { contentType?: string };
};

function requiredText(value: string, field: string): void {
  if (!value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${field} is invalid`);
}

export function validateStorageKey(storageKey: string): void {
  requiredText(storageKey, 'storageKey');
  if (storageKey.startsWith('/') || storageKey.split('/').some((segment) => segment === '..')) {
    throw new Error('storageKey is invalid');
  }
}

export function validateUploadSession(input: AttachmentUploadSession): void {
  validateStorageKey(input.storageKey);
  requiredText(input.uploadId, 'uploadId');
}

export function validateAttachmentUpload(input: AttachmentUploadInput): void {
  validateStorageKey(input.storageKey);
  requiredText(input.contentType, 'contentType');
}

export function validateAttachmentPart(input: AttachmentPartInput): void {
  validateUploadSession(input);
  if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > MAX_ATTACHMENT_PARTS) {
    throw new Error(`part number must be between 1 and ${MAX_ATTACHMENT_PARTS}`);
  }
  if (input.body.byteLength < 1 || input.body.byteLength > MAX_ATTACHMENT_PART_BYTES) {
    throw new Error(`part size must be between 1 and ${MAX_ATTACHMENT_PART_BYTES} bytes`);
  }
}

function validateEtag(etag: string): void {
  requiredText(etag, 'etag');
}

export function normalizeAttachmentComplete(input: AttachmentCompleteInput): AttachmentCompleteInput['parts'] {
  validateUploadSession(input);
  if (
    input.expectedSizeBytes !== undefined &&
    (!Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 1)
  ) {
    throw new Error('expected object size is invalid');
  }
  if (input.parts.length < 1 || input.parts.length > MAX_ATTACHMENT_PARTS) throw new Error('multipart parts are required');
  const sorted = input.parts.slice().sort((left, right) => left.partNumber - right.partNumber);
  sorted.forEach((part, index) => {
    if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > MAX_ATTACHMENT_PARTS) {
      throw new Error('part number is invalid');
    }
    validateEtag(part.etag);
    if (index > 0 && part.partNumber === sorted[index - 1]?.partNumber) throw new Error('duplicate multipart part number');
    if (part.partNumber !== index + 1) throw new Error('multipart part numbers must be contiguous from 1');
  });
  return sorted;
}

export function assertExpectedObjectSize(metadata: AttachmentObjectMetadata | null, expectedSizeBytes?: number): void {
  if (!metadata) throw new Error('completed attachment object is missing');
  if (expectedSizeBytes !== undefined && metadata.sizeBytes !== expectedSizeBytes) {
    throw new Error(`completed attachment size ${metadata.sizeBytes} does not match expected size ${expectedSizeBytes}`);
  }
}

/** Owns object bytes only. Domain metadata and references belong in AppStore. */
export interface AttachmentObjectStore {
  createAttachmentUpload(input: AttachmentUploadInput): Promise<AttachmentUploadSession>;
  createAttachmentPartUploadUrl?(input: AttachmentPartUploadUrlInput): Promise<AttachmentPartUploadUrlOutput>;
  uploadAttachmentPart(input: AttachmentPartInput): Promise<AttachmentPartOutput>;
  completeAttachmentUpload(input: AttachmentCompleteInput): Promise<void>;
  abortAttachmentUpload(input: AttachmentAbortInput): Promise<void>;
  deleteAttachment(storageKey: string): Promise<void>;
  getAttachment(storageKey: string): Promise<AttachmentObject | null>;
  headAttachment(storageKey: string): Promise<AttachmentObjectMetadata | null>;
  attachmentExists(storageKey: string): Promise<boolean>;
}
