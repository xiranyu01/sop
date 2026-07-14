import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { AttachmentSchema, MaterialSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { runAttachmentCleanup } from '../../server/domain/attachmentCleanup';
import { emptyCanonicalSnapshot } from '../../server/domain/appStore';
import { cleanupIntentId } from '../../server/domain/attachmentService';
import { createCanonicalFileAppStore } from '../../server/store';
import { createCanonicalApiStore } from '../../server/domain/services/runtime';

function deletionIntent(storageKey: string) {
  return {
    id: cleanupIntentId('DELETE_OBJECT', storageKey), storageKey,
    state: 'PENDING' as const, operation: 'DELETE_OBJECT' as const,
    notBefore: '2026-01-01T00:00:00.000Z', attempts: 0,
  };
}

async function storeWith(snapshot = emptyCanonicalSnapshot()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sop-attachment-cleanup-'));
  return createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'validated', snapshot } });
}

describe('durable attachment cleanup', () => {
  it('respects rollback leases and retries an idempotent delete after provider failure', async () => {
    const snapshot = emptyCanonicalSnapshot();
    snapshot.operational.cleanupIntents = [
      deletionIntent('managed/leased.bin'), deletionIntent('managed/expired.bin'), deletionIntent('managed/retry.bin'),
    ];
    snapshot.operational.leases = [
      { storageKey: 'managed/leased.bin', generationId: 'rollback' },
      { storageKey: 'managed/expired.bin', generationId: 'old-rollback', expiresAt: '2026-01-02T00:00:00.000Z' },
    ];
    const store = await storeWith(snapshot);
    let retryCalls = 0;
    const objects = {
      async deleteAttachment(key: string) {
        if (key === 'managed/retry.bin' && retryCalls++ === 0) throw new Error('temporary provider failure');
      },
      async abortAttachmentUpload() {},
    };

    expect(await runAttachmentCleanup(store, objects, {
      namespace: 'validated', clock: () => new Date('2026-07-14T00:00:00.000Z'), retryDelayMs: 1,
    })).toEqual({ deleted: 1, aborted: 0, failed: 1 });
    let current = await store.readSnapshot(await store.pin('validated'));
    expect(current.operational.cleanupIntents.find((item) => item.storageKey === 'managed/retry.bin')).toMatchObject({
      state: 'CLAIMED', attempts: 1, lastError: 'temporary provider failure',
    });
    expect(current.operational.cleanupIntents.map((item) => item.storageKey)).toEqual(['managed/leased.bin', 'managed/retry.bin']);

    expect(await runAttachmentCleanup(store, objects, {
      namespace: 'validated', clock: () => new Date('2026-07-14T00:00:00.002Z'), retryDelayMs: 1, claimTimeoutMs: 1,
    })).toEqual({ deleted: 1, aborted: 0, failed: 0 });
    current = await store.readSnapshot(await store.pin('validated'));
    expect(current.operational.cleanupIntents.map((item) => item.storageKey)).toEqual(['managed/leased.bin']);
  });

  it('never deletes a completed object while its authoritative upload is still being published', async () => {
    const snapshot = emptyCanonicalSnapshot();
    snapshot.operational.uploads = [{
      uploadId: 'upload-race', storageKey: 'managed/race.bin', attachmentName: 'attachments/race',
      attachmentId: 'race', filename: 'race.bin', mediaType: 'application/octet-stream', expectedSizeBytes: 1,
      scope: 'requirement', ownerId: 'REQ001', version: '0.0.1', parts: [{ partNumber: 1, etag: 'etag', sizeBytes: 1 }],
      createdAt: '2026-07-13T00:00:00.000Z', expiresAt: '2026-07-15T00:00:00.000Z',
    }];
    snapshot.operational.cleanupIntents = [deletionIntent('managed/race.bin')];
    const store = await storeWith(snapshot);
    let deletes = 0;
    expect(await runAttachmentCleanup(store, {
      async deleteAttachment() { deletes += 1; },
      async abortAttachmentUpload() {},
    }, { namespace: 'validated', clock: () => new Date('2026-07-14T00:00:00.000Z') }))
      .toEqual({ deleted: 0, aborted: 0, failed: 0 });
    expect(deletes).toBe(0);
  });

  it('removes an expired upload atomically after its TTL abort succeeds', async () => {
    const snapshot = emptyCanonicalSnapshot();
    snapshot.operational.uploads = [{
      uploadId: 'upload-expired', storageKey: 'managed/expired-upload.bin', attachmentName: 'attachments/expired',
      attachmentId: 'expired', filename: 'expired.bin', mediaType: 'application/octet-stream', expectedSizeBytes: 1,
      scope: 'requirement', ownerId: 'REQ001', version: '0.0.1', parts: [],
      createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z',
    }];
    snapshot.operational.cleanupIntents = [{
      id: cleanupIntentId('ABORT_MULTIPART', 'managed/expired-upload.bin', 'upload-expired'),
      storageKey: 'managed/expired-upload.bin', uploadId: 'upload-expired', state: 'PENDING',
      operation: 'ABORT_MULTIPART', notBefore: '2026-01-02T00:00:00.000Z', attempts: 0,
    }];
    const store = await storeWith(snapshot);
    expect(await runAttachmentCleanup(store, {
      async deleteAttachment() {},
      async abortAttachmentUpload() {},
    }, { namespace: 'validated', clock: () => new Date('2026-07-14T00:00:00.000Z') }))
      .toEqual({ deleted: 0, aborted: 1, failed: 0 });
    const current = await store.readSnapshot(await store.pin('validated'));
    expect(current.operational.uploads).toEqual([]);
    expect(current.operational.cleanupIntents).toEqual([]);
  });

  it('claims with AppStore CAS so concurrent workers perform one physical delete', async () => {
    const snapshot = emptyCanonicalSnapshot();
    snapshot.operational.cleanupIntents = [deletionIntent('managed/once.bin')];
    const store = await storeWith(snapshot);
    let deletes = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const objects = {
      async deleteAttachment() { deletes += 1; await blocked; },
      async abortAttachmentUpload() {},
    };
    const first = runAttachmentCleanup(store, objects, { namespace: 'validated', workerId: 'worker-a', clock: () => new Date('2026-07-14T00:00:00.000Z') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await runAttachmentCleanup(store, objects, { namespace: 'validated', workerId: 'worker-b', clock: () => new Date('2026-07-14T00:00:00.000Z') });
    release();
    expect(await first).toEqual({ deleted: 1, aborted: 0, failed: 0 });
    expect(second).toEqual({ deleted: 0, aborted: 0, failed: 0 });
    expect(deletes).toBe(1);
  });

  it('keeps rollback namespace downloads resolvable without widening active namespace authorization', async () => {
    const attachment = create(AttachmentSchema, {
      name: 'attachments/rollback', filename: 'rollback.bin', mediaType: 'application/octet-stream', storageKey: 'managed/rollback.bin',
    });
    const rollback = emptyCanonicalSnapshot();
    rollback.attachments = [attachment];
    rollback.materials = [create(MaterialSchema, {
      name: 'materials/rollback', displayName: 'rollback', images: [attachment.name],
    })];
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-attachment-rollback-'));
    const rollbackStore = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'rollback', snapshot: rollback } });
    expect(await createCanonicalApiStore(rollbackStore, { namespace: 'rollback' }).resolveAttachment('managed/rollback.bin'))
      .toEqual(expect.objectContaining({ filename: 'rollback.bin' }));

    const active = emptyCanonicalSnapshot();
    active.operational.leases = [{ storageKey: 'managed/rollback.bin', generationId: 'rollback', expiresAt: '2030-01-01T00:00:00.000Z' }];
    const activeStore = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'active', snapshot: active } });
    expect(await createCanonicalApiStore(activeStore, { namespace: 'active' }).resolveAttachment('managed/rollback.bin')).toBeUndefined();
  });
});
