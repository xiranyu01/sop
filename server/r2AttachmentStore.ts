import type { AttachmentAbortInput, AttachmentCompleteInput, AttachmentPartInput, AttachmentPartOutput, AttachmentUploadInput, AttachmentUploadSession, AppStore } from './api';

type R2MultipartUploadLike = {
  uploadId: string;
  key: string;
  uploadPart(partNumber: number, value: ArrayBuffer): Promise<{ etag: string }>;
  complete(parts: Array<{ partNumber: number; etag: string }>): Promise<unknown>;
  abort(): Promise<void>;
};

export type R2ObjectLike = {
  body: ReadableStream;
  httpMetadata?: {
    contentType?: string;
  };
};

export type R2BucketLike = {
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<R2MultipartUploadLike>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadLike;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
};

export type AttachmentStore = Partial<
  Pick<
    AppStore,
    'createAttachmentUpload' | 'uploadAttachmentPart' | 'completeAttachmentUpload' | 'abortAttachmentUpload' | 'deleteAttachment'
  >
>;

function requireBucket(bucket?: R2BucketLike): R2BucketLike {
  if (!bucket) {
    throw new Error('附件存储未配置 R2 binding: ATTACHMENTS');
  }
  return bucket;
}

export function createR2AttachmentStore(bucket?: R2BucketLike): AttachmentStore {
  return {
    async createAttachmentUpload(input: AttachmentUploadInput): Promise<AttachmentUploadSession> {
      const upload = await requireBucket(bucket).createMultipartUpload(input.storageKey, {
        httpMetadata: { contentType: input.contentType },
      });
      return { uploadId: upload.uploadId, storageKey: upload.key };
    },
    async uploadAttachmentPart(input: AttachmentPartInput): Promise<AttachmentPartOutput> {
      const upload = requireBucket(bucket).resumeMultipartUpload(input.storageKey, input.uploadId);
      const result = await upload.uploadPart(input.partNumber, input.body);
      return { etag: result.etag };
    },
    async completeAttachmentUpload(input: AttachmentCompleteInput): Promise<void> {
      const upload = requireBucket(bucket).resumeMultipartUpload(input.storageKey, input.uploadId);
      await upload.complete(input.parts);
    },
    async abortAttachmentUpload(input: AttachmentAbortInput): Promise<void> {
      const upload = requireBucket(bucket).resumeMultipartUpload(input.storageKey, input.uploadId);
      await upload.abort();
    },
    async deleteAttachment(storageKey: string): Promise<void> {
      await requireBucket(bucket).delete(storageKey);
    },
  };
}
