import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../server/api';
import type { AppStore } from '../../server/domain/appStore';
import type { AttachmentObjectStore } from '../../server/domain/attachmentObjectStore';
import { createCanonicalApiStore } from '../../server/domain/services/runtime';
import { convertLegacyToV1alpha1 } from '../../server/migrations/legacyToV1alpha1';
import { createCanonicalFileAppStore } from '../../server/store';
import { seedData } from '../e2e/fixtures/seed';

class MemoryObjects implements AttachmentObjectStore {
  readonly completed = new Set<string>();
  readonly deleted: string[] = [];
  readonly aborted: string[] = [];
  readonly uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  onFirstComplete?: () => void;
  failAborts = 0;
  next = 0;

  async createAttachmentUpload(input: { storageKey: string }) {
    const uploadId = `upload-${++this.next}`;
    this.uploads.set(uploadId, { key: input.storageKey, parts: new Map() });
    return { uploadId, storageKey: input.storageKey };
  }
  async uploadAttachmentPart(input: { storageKey: string; uploadId: string; partNumber: number; body: ArrayBuffer }) {
    const upload = this.uploads.get(input.uploadId);
    if (!upload || upload.key !== input.storageKey) throw new Error('bad upload');
    upload.parts.set(input.partNumber, new Uint8Array(input.body));
    return { etag: `etag-${input.partNumber}` };
  }
  async completeAttachmentUpload(input: { storageKey: string; uploadId: string }) {
    const upload = this.uploads.get(input.uploadId);
    if (!upload || upload.key !== input.storageKey) throw new Error('bad upload');
    if (!this.completed.has(input.storageKey)) this.onFirstComplete?.();
    this.completed.add(input.storageKey);
  }
  async abortAttachmentUpload(input: { storageKey: string; uploadId: string }) {
    if (this.failAborts > 0) {
      this.failAborts -= 1;
      throw new Error('injected abort failure');
    }
    this.aborted.push(`${input.uploadId}:${input.storageKey}`);
    this.uploads.delete(input.uploadId);
  }
  async deleteAttachment(storageKey: string) {
    this.deleted.push(storageKey);
    this.completed.delete(storageKey);
  }
  async getAttachment() { return null; }
  async headAttachment(storageKey: string) {
    return this.completed.has(storageKey)
      ? { storageKey, sizeBytes: 4, contentType: 'text/plain', sha256: 'a'.repeat(64) }
      : null;
  }
  async attachmentExists(storageKey: string) { return this.completed.has(storageKey); }
}

async function fixture(options: { failMetadataCommits?: number; failInitialCommits?: number; failAborts?: number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sop-attachments-node-'));
  const objects = new MemoryObjects();
  const snapshot = convertLegacyToV1alpha1(structuredClone(seedData)).snapshot;
  const durableStore = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'validated', snapshot } });
  let failMetadataCommits = options.failInitialCommits ?? 0;
  objects.failAborts = options.failAborts ?? 0;
  objects.onFirstComplete = () => { failMetadataCommits = options.failMetadataCommits ?? 0; };
  const appStore: AppStore = {
    pin: durableStore.pin.bind(durableStore),
    readSnapshot: durableStore.readSnapshot.bind(durableStore),
    setWriteState: durableStore.setWriteState.bind(durableStore),
    async commit(pin, mutation) {
      return durableStore.commit(pin, async (current) => {
        const next = await mutation(current);
        if (failMetadataCommits > 0) {
          failMetadataCommits -= 1;
          throw new Error('injected metadata commit failure');
        }
        return next;
      });
    },
  };
  const attachments: AttachmentObjectStore = {
    createAttachmentUpload: objects.createAttachmentUpload.bind(objects),
    uploadAttachmentPart: objects.uploadAttachmentPart.bind(objects),
    completeAttachmentUpload: objects.completeAttachmentUpload.bind(objects),
    abortAttachmentUpload: objects.abortAttachmentUpload.bind(objects),
    deleteAttachment: objects.deleteAttachment.bind(objects),
    getAttachment: objects.getAttachment.bind(objects),
    headAttachment: objects.headAttachment.bind(objects),
    attachmentExists: objects.attachmentExists.bind(objects),
  };
  const store = createCanonicalApiStore(appStore, {
    namespace: 'validated', attachments, attachmentRetentionMs: 0,
    clock: () => new Date('2026-07-14T00:00:00.000Z'),
  });
  return { appStore, store, objects };
}

async function uploadRequirementAttachment(store: ReturnType<typeof createCanonicalApiStore>) {
  const bytes = new TextEncoder().encode('tiny');
  const init = await handleApiRequest(store, {
    method: 'POST', pathname: '/api/requirements/REQ001/versions/0.0.1/attachments/init',
    body: { fileName: 'tiny.txt', size: bytes.byteLength, contentType: 'text/plain' },
  });
  expect(init.status, JSON.stringify(init.body)).toBe(200);
  const session = init.body as { attachmentId: string; uploadId: string; storageKey: string };
  const part = await handleApiRequest(store, {
    method: 'PUT', pathname: `/api/requirements/REQ001/versions/0.0.1/attachments/${session.uploadId}/parts/1`,
    search: `?storageKey=${encodeURIComponent(session.storageKey)}`, rawBody: bytes.buffer as ArrayBuffer,
  });
  expect(part.status).toBe(200);
  const completed = await handleApiRequest(store, {
    method: 'POST', pathname: `/api/requirements/REQ001/versions/0.0.1/attachments/${session.attachmentId}/complete`,
    body: { uploadId: session.uploadId, storageKey: session.storageKey, parts: [{ partNumber: 1, etag: 'etag-1' }] },
  });
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  return session;
}

describe('canonical Node attachment lifecycle', () => {
  it('binds upload sessions server-side, blocks confirmation until completion, and atomically publishes metadata', async () => {
    const { appStore, store, objects } = await fixture();
    const bytes = new TextEncoder().encode('tiny');
    const init = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/requirements/REQ001/versions/0.0.1/attachments/init',
      body: { fileName: 'tiny.txt', size: bytes.byteLength, contentType: 'text/plain' },
    });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const session = init.body as { attachmentId: string; uploadId: string; storageKey: string };
    expect((await store.readData()).requirements[0].versions[0].attachments).toEqual([]);
    expect((await appStore.readSnapshot(await appStore.pin('validated'))).operational.uploads).toHaveLength(1);

    const confirm = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/requirements/REQ001/confirm', body: { version: '0.0.1' },
    });
    expect(confirm.status).toBe(400);
    expect(confirm.body).toEqual(expect.objectContaining({ message: expect.stringContaining('尚未完成上传') }));

    const malicious = await handleApiRequest(store, {
      method: 'PUT', pathname: `/api/requirements/REQ001/versions/0.0.1/attachments/${session.uploadId}/parts/1`,
      search: '?storageKey=attacker%2Fkey', rawBody: bytes.buffer as ArrayBuffer,
    });
    expect(malicious.status).toBe(400);
    expect(objects.uploads.get(session.uploadId)?.parts.size).toBe(0);
  });

  it('never physically deletes a confirmed attachment and cleans an unreferenced draft through the durable intent', async () => {
    const confirmedFixture = await fixture();
    const confirmedSession = await uploadRequirementAttachment(confirmedFixture.store);
    expect((await handleApiRequest(confirmedFixture.store, {
      method: 'POST', pathname: '/api/requirements/REQ001/confirm', body: { version: '0.0.1' },
    })).status).toBe(200);
    const blocked = await handleApiRequest(confirmedFixture.store, {
      method: 'DELETE', pathname: `/api/requirements/REQ001/versions/0.0.1/attachments/${confirmedSession.attachmentId}`,
    });
    expect(blocked.status).toBe(400);
    expect(confirmedFixture.objects.deleted).toEqual([]);
    expect(confirmedFixture.objects.completed).toContain(confirmedSession.storageKey);

    const draftFixture = await fixture();
    const draftSession = await uploadRequirementAttachment(draftFixture.store);
    const removed = await handleApiRequest(draftFixture.store, {
      method: 'DELETE', pathname: `/api/requirements/REQ001/versions/0.0.1/attachments/${draftSession.attachmentId}`,
    });
    expect(removed.status).toBe(200);
    expect(draftFixture.objects.deleted).toEqual([draftSession.storageKey]);
    expect((await draftFixture.appStore.readSnapshot(await draftFixture.appStore.pin('validated'))).operational.cleanupIntents).toEqual([]);
  });

  it('uses the same bound session flow for material images and TaskSop attachments', async () => {
    const { store, objects } = await fixture();
    const bytes = new TextEncoder().encode('tiny');
    const materialInit = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/materials/mat-baseline/images/init',
      body: { fileName: 'image.png', size: bytes.byteLength, contentType: 'image/png' },
    });
    expect(materialInit.status, JSON.stringify(materialInit.body)).toBe(200);
    const image = materialInit.body as { attachmentId: string; uploadId: string; storageKey: string };
    expect((await store.readData()).materials[0].images).toEqual([]);
    expect((await handleApiRequest(store, {
      method: 'PUT', pathname: `/api/materials/mat-baseline/images/${image.uploadId}/parts/1`,
      search: `?storageKey=${encodeURIComponent(image.storageKey)}`, rawBody: bytes.buffer as ArrayBuffer,
    })).status).toBe(200);
    expect((await handleApiRequest(store, {
      method: 'POST', pathname: `/api/materials/mat-baseline/images/${image.attachmentId}/complete`,
      body: { uploadId: image.uploadId, storageKey: image.storageKey, parts: [{ partNumber: 1, etag: 'etag-1' }] },
    })).status).toBe(200);
    expect((await store.readData()).materials[0].images).toEqual([expect.objectContaining({ id: image.attachmentId })]);

    expect((await handleApiRequest(store, {
      method: 'POST', pathname: '/api/scenes/scene-baseline/subscenes/NO.001/versions',
      body: { baseVersion: '0.0.1', description: 'attachment draft' },
    })).status).toBe(200);
    const taskInit = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/scenes/scene-baseline/subscenes/NO.001/versions/0.0.2/attachments/init',
      body: { fileName: 'task.txt', size: bytes.byteLength, contentType: 'text/plain' },
    });
    expect(taskInit.status, JSON.stringify(taskInit.body)).toBe(200);
    const task = taskInit.body as { attachmentId: string; uploadId: string; storageKey: string };
    const pendingConfirm = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/scenes/scene-baseline/subscenes/NO.001/confirm', body: { version: '0.0.2' },
    });
    expect(pendingConfirm.status).toBe(400);
    expect(pendingConfirm.body).toEqual(expect.objectContaining({ message: expect.stringContaining('尚未完成上传') }));
    expect((await handleApiRequest(store, {
      method: 'PUT', pathname: `/api/scenes/scene-baseline/subscenes/NO.001/versions/0.0.2/attachments/${task.uploadId}/parts/1`,
      search: `?storageKey=${encodeURIComponent(task.storageKey)}`, rawBody: bytes.buffer as ArrayBuffer,
    })).status).toBe(200);
    expect((await handleApiRequest(store, {
      method: 'POST', pathname: `/api/scenes/scene-baseline/subscenes/NO.001/versions/0.0.2/attachments/${task.attachmentId}/complete`,
      body: { uploadId: task.uploadId, storageKey: task.storageKey, parts: [{ partNumber: 1, etag: 'etag-1' }] },
    })).status).toBe(200);
    expect((await handleApiRequest(store, {
      method: 'POST', pathname: '/api/scenes/scene-baseline/subscenes/NO.001/versions',
      body: {
        baseVersion: '0.0.2',
        materials: [{
          materialId: 'mat-baseline', skuId: 'SKU001', type: '测试物料',
          quantity: { mode: 'fixed', value: 1, unit: '件' }, color: '白色', material: '塑料', packageType: '盒装',
        }],
      },
    })).status).toBe(200);
    expect((await handleApiRequest(store, {
      method: 'POST', pathname: '/api/scenes/scene-baseline/subscenes/NO.001/confirm', body: { version: '0.0.2' },
    })).status).toBe(200);
    const inheritedPatch = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/scenes/scene-baseline/subscenes/NO.001/versions',
      body: { baseVersion: '0.0.2', description: 'inherits the confirmed attachment' },
    });
    expect(inheritedPatch.status, JSON.stringify(inheritedPatch.body)).toBe(200);
    expect((await store.readData()).scenes[0].subscenes[0].versions.find((version) => version.version === '0.0.3')?.attachments)
      .toEqual([expect.objectContaining({ id: task.attachmentId })]);
    expect((await handleApiRequest(store, {
      method: 'DELETE', pathname: `/api/scenes/scene-baseline/subscenes/NO.001/versions/0.0.2/attachments/${task.attachmentId}`,
    })).status).toBe(400);
    expect(objects.deleted).not.toContain(task.storageKey);
    expect((await handleApiRequest(store, {
      method: 'DELETE', pathname: `/api/materials/mat-baseline/images/${image.attachmentId}`,
    })).status).toBe(200);
    expect(objects.deleted).not.toContain(image.storageKey);
    expect(await store.resolveAttachment(image.storageKey)).toEqual(expect.objectContaining({ filename: 'image.png' }));
  });

  it('rejects attachment metadata injected through ordinary resource CRUD', async () => {
    const { store } = await fixture();
    const forged = {
      id: 'att-forged', name: 'forged.txt', size: 4, contentType: 'text/plain',
      storageKey: 'missing/object', uploadedAt: '2026-07-14T00:00:00.000Z',
    };

    const requirement = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/requirements', body: { title: 'forged requirement', attachments: [forged] },
    });
    expect(requirement.status).toBe(400);
    expect(requirement.body).toEqual(expect.objectContaining({ message: expect.stringContaining('附件') }));

    const material = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/materials',
      body: { id: 'mat-forged', skuId: 'SKU-FORGED', type: 'forged', images: [forged] },
    });
    expect(material.status).toBe(400);

    const task = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/scenes/scene-baseline/subscenes/NO.001/versions',
      body: { baseVersion: '0.0.1', attachments: [forged] },
    });
    expect(task.status).toBe(400);
  });

  it('keeps a completed object recoverable when the metadata commit fails, then publishes it on retry', async () => {
    const { appStore, store, objects } = await fixture({ failMetadataCommits: 1 });
    const bytes = new TextEncoder().encode('tiny');
    const init = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/requirements/REQ001/versions/0.0.1/attachments/init',
      body: { fileName: 'retry.txt', size: bytes.byteLength, contentType: 'text/plain' },
    });
    const session = init.body as { attachmentId: string; uploadId: string; storageKey: string };
    expect((await handleApiRequest(store, {
      method: 'PUT', pathname: `/api/requirements/REQ001/versions/0.0.1/attachments/${session.uploadId}/parts/1`,
      search: `?storageKey=${encodeURIComponent(session.storageKey)}`, rawBody: bytes.buffer as ArrayBuffer,
    })).status).toBe(200);
    const completeRequest = {
      method: 'POST', pathname: `/api/requirements/REQ001/versions/0.0.1/attachments/${session.attachmentId}/complete`,
      body: { uploadId: session.uploadId, storageKey: session.storageKey, parts: [{ partNumber: 1, etag: 'etag-1' }] },
    };

    const failed = await handleApiRequest(store, completeRequest);
    expect(failed.status).toBe(500);
    expect(objects.completed).toContain(session.storageKey);
    let canonical = await appStore.readSnapshot(await appStore.pin('validated'));
    expect(canonical.attachments.some((attachment) => attachment.sourceId === session.attachmentId)).toBe(false);
    expect(canonical.operational.uploads).toEqual([expect.objectContaining({ uploadId: session.uploadId })]);
    expect(canonical.operational.cleanupIntents).toContainEqual(expect.objectContaining({
      storageKey: session.storageKey, operation: 'DELETE_OBJECT', state: 'PENDING',
    }));
    expect(await store.cleanupAttachments()).toEqual({ deleted: 0, aborted: 0, failed: 0 });

    const retried = await handleApiRequest(store, completeRequest);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    canonical = await appStore.readSnapshot(await appStore.pin('validated'));
    expect(canonical.attachments).toContainEqual(expect.objectContaining({
      sourceId: session.attachmentId,
      sha256: 'a'.repeat(64),
    }));
    expect(canonical.operational.uploads).toEqual([]);
    expect(canonical.operational.cleanupIntents).toEqual([]);
  });

  it('fails closed on malformed completion and requires a bound abort request', async () => {
    const { store, objects } = await fixture();
    const bytes = new TextEncoder().encode('tiny');
    const init = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/requirements/REQ001/versions/0.0.1/attachments/init',
      body: { fileName: 'wrong-size.txt', size: bytes.byteLength + 1, contentType: 'text/plain' },
    });
    const session = init.body as { attachmentId: string; uploadId: string; storageKey: string };
    expect((await handleApiRequest(store, {
      method: 'PUT', pathname: `/api/requirements/REQ001/versions/0.0.1/attachments/${session.uploadId}/parts/1`,
      search: `?storageKey=${encodeURIComponent(session.storageKey)}`, rawBody: bytes.buffer as ArrayBuffer,
    })).status).toBe(200);
    const malformed = await handleApiRequest(store, {
      method: 'POST', pathname: `/api/requirements/REQ001/versions/0.0.1/attachments/${session.attachmentId}/complete`,
      body: { uploadId: session.uploadId, storageKey: session.storageKey, parts: [{ partNumber: 1, etag: 'etag-1' }] },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual(expect.objectContaining({ message: expect.stringContaining('大小') }));
    expect(objects.completed).not.toContain(session.storageKey);

    const unboundAbort = await handleApiRequest(store, {
      method: 'POST', pathname: `/api/requirements/REQ001/versions/0.0.1/attachments/${session.attachmentId}/abort`,
      body: {},
    });
    expect(unboundAbort.status).toBe(400);
    expect(objects.aborted).toEqual([]);
  });

  it('persists an abort intent when binding and immediate multipart compensation both fail', async () => {
    const { appStore, store, objects } = await fixture({ failInitialCommits: 1, failAborts: 1 });
    const init = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/requirements/REQ001/versions/0.0.1/attachments/init',
      body: { fileName: 'orphan.txt', size: 4, contentType: 'text/plain' },
    });

    expect(init.status).toBe(500);
    expect(objects.uploads.size).toBe(1);
    const canonical = await appStore.readSnapshot(await appStore.pin('validated'));
    expect(canonical.operational.uploads).toEqual([]);
    expect(canonical.operational.cleanupIntents).toEqual([expect.objectContaining({
      operation: 'ABORT_MULTIPART', state: 'PENDING', uploadId: 'upload-1',
    })]);
  });

  it('does not let a full legacy file store override canonical data methods', async () => {
    const { appStore, objects } = await fixture();
    const fullLegacyShape = Object.assign(Object.create(objects) as AttachmentObjectStore, {
      async readData() { return { requirements: [] }; },
      async writeRequirements() { return []; },
    });
    const canonical = createCanonicalApiStore(appStore, { namespace: 'validated', attachments: fullLegacyShape });
    expect((await canonical.readData()).requirements).toEqual([expect.objectContaining({ id: 'REQ001' })]);
  });
});
