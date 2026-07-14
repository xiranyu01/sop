import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { onRequest } from '../../functions/api/[[path]]';
import { AttachmentSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { createCanonicalD1AppStore, type D1DatabaseLike, type D1PreparedStatementLike, type D1RunResult } from '../../server/d1Store';
import { cleanupIntentId } from '../../server/domain/attachmentService';
import type { R2BucketLike } from '../../server/r2AttachmentStore';
import { seedData } from '../e2e/fixtures/seed';

type GenerationRow = {
  generation_id: string;
  lifecycle: string;
  source_fingerprint: string;
  converter_version: string;
  storage_schema_version: string;
  canonical_schema_version: string;
  identity_version: string;
  manifest_json: string;
  snapshot_json: string;
  report_json: string;
};

type NamespaceRow = { namespace: string; epoch: number; writable: number; generation: number; snapshot_json: string };

class PagesD1 implements D1DatabaseLike {
  readonly appData = new Map(Object.entries(seedData).map(([key, value]) => [key, JSON.stringify(value)]));
  readonly generations = new Map<string, GenerationRow>();
  readonly namespaces = new Map<string, NamespaceRow>();
  readonly meta = new Map<string, string>();

  prepare(query: string): D1PreparedStatementLike {
    const sql = query.replace(/\s+/g, ' ').trim();
    const db = this;
    return new class implements D1PreparedStatementLike {
      values: unknown[] = [];
      bind(...values: unknown[]) { this.values = values; return this; }
      async first<T>(): Promise<T | null> {
        if (sql === 'SELECT value FROM app_data WHERE key = ?') {
          const value = db.appData.get(String(this.values[0]));
          return (value === undefined ? null : { value }) as T | null;
        }
        if (sql === 'SELECT value FROM canonical_store_meta WHERE key = ?') {
          const value = db.meta.get(String(this.values[0]));
          return (value === undefined ? null : { value }) as T | null;
        }
        if (sql.includes("canonical_store_meta WHERE key = 'runtime_namespace'")) {
          const value = db.meta.get('runtime_namespace');
          return (value === undefined ? null : { value }) as T | null;
        }
        if (sql.includes("canonical_store_meta WHERE key = 'active_namespace'")) {
          const value = db.meta.get('active_namespace');
          return (value === undefined ? null : { value }) as T | null;
        }
        if (sql.includes('FROM canonical_migration_generations WHERE generation_id = ?')) {
          return (db.generations.get(String(this.values[0])) ?? null) as T | null;
        }
        if (sql.startsWith('SELECT namespace, epoch')) {
          return (db.namespaces.get(String(this.values[0])) ?? null) as T | null;
        }
        throw new Error(`Unsupported first: ${sql}`);
      }
      async run(): Promise<D1RunResult> {
        if (sql.startsWith('CREATE TABLE')) return { meta: { changes: 0 } };
        if (sql.startsWith('INSERT OR IGNORE INTO canonical_migration_generations')) {
          const generationId = String(this.values[0]);
          if (db.generations.has(generationId)) return { meta: { changes: 0 } };
          db.generations.set(generationId, {
            generation_id: generationId,
            lifecycle: 'VALIDATED',
            source_fingerprint: String(this.values[1]),
            converter_version: String(this.values[2]),
            storage_schema_version: String(this.values[3]),
            canonical_schema_version: String(this.values[4]),
            identity_version: String(this.values[5]),
            manifest_json: String(this.values[6]),
            snapshot_json: String(this.values[7]),
            report_json: String(this.values[8]),
          });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('INSERT OR IGNORE INTO canonical_namespaces')) {
          const namespace = String(this.values[0]);
          if (db.namespaces.has(namespace)) return { meta: { changes: 0 } };
          const namedBootstrap = this.values.length === 4;
          db.namespaces.set(namespace, {
            namespace,
            epoch: 1,
            writable: namedBootstrap ? Number(this.values[1]) : 1,
            generation: 0,
            snapshot_json: String(namedBootstrap ? this.values[2] : this.values[1]),
          });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('INSERT OR IGNORE INTO canonical_store_meta')) {
          const parameterized = this.values.length === 2;
          const key = parameterized ? String(this.values[0]) : sql.includes("'active_namespace'") ? 'active_namespace' : 'runtime_namespace';
          const value = String(this.values[parameterized ? 1 : 0]);
          if (db.meta.has(key)) return { meta: { changes: 0 } };
          db.meta.set(key, value);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE canonical_namespaces SET snapshot_json')) {
          const [snapshot, , namespace, epoch, generation] = this.values;
          const row = db.namespaces.get(String(namespace));
          if (!row || row.epoch !== Number(epoch) || row.generation !== Number(generation) || !row.writable) return { meta: { changes: 0 } };
          row.snapshot_json = String(snapshot);
          row.generation += 1;
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE canonical_namespaces SET epoch = epoch + 1')) {
          const [writable, , namespace, epoch] = this.values;
          const row = db.namespaces.get(String(namespace));
          if (!row || row.epoch !== Number(epoch)) return { meta: { changes: 0 } };
          row.epoch += 1;
          row.writable = Number(writable);
          return { meta: { changes: 1 } };
        }
        throw new Error(`Unsupported run: ${sql}`);
      }
    }();
  }
}

function fakeR2() {
  const objects = new Map<string, { body: string; contentType: string }>();
  const gets: string[] = [];
  const deletes: string[] = [];
  const bucket: R2BucketLike = {
    async createMultipartUpload() { throw new Error('not used'); },
    resumeMultipartUpload() { throw new Error('not used'); },
    async get(key) {
      gets.push(key);
      const object = objects.get(key);
      if (!object) return null;
      return {
        size: new TextEncoder().encode(object.body).byteLength,
        httpMetadata: { contentType: object.contentType },
        body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(object.body)); controller.close(); } }),
      };
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { size: new TextEncoder().encode(object.body).byteLength, httpMetadata: { contentType: object.contentType } } : null;
    },
    async delete(key) { deletes.push(key); objects.delete(key); },
  };
  return { bucket, objects, gets, deletes };
}

function pagesRequest(db: PagesD1, bucket: R2BucketLike, pathname: string) {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    response: onRequest({
      request: new Request(`https://sop.example.test${pathname}`, { headers: { authorization: 'Bearer test-password' } }),
      env: { DB: db, ATTACHMENTS: bucket, APP_PASSWORD: 'test-password', CANONICAL_BOOTSTRAP_MODE: 'auto' },
      waitUntil(promise) { pending.push(promise); },
    }),
  };
}

describe('Pages attachment authorization and cleanup', () => {
  it('rejects unauthorized requests before parsing or bootstrapping storage', async () => {
    const db = new PagesD1();
    const r2 = fakeR2();
    const response = await onRequest({
      request: new Request('https://sop.example.test/api/data', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-password', 'content-type': 'application/json' },
        body: '{not valid json',
      }),
      env: { DB: db, ATTACHMENTS: r2.bucket, APP_PASSWORD: 'test-password' },
    });

    expect(response.status).toBe(401);
    expect(db.generations.size).toBe(0);
    expect(db.namespaces.size).toBe(0);
    expect(db.meta.size).toBe(0);
    expect(r2.gets).toEqual([]);
    expect(r2.deletes).toEqual([]);
  });

  it('prepares a frozen candidate but does not activate it by default', async () => {
    const db = new PagesD1();
    const r2 = fakeR2();
    const response = await onRequest({
      request: new Request('https://sop.example.test/api/canonical-data', {
        headers: { authorization: 'Bearer test-password' },
      }),
      env: { DB: db, ATTACHMENTS: r2.bucket, APP_PASSWORD: 'test-password' },
    });

    expect(response.status).toBe(503);
    const result = await response.json() as { candidateNamespace: string };
    expect(result.candidateNamespace).toMatch(/^v1alpha1-/);
    expect(db.meta.has('runtime_namespace')).toBe(false);
    expect(db.generations.get(result.candidateNamespace)?.lifecycle).toBe('VALIDATED');
    expect(db.namespaces.get(result.candidateNamespace)?.writable).toBe(0);
  });

  it('authorizes R2 downloads from canonical reachability and never fetches removed or external keys', async () => {
    const db = new PagesD1();
    const image = {
      id: 'pages-image', name: 'pages.png', size: 5, contentType: 'image/png',
      storageKey: 'managed/pages.png', uploadedAt: '2026-01-01T00:00:00.000Z',
    };
    db.appData.set('materials', JSON.stringify([{ ...seedData.materials[0], images: [image] }]));
    const r2 = fakeR2();
    r2.objects.set(image.storageKey, { body: 'image', contentType: 'image/png' });

    let request = pagesRequest(db, r2.bucket, `/api/attachments/${encodeURIComponent(image.storageKey)}`);
    const downloaded = await request.response;
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe('image');
    await Promise.all(request.pending);
    expect(r2.gets).toEqual([image.storageKey]);

    const namespace = db.meta.get('runtime_namespace')!;
    const store = createCanonicalD1AppStore(db);
    let pin = await store.pin(namespace);
    ({ pin } = await store.commit(pin, (snapshot) => ({
      ...snapshot,
      materials: snapshot.materials.map((material) => ({ ...material, images: [] })),
    })));
    request = pagesRequest(db, r2.bucket, `/api/attachments/${encodeURIComponent(image.storageKey)}`);
    expect((await request.response).status).toBe(404);
    await Promise.all(request.pending);
    expect(r2.gets).toEqual([image.storageKey]);

    await store.commit(pin, (snapshot) => ({
      ...snapshot,
      attachments: [...snapshot.attachments, create(AttachmentSchema, {
        name: 'attachments/external-pages', filename: 'external.txt', mediaType: 'text/plain', uri: 'https://cdn.example.test/external.txt',
      })],
      materials: snapshot.materials.map((material) => ({ ...material, images: ['attachments/external-pages'] })),
    }));
    request = pagesRequest(db, r2.bucket, '/api/attachments/external-pages');
    expect((await request.response).status).toBe(404);
    await Promise.all(request.pending);
    expect(r2.gets).toEqual([image.storageKey]);
  });

  it('limits cleanup work per request and never deletes an active upload', async () => {
    const db = new PagesD1();
    const r2 = fakeR2();
    let request = pagesRequest(db, r2.bucket, '/api/data');
    expect((await request.response).status).toBe(200);
    await Promise.all(request.pending);

    const namespace = db.meta.get('runtime_namespace')!;
    const store = createCanonicalD1AppStore(db);
    const pin = await store.pin(namespace);
    await store.commit(pin, (snapshot) => {
      const next = structuredClone(snapshot);
      for (let index = 1; index <= 5; index += 1) {
        const storageKey = `managed/orphan-${index}.bin`;
        next.operational.cleanupIntents.push({
          id: cleanupIntentId('DELETE_OBJECT', storageKey), storageKey, state: 'PENDING', operation: 'DELETE_OBJECT',
          notBefore: '2020-01-01T00:00:00.000Z', attempts: 0,
        });
      }
      next.operational.uploads.push({
        uploadId: 'active-upload', storageKey: 'managed/active.bin', attachmentName: 'attachments/active', attachmentId: 'active',
        filename: 'active.bin', mediaType: 'application/octet-stream', expectedSizeBytes: 1,
        scope: 'requirement', ownerId: 'REQ001', version: '0.0.1', parts: [],
        createdAt: '2026-07-14T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z',
      });
      next.operational.cleanupIntents.push({
        id: cleanupIntentId('DELETE_OBJECT', 'managed/active.bin'), storageKey: 'managed/active.bin', state: 'PENDING',
        operation: 'DELETE_OBJECT', notBefore: '2020-01-01T00:00:00.000Z', attempts: 0,
      });
      return next;
    });

    request = pagesRequest(db, r2.bucket, '/api/data');
    expect((await request.response).status).toBe(200);
    await Promise.all(request.pending);
    expect(r2.deletes).toHaveLength(4);
    expect(r2.deletes).not.toContain('managed/active.bin');
  });
});
