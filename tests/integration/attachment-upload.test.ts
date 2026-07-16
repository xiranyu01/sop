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
  type AttachmentPartReceipt,
  type AttachmentStateStore,
  type AttachmentUploadSession,
} from '../../server/domain/services/attachment';
import { repositoryBootstrapMarkerValue, repositoryBootstrapMetaKey } from '../../server/bootstrap/status';
import { handleResourceApiRequest } from '../../server/http/resourceApi';
import { onRequest as handlePagesRequest } from '../../functions/api/[[path]]';
import { createD1AttachmentStateStore } from '../../server/repositories/d1AttachmentStateStore';
import { createD1ResourceRepository } from '../../server/repositories/d1ResourceRepository';
import { SqliteD1 } from '../helpers/sqliteD1';
import { resourceStorageMigrationsSql } from '../helpers/resourceStorageMigrations';

const migrationSql = resourceStorageMigrationsSql;

const owner = { scope: 'requirement' as const, uid: 'owner-a' };
const otherOwner = { scope: 'requirement' as const, uid: 'owner-b' };

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryAttachmentState implements AttachmentStateStore {
  readonly uploads = new Map<string, AttachmentUploadSession>();
  readonly attachments = new Map<string, AttachmentMetadata>();
  readonly partReservations = new Map<string, string>();
  failCompleteCount = 0;
  failRecordPartBeforeCommitCount = 0;
  failRecordPartAfterCommitCount = 0;
  transformRecordPartReceipt?: (receipt: AttachmentPartReceipt) => AttachmentPartReceipt;

  async getUpload(uid: string) {
    const value = this.uploads.get(uid);
    return value && clone(value);
  }

  async createUpload(value: AttachmentUploadSession) {
    if (this.uploads.has(value.uid) || this.attachments.has(value.uid)) throw new Error('attachment uid already exists');
    this.uploads.set(value.uid, clone(value));
  }

  async reservePart(uid: string, uploadId: string, partNumber: number, reservationToken: string) {
    const current = this.uploads.get(uid);
    const key = `${uid}:${partNumber}`;
    if (!current || current.uploadId !== uploadId || this.partReservations.has(key) ||
      current.parts.some((part) => part.partNumber === partNumber)) return false;
    this.partReservations.set(key, reservationToken);
    return true;
  }

  async recordPart(uid: string, uploadId: string, reservationToken: string, receipt: AttachmentPartReceipt) {
    if (this.failRecordPartBeforeCommitCount > 0) {
      this.failRecordPartBeforeCommitCount -= 1;
      throw new Error('state record part failed before commit');
    }
    const current = this.uploads.get(uid);
    const key = `${uid}:${receipt.partNumber}`;
    if (!current || current.uploadId !== uploadId || this.partReservations.get(key) !== reservationToken) {
      throw new Error('attachment part reservation changed');
    }
    current.parts.push(clone(this.transformRecordPartReceipt?.(receipt) ?? receipt));
    current.parts.sort((left, right) => left.partNumber - right.partNumber);
    this.partReservations.delete(key);
    if (this.failRecordPartAfterCommitCount > 0) {
      this.failRecordPartAfterCommitCount -= 1;
      throw new Error('state record part response was lost after commit');
    }
  }

  async releasePart(uid: string, uploadId: string, partNumber: number, reservationToken: string) {
    const current = this.uploads.get(uid);
    const key = `${uid}:${partNumber}`;
    if (current?.uploadId === uploadId && this.partReservations.get(key) === reservationToken) {
      this.partReservations.delete(key);
    }
  }

  async completeUpload(uid: string, uploadId: string, value: AttachmentMetadata) {
    if (this.failCompleteCount > 0) {
      this.failCompleteCount -= 1;
      throw new Error('state complete failed');
    }
    const current = this.uploads.get(uid);
    const completed = this.attachments.get(uid);
    if (completed) {
      if (JSON.stringify(completed) !== JSON.stringify(value)) throw new Error('attachment upload changed');
      return;
    }
    if (!current || current.uploadId !== uploadId) throw new Error('attachment upload changed');
    this.uploads.delete(uid);
    for (const key of this.partReservations.keys()) if (key.startsWith(`${uid}:`)) this.partReservations.delete(key);
    this.attachments.set(uid, clone(value));
  }

  async removeUpload(uid: string, uploadId: string) {
    const current = this.uploads.get(uid);
    if (!current || current.uploadId !== uploadId) throw new Error('attachment upload changed');
    this.uploads.delete(uid);
    for (const key of this.partReservations.keys()) if (key.startsWith(`${uid}:`)) this.partReservations.delete(key);
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
  'createAttachmentUpload' | 'createAttachmentPartUploadUrl' | 'uploadAttachmentPart' |
  'completeAttachmentUpload' | 'abortAttachmentUpload' | 'headAttachment'> {
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

  async createAttachmentPartUploadUrl(input: { storageKey: string; uploadId: string; partNumber: number; expiresInSeconds: number }) {
    const upload = this.uploads.get(input.uploadId);
    if (!upload || upload.key !== input.storageKey) throw new Error('provider upload mismatch');
    return {
      uploadUrl: `https://r2.example.test/${input.storageKey}?partNumber=${input.partNumber}&uploadId=${input.uploadId}`,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    };
  }

  async completeAttachmentUpload(input: AttachmentCompleteInput) {
    this.completeCalls += 1;
    if (this.failComplete) throw new Error('provider complete failed');
    const existingSize = this.objects.get(input.storageKey);
    if (existingSize !== undefined) {
      if (existingSize !== input.expectedSizeBytes) throw new Error('provider object size mismatch');
      return;
    }
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
    if (!upload) return;
    if (upload.key !== input.storageKey) throw new Error('provider upload mismatch');
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

  it('propagates provider failures without completed metadata and returns completed metadata on response-loss retry', async () => {
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
    const completed = await service.complete({ owner, uid: initialized.uid });
    expect(completed).toMatchObject({ uid: initialized.uid });
    const calls = provider.completeCalls;
    await expect(service.complete({ owner, uid: initialized.uid })).resolves.toEqual(completed);
    expect(provider.completeCalls).toBe(calls);
  });

  it('recovers receipt persistence before commit without uploading the R2 part twice', async () => {
    const { service, state, provider } = fixture('attachment-part-pre-commit');
    const initialized = await service.initialize({
      owner,
      filename: 'part-pre-commit.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: 4,
    });
    state.failRecordPartBeforeCommitCount = 1;

    await expect(service.uploadPart({
      owner,
      uid: initialized.uid,
      partNumber: 1,
      body: new ArrayBuffer(4),
    })).resolves.toMatchObject({ partNumber: 1, sizeBytes: 4 });

    expect(provider.partCalls).toBe(1);
    await expect(state.getUpload(initialized.uid)).resolves.toMatchObject({
      parts: [{ partNumber: 1, etag: 'etag-1-4', sizeBytes: 4 }],
    });
    expect(state.partReservations.size).toBe(0);
  });

  it('reconciles a matching receipt after commit response loss and rejects a mismatched durable receipt', async () => {
    const committed = fixture('attachment-part-committed');
    const initialized = await committed.service.initialize({
      owner,
      filename: 'part-committed.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: 4,
    });
    committed.state.failRecordPartAfterCommitCount = 1;

    await expect(committed.service.uploadPart({
      owner,
      uid: initialized.uid,
      partNumber: 1,
      body: new ArrayBuffer(4),
    })).resolves.toMatchObject({ etag: 'etag-1-4' });
    expect(committed.provider.partCalls).toBe(1);
    expect(committed.state.partReservations.size).toBe(0);

    const mismatched = fixture('attachment-part-mismatched');
    const mismatchedUpload = await mismatched.service.initialize({
      owner,
      filename: 'part-mismatched.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: 4,
    });
    mismatched.state.transformRecordPartReceipt = (receipt) => ({ ...receipt, etag: 'different-etag' });
    mismatched.state.failRecordPartAfterCommitCount = 1;

    await expect(mismatched.service.uploadPart({
      owner,
      uid: mismatchedUpload.uid,
      partNumber: 1,
      body: new ArrayBuffer(4),
    })).rejects.toThrow('does not match the provider result');
    expect(mismatched.provider.partCalls).toBe(1);
    expect(mismatched.state.partReservations.size).toBe(0);
  });

  it('signs a direct part upload and records its receipt without proxying bytes through the service', async () => {
    const { service, state, provider } = fixture('attachment-direct');
    const initialized = await service.initialize({
      owner,
      filename: 'direct.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: 4,
    });
    expect(initialized.uploadMode).toBe('direct');
    await expect(service.createPartUploadUrl({ owner, uid: initialized.uid, partNumber: 1 })).resolves.toMatchObject({
      uploadUrl: expect.stringContaining('partNumber=1'),
    });

    // This provider call represents the browser PUT to the presigned R2 URL.
    const uploaded = await provider.uploadAttachmentPart({
      storageKey: initialized.objectKey,
      uploadId: initialized.uploadId,
      partNumber: 1,
      body: new ArrayBuffer(4),
    });
    await expect(service.recordDirectPart({
      owner,
      uid: initialized.uid,
      partNumber: 1,
      etag: uploaded.etag,
      sizeBytes: 4,
    })).resolves.toEqual({ partNumber: 1, etag: uploaded.etag, sizeBytes: 4 });
    await expect(service.recordDirectPart({
      owner,
      uid: initialized.uid,
      partNumber: 1,
      etag: uploaded.etag,
      sizeBytes: 4,
    })).resolves.toEqual({ partNumber: 1, etag: uploaded.etag, sizeBytes: 4 });
    expect((await state.getUpload(initialized.uid))?.parts).toHaveLength(1);
    await expect(service.complete({ owner, uid: initialized.uid })).resolves.toMatchObject({ uid: initialized.uid });
  });

  it('releases its exact reservation after persistent receipt persistence failure', async () => {
    const { service, state, provider } = fixture('attachment-part-persistent');
    const initialized = await service.initialize({
      owner,
      filename: 'part-persistent.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: 4,
    });
    state.failRecordPartBeforeCommitCount = 2;

    await expect(service.uploadPart({
      owner,
      uid: initialized.uid,
      partNumber: 1,
      body: new ArrayBuffer(4),
    })).rejects.toThrow('state record part failed before commit');
    expect(provider.partCalls).toBe(1);
    expect(state.partReservations.size).toBe(0);
  });

  it('keeps a completed object recoverable when durable completion fails and rejects destructive abort', async () => {
    const { service, state, provider } = fixture('attachment-retry');
    const initialized = await service.initialize({
      owner,
      filename: 'retry.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: 4,
    });
    await service.uploadPart({ owner, uid: initialized.uid, partNumber: 1, body: new ArrayBuffer(4) });
    state.failCompleteCount = 1;

    await expect(service.complete({ owner, uid: initialized.uid })).rejects.toThrow('state complete failed');
    expect(provider.objects.get(initialized.objectKey)).toBe(4);
    await expect(state.getUpload(initialized.uid)).resolves.toMatchObject({
      parts: [{ partNumber: 1, sizeBytes: 4 }],
    });

    await expect(service.abort({ owner, uid: initialized.uid })).rejects.toThrow('retry completion');
    await expect(state.getUpload(initialized.uid)).resolves.toBeDefined();

    await expect(service.complete({ owner, uid: initialized.uid })).resolves.toMatchObject({ uid: initialized.uid });
    await expect(state.getUpload(initialized.uid)).resolves.toBeUndefined();
    await expect(state.getAttachment(initialized.uid)).resolves.toMatchObject({ uid: initialized.uid });
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

describe('D1 attachment state', () => {
  it('reserves a multipart part in D1 before provider upload so concurrent requests cannot overwrite it', async () => {
    const db = new SqliteD1(migrationSql);
    const provider = new FakeAttachmentProvider();
    const state = createD1AttachmentStateStore(db, { clock: () => '2026-07-14T10:00:00.000Z' });
    const service = createAttachmentService({
      provider,
      state,
      createUid: () => '00000000-0000-4000-8000-000000000100',
    });
    const initialized = await service.initialize({
      owner,
      filename: 'concurrent.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: 4,
    });

    const results = await Promise.allSettled([
      service.uploadPart({ owner, uid: initialized.uid, partNumber: 1, body: new ArrayBuffer(4) }),
      service.uploadPart({ owner, uid: initialized.uid, partNumber: 1, body: new ArrayBuffer(4) }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(provider.partCalls).toBe(1);
    await expect(state.getUpload(initialized.uid)).resolves.toMatchObject({
      parts: [{ partNumber: 1, sizeBytes: 4 }],
    });
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_ATTACHMENT_PART_RESERVATIONS').get())
      .toEqual({ count: 0 });
    db.close();
  });

  it('persists an upload across state adapter recreation and atomically promotes it to completed metadata', async () => {
    const db = new SqliteD1(migrationSql);
    const provider = new FakeAttachmentProvider();
    const state = createD1AttachmentStateStore(db, { clock: () => '2026-07-14T10:00:00.000Z' });
    const service = createAttachmentService({
      provider,
      state,
      createUid: () => '00000000-0000-4000-8000-000000000101',
    });

    const initialized = await service.initialize({
      owner,
      filename: 'persisted.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: 4,
      publicUrl: 'https://assets.example.test/persisted.bin',
      metadata: { purpose: 'restart-test' },
    });
    await service.uploadPart({ owner, uid: initialized.uid, partNumber: 1, body: new ArrayBuffer(4) });

    const restartedState = createD1AttachmentStateStore(db, { clock: () => '2026-07-14T10:01:00.000Z' });
    const restarted = createAttachmentService({ provider, state: restartedState });
    const completed = await restarted.complete({ owner, uid: initialized.uid });
    expect(completed).toMatchObject({
      uid: initialized.uid,
      objectKey: initialized.objectKey,
      publicUrl: 'https://assets.example.test/persisted.bin',
      uploadedAt: '2026-07-14T10:01:00.000Z',
      metadata: { purpose: 'restart-test' },
    });
    await expect(restartedState.completeUpload(initialized.uid, initialized.uploadId, completed))
      .resolves.toBeUndefined();
    await expect(restartedState.completeUpload(initialized.uid, initialized.uploadId, {
      ...completed,
      filename: 'changed.bin',
    })).rejects.toThrow('Attachment upload changed');
    await expect(restartedState.getUpload(initialized.uid)).resolves.toBeUndefined();
    await expect(restartedState.getAttachment(initialized.uid)).resolves.toMatchObject({
      owner,
      uid: initialized.uid,
      sizeBytes: 4,
      uploadedAt: '2026-07-14T10:01:00.000Z',
    });
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_ATTACHMENT_UPLOADS').get()).toEqual({ count: 0 });
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_ATTACHMENT_METADATA').get()).toEqual({ count: 1 });
    expect(db.database.prepare(`SELECT kind, uid FROM SOP_CATALOG_RESOURCES
      WHERE name = ?`).get(`attachments/${initialized.uid}`)).toEqual({ kind: 'ATTACHMENT', uid: initialized.uid });
    db.close();
  });

  it('removes only D1 metadata on unlink and leaves completed provider bytes untouched', async () => {
    const db = new SqliteD1(migrationSql);
    const provider = new FakeAttachmentProvider();
    const state = createD1AttachmentStateStore(db);
    const service = createAttachmentService({
      provider,
      state,
      createUid: () => '00000000-0000-4000-8000-000000000102',
      publicBaseUrl: 'https://assets.example.test/public/',
    });
    const initialized = await service.initialize({
      owner,
      filename: 'orphaned.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: 4,
    });
    expect(initialized.publicUrl).toBe(
      `https://assets.example.test/public/attachments/requirement/${owner.uid}/${initialized.uid}`,
    );
    await service.uploadPart({ owner, uid: initialized.uid, partNumber: 1, body: new ArrayBuffer(4) });
    await service.complete({ owner, uid: initialized.uid });

    await expect(service.unlink({ owner, uid: initialized.uid })).resolves.toBe(true);
    await expect(state.getAttachment(initialized.uid)).resolves.toBeUndefined();
    expect(provider.objects.get(initialized.objectKey)).toBe(4);
    db.close();
  });

  it('keeps owner/key identity immutable and rejects direct malformed rows at the SQL boundary', async () => {
    const db = new SqliteD1(migrationSql);
    expect(() => db.database.prepare(`INSERT INTO SOP_ATTACHMENT_UPLOADS (
      uid, owner_scope, owner_uid, object_key, upload_id, filename, media_type,
      size_bytes, public_url, metadata_json, parts_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'attachment-invalid',
      'requirement',
      'owner-a',
      'client/substituted/key',
      'upload-invalid',
      'invalid.bin',
      'application/octet-stream',
      4,
      null,
      '{}',
      '[]',
      '2026-07-14T10:00:00.000Z',
      '2026-07-14T10:00:00.000Z',
    )).toThrow();
    db.close();
  });
});

describe('owner-scoped attachment resource API', () => {
  it('derives the owner uid from D1 and supports initialize, part, complete, metadata, and metadata-only unlink', async () => {
    const db = new SqliteD1(migrationSql);
    let etag = 0;
    const repository = createD1ResourceRepository(db, {
      clock: () => '2026-07-14T10:00:00.000Z',
      createEtag: () => `attachment-api-etag-${++etag}`,
    });
    const root = await repository.createCatalog({
      protoSchema: 'coscene.sop.v1alpha1.Material',
      protoJson: JSON.stringify({
        name: 'materials/attachment-owner',
        uid: 'attachment-owner-uid',
        displayName: 'Attachment owner',
      }),
    });
    const manifest = {
      schemaVersion: 'attachment-test-v1',
      bootstrapVersion: 'attachment-test-v1',
      datasetDigest: '0'.repeat(64),
      expectedCounts: { catalogs: 1, currents: 0, revisions: 0, bundles: 0 },
    };
    const expectedBootstrapMarker = repositoryBootstrapMarkerValue('COMPLETE', manifest);
    await repository.compareAndSetMeta({
      key: repositoryBootstrapMetaKey,
      nextValue: expectedBootstrapMarker,
    });
    const provider = new FakeAttachmentProvider();
    let attachmentUid = 0;
    const attachmentService = createAttachmentService({
      provider,
      state: createD1AttachmentStateStore(db),
      createUid: () => `00000000-0000-4000-8000-${String(++attachmentUid).padStart(12, '0')}`,
    });
    const path = `/api/resources/materials/${encodeURIComponent(root.name)}/attachments`;
    const apiOptions = {
      expectedBootstrapMarker,
      attachmentService,
      requestId: 'attachment-request',
    };
    const request = (suffix: string, init?: RequestInit) => handleResourceApiRequest(
      new Request(`https://sop.test${path}${suffix}`, init),
      repository,
      apiOptions,
    );

    const substituted = await request('', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'trace.bin', mediaType: 'application/octet-stream', sizeBytes: 4,
        objectKey: 'client/substitution',
      }),
    });
    expect(substituted.status).toBe(400);
    expect(provider.createCalls).toBe(0);

    const initializedResponse = await request('', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'trace.bin',
        mediaType: 'application/octet-stream',
        sizeBytes: 4,
        publicUrl: 'https://assets.example.test/trace.bin',
        metadata: { label: 'trace' },
      }),
    });
    expect(initializedResponse.status).toBe(201);
    const initialized = await initializedResponse.json() as { uid: string; objectKey: string; uploadId: string; uploadMode: string };
    expect(initialized).toMatchObject({
      uid: '00000000-0000-4000-8000-000000000001',
      objectKey: `attachments/material/${root.uid}/00000000-0000-4000-8000-000000000001`,
      uploadMode: 'direct',
    });

    let streamedChunks = 0;
    const oversizedRequest = new Request(
      `https://sop.test${path}/${initialized.uid}/parts/1`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            streamedChunks += 1;
            if (streamedChunks === 1) {
              controller.enqueue(new Uint8Array(ATTACHMENT_PART_BYTES));
              return;
            }
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' },
    );
    expect(oversizedRequest.headers.get('content-length')).toBeNull();
    const oversizedPart = await handleResourceApiRequest(oversizedRequest, repository, apiOptions);
    expect(oversizedPart.status).toBe(400);
    await expect(oversizedPart.json()).resolves.toMatchObject({ error: { kind: 'VALIDATION' } });
    expect(provider.partCalls).toBe(0);

    const part = await request(`/${initialized.uid}/parts/1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(4),
    });
    expect(part.status).toBe(200);
    await expect(part.json()).resolves.toMatchObject({ partNumber: 1, sizeBytes: 4 });

    const completed = await request(`/${initialized.uid}/complete`, { method: 'POST' });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      owner: { scope: 'material', uid: root.uid },
      uid: initialized.uid,
      name: `attachments/${initialized.uid}`,
      publicUrl: 'https://assets.example.test/trace.bin',
    });
    await expect(repository.getCatalog(`attachments/${initialized.uid}`)).resolves.toMatchObject({
      kind: 'ATTACHMENT',
      uid: initialized.uid,
      protoJson: expect.stringContaining('https://assets.example.test/trace.bin'),
    });

    const completedRetry = await request(`/${initialized.uid}/complete`, { method: 'POST' });
    expect(completedRetry.status).toBe(200);
    await expect(completedRetry.json()).resolves.toMatchObject({
      owner: { scope: 'material', uid: root.uid },
      uid: initialized.uid,
      name: `attachments/${initialized.uid}`,
    });
    expect(provider.completeCalls).toBe(1);

    const metadata = await request(`/${initialized.uid}`);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({ uid: initialized.uid, metadata: { label: 'trace' } });

    const directInitResponse = await request('', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'direct.bin', mediaType: 'application/octet-stream', sizeBytes: 4 }),
    });
    const directInit = await directInitResponse.json() as { uid: string; objectKey: string; uploadId: string };
    const uploadUrl = await request(`/${directInit.uid}/parts/1/upload-url`, { method: 'POST' });
    expect(uploadUrl.status).toBe(200);
    await expect(uploadUrl.json()).resolves.toMatchObject({ uploadUrl: expect.stringContaining('partNumber=1') });
    const directProviderPart = await provider.uploadAttachmentPart({
      storageKey: directInit.objectKey,
      uploadId: directInit.uploadId,
      partNumber: 1,
      body: new ArrayBuffer(4),
    });
    const directReceipt = await request(`/${directInit.uid}/parts/1/receipt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ etag: directProviderPart.etag, sizeBytes: 4 }),
    });
    expect(directReceipt.status).toBe(200);
    await expect(directReceipt.json()).resolves.toEqual({ partNumber: 1, etag: directProviderPart.etag, sizeBytes: 4 });
    expect((await request(`/${directInit.uid}/complete`, { method: 'POST' })).status).toBe(200);

    const unlinked = await request(`/${initialized.uid}`, { method: 'DELETE' });
    expect(unlinked.status).toBe(204);
    expect(provider.objects.get(initialized.objectKey)).toBe(4);
    expect((await request(`/${initialized.uid}`)).status).toBe(404);

    const abortInit = await request('', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'abort.bin', mediaType: 'application/octet-stream', sizeBytes: 4 }),
    });
    const aborting = await abortInit.json() as { uid: string };
    expect(abortInit.status).toBe(201);
    expect((await request(`/${aborting.uid}/abort`, { method: 'POST' })).status).toBe(204);
    expect((await request(`/${aborting.uid}`)).status).toBe(404);

    provider.failCreate = true;
    const providerFailure = await request('', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'failed.bin', mediaType: 'application/octet-stream', sizeBytes: 4 }),
    });
    expect(providerFailure.status).toBe(500);
    await expect(providerFailure.json()).resolves.toMatchObject({ error: { kind: 'STORAGE_UNAVAILABLE' } });
    db.close();
  });

  it('checks readiness before parsing a body or constructing an attachment provider', async () => {
    const db = new SqliteD1(migrationSql);
    const repository = createD1ResourceRepository(db);
    let providerConstructions = 0;
    const response = await handleResourceApiRequest(
      new Request('https://sop.test/api/resources/requirements/requirements%2Fmissing/attachments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      }),
      repository,
      {
        expectedBootstrapMarker: 'not-ready',
        createAttachmentService() {
          providerConstructions += 1;
          return createAttachmentService({ provider: new FakeAttachmentProvider(), state: new MemoryAttachmentState() });
        },
      },
    );
    expect(response.status).toBe(503);
    expect(providerConstructions).toBe(0);
    db.close();
  });

  it('keeps the Pages attachment binding lazy until after auth and readiness', async () => {
    const db = new SqliteD1(migrationSql);
    let r2Reads = 0;
    const env = {
      DB: db,
      APP_PASSWORD: 'secret',
      get ATTACHMENTS(): never {
        r2Reads += 1;
        throw new Error('R2 binding was accessed before readiness');
      },
    };
    const unauthorized = await handlePagesRequest({
      request: new Request('https://sop.test/api/resources/materials/materials%2Fowner/attachments', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: '{not-json',
      }),
      env,
    });
    expect(unauthorized.status).toBe(401);
    expect(r2Reads).toBe(0);

    const unready = await handlePagesRequest({
      request: new Request('https://sop.test/api/resources/materials/materials%2Fowner/attachments', {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: '{not-json',
      }),
      env,
    });
    expect(unready.status).toBe(503);
    expect(r2Reads).toBe(0);
    db.close();
  });
});
