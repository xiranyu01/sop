export type AttachmentUploadInput = { storageKey: string; contentType: string };
export type AttachmentUploadSession = { uploadId: string; storageKey: string };
export type AttachmentPartInput = {
  storageKey: string;
  uploadId: string;
  partNumber: number;
  body: ArrayBuffer;
};
export type AttachmentPartOutput = { etag: string };
export type AttachmentCompleteInput = {
  storageKey: string;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
};
export type AttachmentAbortInput = { storageKey: string; uploadId: string };

/** Owns object bytes only. Domain metadata and references belong in AppStore. */
export interface AttachmentObjectStore {
  createAttachmentUpload(input: AttachmentUploadInput): Promise<AttachmentUploadSession>;
  uploadAttachmentPart(input: AttachmentPartInput): Promise<AttachmentPartOutput>;
  completeAttachmentUpload(input: AttachmentCompleteInput): Promise<void>;
  abortAttachmentUpload(input: AttachmentAbortInput): Promise<void>;
  deleteAttachment(storageKey: string): Promise<void>;
}

