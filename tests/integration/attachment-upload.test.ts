import { describe, expect, it } from 'vitest';
import type {
  AttachmentCompleteInput,
  AttachmentObjectMetadata,
  AttachmentObjectStore,
  AttachmentPartInput,
  AttachmentUploadInput,
} from '../../server/domain/attachmentObjectStore';
import {
  ATTACHMENT_METADATA_MAX_BYTES,
  ATTACHMENT_PART_BYTES,
  ATTACHMENT_TOTAL_MAX_BYTES,
  createAttachmentService,
  type AttachmentMetadata,
  type AttachmentStateStore,
  type AttachmentUploadSession,
} from '../../server/domain/services/attachment';

const owner = { scope: 'requirement' as const, uid: 'owner-a' };
const otherOwner = { scope: 'requirement' as const, uid: 'owner-b' };

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryAttachmentState implements AttachmentStateStore {
  readonly uploads = new Map<string, AttachmentUploadSession>();
  readonly attachments = new Map<string, AttachmentMetadata>();

  async getUpload(uid: string) {
    const value = this.uploads.get(uid);
    return value && clone(value);
  }

  async createUpload(value: AttachmentUploadSession) {
    if (this.uploads.has(value.uid) || this.attachments.has(value.uid)) throw new Error('attachment uid already exists');
    this.uploads.set(value.uid, clone(value));
  }

  async replaceUpload(value: AttachmentUploadSession) {
    const current = this.uploads.get(value.uid);
    if (!current || current.uploadId !== value.uploadId) throw new Error('attachment upload changed');
    this.uploads.set(value.uid, clone(value));
  }

  async completeUpload(uid: string, uploadId: string, value: AttachmentMetadata) {
    const current = this.uploads.get(uid);
    if (!current || current.uploadId !== uploadId || this.attachments.has(uid)) throw new Error('attachment upload changed');
    this.uploads.delete(uid);
    this.attachments.set(uid, clone(value));
  }

  async removeUpload(uid: string, uploadId: string) {
    const current = this.uploads.get(uid);
    if (!current || current.uploadId !== uploadId) throw new Error('attachment upload changed');
    this.uploads.delete(uid);
  }

  async getAttachment(uid: string) {
    const value = this.attachments.get(uid);
    return value && clone(value);
  }

  async removeAttachment(uid: string) {
    return this.attachments.delete(uid);
  }
}

class FakeAttachmentProvider implements Pick<AttachmentObjectStore,
  'createAttachmentUpload' | 'uploadAttachmentPart' | 'completeAttachmentUpload' | 'abortAttachmentUpload' | 'headAttachment'> {
  readonly uploads = new Map<string, { key: string; parts: Map<number, { body: ArrayBuffer; etag: string }> }>();
  readonly objects = new Map<string, number>();
  createCalls = 0;
  partCalls = 0;
  completeCalls = 0;
  abortCalls = 0;
  failCreate = false;
  failPart = false;
  failComplete = false;
  failAbort = false;

  async createAttachmentUpload(input: AttachmentUploadInput) {
    this.createCalls += 1;
    if (this.failCreate) throw new Error('provider create failed');
    const uploadId = `upload-${this.createCalls}`;
    this.uploads.set(uploadId, { key: input.storageKey, parts: new Map() });
    return { uploadId, storageKey: input.storageKey };
  }

  async uploadAttachmentPart(input: AttachmentPartInput) {
    this.partCalls += 1;
    if (this.failPart) throw new Error('provider part failed');
    const upload = this.uploads.get(input.uploadId);
    if (!upload || upload.key !== input.storageKey) throw new Error('provider upload mismatch');
    if (upload.parts.has(input.partNumber)) throw new Error('provider part overwrite');
    const etag = `etag-${input.partNumber}-${input.body.byteLength}`;
    upload.parts.set(input.partNumber, { body: input.body, etag });
    return { etag };
  }

  async completeAttachmentUpload(input: AttachmentCompleteInput) {
    this.completeCalls += 1;
    if (this.failComplete) throw new Error('provider complete failed');
    if (this.objects.has(input.storageKey)) throw new Error('provider object overwrite');
    const upload = this.uploads.get(input.uploadId);
    if (!upload || upload.key !== input.storageKey) throw new Error('provider upload mismatch');
    let size = 0;
    for (const part of input.parts) {
      const stored = upload.parts.get(part.partNumber);
      if (!stored || stored.etag !== part.etag) throw new Error('provider part mismatch');
      size += stored.body.byteLength;
    }
    this.objects.set(input.storageKey, size);
    this.uploads.delete(input.uploadId);
  }

  async abortAttachmentUpload(input: { storageKey: string; uploadId: string }) {
    this.abortCalls += 1;
    if (this.failAbort) throw new Error('provider abort failed');
    const upload = this.uploads.get(input.uploadId);
    if (!upload || upload.key !== input.storageKey) throw new Error('provider upload mismatch');
    this.uploads.delete(input.uploadId);
  }

  async headAttachment(storageKey: string): Promise<AttachmentObjectMetadata | null> {
    const sizeBytes = this.objects.get(storageKey);
    return sizeBytes === undefined ? null : { storageKey, sizeBytes };
  }
}

function fixture(uid = 'attachment-001') {
  const state = new MemoryAttachmentState();
  const provider = new FakeAttachmentProvider();
  const service = createAttachmentService({ provider, state, createUid: () => uid });
  return { state, provider, service };
}

describe('lightweight attachment upload boundary', () => {
  it('derives an immutable key from owner + server uid and rejects client key substitution and cross-owner use', async () => {
    const { service, provider } = fixture();
    await expect(service.initialize({
      owner,
      uid: 'client-selected',
      filename: 'trace.txt',
      mediaType: 'text/plain',
      sizeBytes: 4,
    } as never)).rejects.toThrow('client attachment uid');
    const initialized = await service.initialize({
      owner,
      filename: 'trace.txt',
      mediaType: 'text/plain',
      sizeBytes: 4,
    });

    expect(initialized).toMatchObject({
      uid: 'attachment-001',
      objectKey: 'attachments/requirement/owner-a/attachment-001',
      uploadId: 'upload-1',
    });
    await expect(service.uploadPart({ owner: otherOwner, uid: initialized.uid, partNumber: 1, body: new ArrayBuffer(4) }))
      .rejects.toThrow('owner');
    await expect(service.uploadPart({
      owner,
      uid: initialized.uid,
      partNumber: 1,
      body: new ArrayBuffer(4),
      objectKey: 'attacker/key',
    } as never)).rejects.toThrow('object key');
    expect(provider.createCalls).toBe(1);
    expect(provider.partCalls).toBe(0);
  });

  it('validates filename, metadata, total size, and optional credential-free HTTPS public URLs before provider access', async () => {
    const { service, provider } = fixture();
    await expect(service.initialize({ owner, filename: 'x'.repeat(256), mediaType: 'text/plain', sizeBytes: 1 }))
      .rejects.toThrow('255');
    await expect(service.initialize({
      owner,
      filename: 'trace.txt',
      mediaType: 'text/plain',
      sizeBytes: ATTACHMENT_TOTAL_MAX_BYTES + 1,
    })).rejects.toThrow('100 MiB');
    await expect(service.initialize({
      owner,
      filename: 'trace.txt',
      mediaType: 'text/plain',
      sizeBytes: 1,
      metadata: { note: 'x'.repeat(ATTACHMENT_METADATA_MAX_BYTES) },
    })).rejects.toThrow('16 KiB');
    for (const publicUrl of ['http://example.test/file', '/relative', 'https://user:secret@example.test/file']) {
      await expect(service.initialize({ owner, filename: 'trace.txt', mediaType: 'text/plain', sizeBytes: 1, publicUrl }))
        .rejects.toThrow('HTTPS');
    }
    expect(provider.createCalls).toBe(0);

    const absent = await service.initialize({ owner, filename: 'x'.repeat(255), mediaType: 'text/plain', sizeBytes: 1 });
    expect(absent.publicUrl).toBeUndefined();
  });

  it('enforces ten exact 10 MiB parts with only the final part allowed to be shorter', async () => {
    const { service, provider } = fixture();
    const initialized = await service.initialize({
      owner,
      filename: 'bounded.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: ATTACHMENT_PART_BYTES + 3,
      publicUrl: 'https://cdn.example.test/bounded.bin',
    });

    await expect(service.uploadPart({ owner, uid: initialized.uid, partNumber: 1, body: new ArrayBuffer(3) }))
      .rejects.toThrow('10 MiB');
    await expect(service.uploadPart({ owner, uid: initialized.uid, partNumber: 3, body: new ArrayBuffer(1) }))
      .rejects.toThrow('part number');
    expect(provider.partCalls).toBe(0);

    await service.uploadPart({ owner, uid: initialized.uid, partNumber: 1, body: new ArrayBuffer(ATTACHMENT_PART_BYTES) });
    await expect(service.uploadPart({ owner, uid: initialized.uid, partNumber: 2, body: new ArrayBuffer(4) }))
      .rejects.toThrow('3 bytes');
    await service.uploadPart({ owner, uid: initialized.uid, partNumber: 2, body: new ArrayBuffer(3) });
    const completed = await service.complete({ owner, uid: initialized.uid });
    expect(completed).toMatchObject({ sizeBytes: ATTACHMENT_PART_BYTES + 3, publicUrl: 'https://cdn.example.test/bounded.bin' });
    expect(provider.objects.get(initialized.objectKey)).toBe(ATTACHMENT_PART_BYTES + 3);

    const max = fixture('attachment-max');
    await expect(max.service.initialize({
      owner,
      filename: 'max.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: ATTACHMENT_TOTAL_MAX_BYTES,
    })).resolves.toMatchObject({ partCount: 10 });
  });

  it('propagates provider failures without completed metadata and rejects repeated completion without provider reuse', async () => {
    const { service, state, provider } = fixture();
    provider.failCreate = true;
    await expect(service.initialize({ owner, filename: 'fail.bin', mediaType: 'application/octet-stream', sizeBytes: 4 }))
      .rejects.toThrow('provider create failed');
    expect(state.uploads.size).toBe(0);

    provider.failCreate = false;
    const initialized = await service.initialize({ owner, filename: 'fail.bin', mediaType: 'application/octet-stream', sizeBytes: 4 });
    provider.failPart = true;
    await expect(service.uploadPart({ owner, uid: initialized.uid, partNumber: 1, body: new ArrayBuffer(4) }))
      .rejects.toThrow('provider part failed');
    expect((await state.getUpload(initialized.uid))?.parts).toEqual([]);

    provider.failPart = false;
    await service.uploadPart({ owner, uid: initialized.uid, partNumber: 1, body: new ArrayBuffer(4) });
    provider.failComplete = true;
    await expect(service.complete({ owner, uid: initialized.uid })).rejects.toThrow('provider complete failed');
    expect(await state.getAttachment(initialized.uid)).toBeUndefined();
    expect(await state.getUpload(initialized.uid)).toBeDefined();

    provider.failComplete = false;
    await expect(service.complete({ owner, uid: initialized.uid })).resolves.toMatchObject({ uid: initialized.uid });
    const calls = provider.completeCalls;
    await expect(service.complete({ owner, uid: initialized.uid })).rejects.toThrow('already completed');
    expect(provider.completeCalls).toBe(calls);
  });

  it('unlinks metadata only and never exposes a provider delete operation', async () => {
    const { service, provider, state } = fixture();
    const initialized = await service.initialize({ owner, filename: 'keep.bin', mediaType: 'application/octet-stream', sizeBytes: 4 });
    await service.uploadPart({ owner, uid: initialized.uid, partNumber: 1, body: new ArrayBuffer(4) });
    await service.complete({ owner, uid: initialized.uid });

    await expect(service.unlink({ owner: otherOwner, uid: initialized.uid })).rejects.toThrow('owner');
    await expect(service.unlink({ owner, uid: initialized.uid })).resolves.toBe(true);
    expect(await state.getAttachment(initialized.uid)).toBeUndefined();
    expect(provider.objects.get(initialized.objectKey)).toBe(4);
  });

  it('rederives the abort key, rejects cross-owner/key input, and preserves state when the provider fails', async () => {
    const { service, provider, state } = fixture();
    const initialized = await service.initialize({ owner, filename: 'abort.bin', mediaType: 'application/octet-stream', sizeBytes: 4 });

    await expect(service.abort({ owner: otherOwner, uid: initialized.uid })).rejects.toThrow('owner');
    await expect(service.abort({ owner, uid: initialized.uid, storageKey: 'attacker/key' } as never)).rejects.toThrow('object key');
    expect(provider.abortCalls).toBe(0);

    provider.failAbort = true;
    await expect(service.abort({ owner, uid: initialized.uid })).rejects.toThrow('provider abort failed');
    expect(await state.getUpload(initialized.uid)).toBeDefined();

    provider.failAbort = false;
    await expect(service.abort({ owner, uid: initialized.uid })).resolves.toBeUndefined();
    expect(await state.getUpload(initialized.uid)).toBeUndefined();
    expect(provider.objects.size).toBe(0);
  });
});
