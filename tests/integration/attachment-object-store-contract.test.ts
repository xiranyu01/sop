import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AttachmentObjectStore } from '../../server/domain/attachmentObjectStore';
import { createR2AttachmentStore, type R2BucketLike } from '../../server/r2AttachmentStore';
import { createS3AttachmentStore, type S3AttachmentConfig } from '../../server/s3AttachmentStore';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value: string): ArrayBuffer {
  return encoder.encode(value).buffer;
}

async function streamText(stream: ReadableStream): Promise<string> {
  return decoder.decode(await new Response(stream).arrayBuffer());
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

type Stored = { body: Uint8Array; contentType: string; etag: string; sha256: string };
type Upload = { key: string; contentType: string; parts: Map<number, { body: Uint8Array; etag: string }> };

function createFakeR2Bucket(): R2BucketLike {
  const uploads = new Map<string, Upload>();
  const objects = new Map<string, Stored>();

  function resume(key: string, uploadId: string) {
    return {
      uploadId,
      key,
      async uploadPart(partNumber: number, value: ArrayBuffer) {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error('NoSuchUpload');
        const body = new Uint8Array(value.slice(0));
        const etag = `etag-${partNumber}-${body.byteLength}`;
        upload.parts.set(partNumber, { body, etag });
        return { etag };
      },
      async complete(parts: Array<{ partNumber: number; etag: string }>) {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error('NoSuchUpload');
        const chunks = parts.map((part) => {
          const saved = upload.parts.get(part.partNumber);
          if (!saved || saved.etag !== part.etag) throw new Error('InvalidPart');
          return saved.body;
        });
        const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        objects.set(key, { body, contentType: upload.contentType, etag: `object-${uploadId}`, sha256: digest(body) });
        uploads.delete(uploadId);
      },
      async abort() {
        if (!uploads.delete(uploadId)) throw new Error('NoSuchUpload');
      },
    };
  }

  return {
    async createMultipartUpload(key, options) {
      const uploadId = randomUUID();
      uploads.set(uploadId, { key, contentType: options?.httpMetadata?.contentType || 'application/octet-stream', parts: new Map() });
      return resume(key, uploadId);
    },
    resumeMultipartUpload: resume,
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: new Blob([object.body.slice().buffer as ArrayBuffer]).stream(),
        size: object.body.byteLength,
        etag: object.etag,
        checksums: { sha256: object.sha256 },
        httpMetadata: { contentType: object.contentType },
      };
    },
    async head(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        size: object.body.byteLength,
        etag: object.etag,
        checksums: { sha256: object.sha256 },
        httpMetadata: { contentType: object.contentType },
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function createFakeS3Config(): S3AttachmentConfig {
  const uploads = new Map<string, Upload>();
  const objects = new Map<string, Stored>();
  const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    const uploadId = url.searchParams.get('uploadId');
    const partNumber = Number(url.searchParams.get('partNumber'));

    if (method === 'POST' && url.searchParams.has('uploads')) {
      const id = randomUUID();
      uploads.set(id, { key, contentType: new Headers(init?.headers).get('content-type') || 'application/octet-stream', parts: new Map() });
      return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (method === 'PUT' && uploadId && partNumber) {
      const upload = uploads.get(uploadId);
      if (!upload) return new Response('NoSuchUpload', { status: 404 });
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      const etag = `etag-${partNumber}-${body.byteLength}`;
      upload.parts.set(partNumber, { body, etag });
      return new Response(null, { headers: { etag } });
    }
    if (method === 'POST' && uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload) return new Response('NoSuchUpload', { status: 404 });
      const xml = await new Response(init?.body).text();
      const parts = [...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/g)].map((match) => ({
        partNumber: Number(match[1]),
        etag: match[2],
      }));
      if (parts.some((part) => upload.parts.get(part.partNumber)?.etag !== part.etag)) {
        return new Response('InvalidPart', { status: 400 });
      }
      const chunks = parts.map((part) => upload.parts.get(part.partNumber)?.body || new Uint8Array());
      const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      objects.set(key, { body, contentType: upload.contentType, etag: `object-${uploadId}`, sha256: digest(body) });
      uploads.delete(uploadId);
      return new Response('<CompleteMultipartUploadResult/>');
    }
    if (method === 'DELETE' && uploadId) {
      return uploads.delete(uploadId) ? new Response(null, { status: 204 }) : new Response('NoSuchUpload', { status: 404 });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    const headers = {
      'content-type': object.contentType,
      'content-length': String(object.body.byteLength),
      etag: object.etag,
      'x-amz-meta-sha256': object.sha256,
    };
    return method === 'HEAD' ? new Response(null, { headers }) : new Response(object.body.slice().buffer, { headers });
  };

  return {
    endpoint: 'https://s3.example.test',
    bucket: 'attachments',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    request,
  };
}

type Factory = () => Promise<AttachmentObjectStore> | AttachmentObjectStore;

function attachmentObjectStoreContract(name: string, factory: Factory): void {
  describe(name, () => {
    it('validates multipart input and provides idempotent object lifecycle with metadata', async () => {
      const store = await factory();
      const storageKey = 'requirements/req-1/reference.txt';
      const upload = await store.createAttachmentUpload({ storageKey, contentType: 'text/plain' });

      await expect(store.uploadAttachmentPart({ ...upload, partNumber: 0, body: bytes('bad') })).rejects.toThrow(/part|分片/i);
      await expect(store.uploadAttachmentPart({ ...upload, partNumber: 1, body: new ArrayBuffer(0) })).rejects.toThrow(/size|大小|empty/i);

      const first = await store.uploadAttachmentPart({ ...upload, partNumber: 1, body: bytes('hello ') });
      const second = await store.uploadAttachmentPart({ ...upload, partNumber: 2, body: bytes('world') });
      await expect(store.completeAttachmentUpload({ ...upload, parts: [{ partNumber: 2, etag: second.etag }] })).rejects.toThrow(/contiguous|连续|part/i);
      await expect(store.completeAttachmentUpload({ ...upload, parts: [
        { partNumber: 1, etag: first.etag },
        { partNumber: 1, etag: first.etag },
      ] })).rejects.toThrow(/duplicate|重复|part/i);
      await expect(store.completeAttachmentUpload({ ...upload, parts: [
        { partNumber: 1, etag: 'wrong-etag' },
        { partNumber: 2, etag: second.etag },
      ] })).rejects.toThrow(/etag|part|分片/i);

      await expect(store.completeAttachmentUpload({
        ...upload,
        expectedSizeBytes: 12,
        parts: [{ partNumber: 1, etag: first.etag }, { partNumber: 2, etag: second.etag }],
      })).rejects.toThrow(/size|大小/i);

      const complete = {
        ...upload,
        expectedSizeBytes: 11,
        parts: [{ partNumber: 2, etag: second.etag }, { partNumber: 1, etag: first.etag }],
      };
      await store.completeAttachmentUpload(complete);
      await store.completeAttachmentUpload(complete);

      expect(await store.attachmentExists(storageKey)).toBe(true);
      expect(await store.headAttachment(storageKey)).toMatchObject({ storageKey, sizeBytes: 11, contentType: 'text/plain' });
      const object = await store.getAttachment(storageKey);
      expect(object?.metadata).toMatchObject({ storageKey, sizeBytes: 11, contentType: 'text/plain' });
      expect(object?.metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(object && await streamText(object.body)).toBe('hello world');

      await store.abortAttachmentUpload(upload);
      await store.abortAttachmentUpload(upload);
      expect(await store.attachmentExists(storageKey)).toBe(true);
      await store.deleteAttachment(storageKey);
      await store.deleteAttachment(storageKey);
      expect(await store.attachmentExists(storageKey)).toBe(false);
      expect(await store.getAttachment(storageKey)).toBeNull();
    });
  });
}

attachmentObjectStoreContract('R2 attachment object store', () => createR2AttachmentStore(createFakeR2Bucket()));
attachmentObjectStoreContract('S3 attachment object store', () => createS3AttachmentStore(createFakeS3Config()));
