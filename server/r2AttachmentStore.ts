import type {
  AttachmentAbortInput,
  AttachmentCompleteInput,
  AttachmentObject,
  AttachmentObjectStore,
  AttachmentPartInput,
  AttachmentPartOutput,
  AttachmentUploadInput,
  AttachmentUploadSession,
} from './domain/attachmentObjectStore';
import {
  assertExpectedObjectSize,
  normalizeAttachmentComplete,
  validateAttachmentPart,
  validateAttachmentUpload,
  validateStorageKey,
  validateUploadSession,
} from './domain/attachmentObjectStore';

type R2MultipartUploadLike = {
  uploadId: string;
  key: string;
  uploadPart(partNumber: number, value: ArrayBuffer): Promise<{ etag: string }>;
  complete(parts: Array<{ partNumber: number; etag: string }>): Promise<unknown>;
  abort(): Promise<void>;
};

type R2ObjectMetadataLike = {
  size?: number;
  etag?: string;
  checksums?: { sha256?: string | ArrayBuffer };
  httpMetadata?: {
    contentType?: string;
  };
};

export type R2AttachmentObject = R2ObjectMetadataLike & { body: ReadableStream<Uint8Array> };

export type R2BucketLike = {
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<R2MultipartUploadLike>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadLike;
  get(key: string): Promise<R2AttachmentObject | null>;
  head(key: string): Promise<R2ObjectMetadataLike | null>;
  delete(key: string): Promise<void>;
};

export type AttachmentStore = Partial<AttachmentObjectStore>;

function checksumHex(value?: string | ArrayBuffer): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function metadata(storageKey: string, object: R2ObjectMetadataLike) {
  if (!Number.isSafeInteger(object.size) || (object.size ?? -1) < 0) {
    throw new Error('R2 object metadata is missing actual size');
  }
  return {
    storageKey,
    sizeBytes: object.size as number,
    contentType: object.httpMetadata?.contentType,
    etag: object.etag,
    sha256: checksumHex(object.checksums?.sha256),
  };
}

function isMissingUpload(error: unknown): boolean {
  return /NoSuchUpload|not found|does not exist/i.test(error instanceof Error ? `${error.name} ${error.message}` : String(error));
}

function requireBucket(bucket?: R2BucketLike): R2BucketLike {
  if (!bucket) {
    throw new Error('附件存储未配置 R2 binding: ATTACHMENTS');
  }
  return bucket;
}

export function createR2AttachmentStore(bucket?: R2BucketLike): AttachmentObjectStore {
  async function headAttachment(storageKey: string) {
    validateStorageKey(storageKey);
    const object = await requireBucket(bucket).head(storageKey);
    return object ? metadata(storageKey, object) : null;
  }

  return {
    async createAttachmentUpload(input: AttachmentUploadInput): Promise<AttachmentUploadSession> {
      validateAttachmentUpload(input);
      const upload = await requireBucket(bucket).createMultipartUpload(input.storageKey, {
        httpMetadata: { contentType: input.contentType },
      });
      return { uploadId: upload.uploadId, storageKey: upload.key };
    },
    async uploadAttachmentPart(input: AttachmentPartInput): Promise<AttachmentPartOutput> {
      validateAttachmentPart(input);
      const upload = requireBucket(bucket).resumeMultipartUpload(input.storageKey, input.uploadId);
      const result = await upload.uploadPart(input.partNumber, input.body);
      return { etag: result.etag };
    },
    async completeAttachmentUpload(input: AttachmentCompleteInput): Promise<void> {
      const parts = normalizeAttachmentComplete(input);
      const existing = await headAttachment(input.storageKey);
      if (existing) {
        assertExpectedObjectSize(existing, input.expectedSizeBytes);
        return;
      }
      const upload = requireBucket(bucket).resumeMultipartUpload(input.storageKey, input.uploadId);
      await upload.complete(parts);
      assertExpectedObjectSize(await headAttachment(input.storageKey), input.expectedSizeBytes);
    },
    async abortAttachmentUpload(input: AttachmentAbortInput): Promise<void> {
      validateUploadSession(input);
      const upload = requireBucket(bucket).resumeMultipartUpload(input.storageKey, input.uploadId);
      try {
        await upload.abort();
      } catch (error) {
        if (!isMissingUpload(error)) throw error;
      }
    },
    async deleteAttachment(storageKey: string): Promise<void> {
      validateStorageKey(storageKey);
      await requireBucket(bucket).delete(storageKey);
    },
    async getAttachment(storageKey: string): Promise<AttachmentObject | null> {
      validateStorageKey(storageKey);
      const object = await requireBucket(bucket).get(storageKey);
      if (!object) return null;
      const result: AttachmentObject = {
        body: object.body,
        metadata: metadata(storageKey, object),
        httpMetadata: object.httpMetadata,
      };
      return result;
    },
    headAttachment,
    async attachmentExists(storageKey: string) {
      return (await headAttachment(storageKey)) !== null;
    },
  };
}
