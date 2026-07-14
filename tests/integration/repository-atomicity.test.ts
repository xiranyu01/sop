import { create } from '@bufbuild/protobuf';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CustomerSchema } from '../../gen/coscene/sop/v1alpha1/catalog_pb';
import { createCanonicalD1AppStore, type D1DatabaseLike, type D1PreparedStatementLike, type D1RunResult } from '../../server/d1Store';
import type { AppStore } from '../../server/domain/appStore';
import { AtomicCommitError, StaleStoreEpochError, WriteFrozenError } from '../../server/domain/errors';
import { createCanonicalFileAppStore } from '../../server/store';

const customer = create(CustomerSchema, {
  name: 'customers/atomic',
  uid: '00000000-0000-4000-8000-000000000101',
  displayName: 'Atomic customer',
});

type Row = { namespace: string; epoch: number; writable: number; generation: number; snapshot_json: string };

class MemoryD1 implements D1DatabaseLike {
  readonly rows = new Map<string, Row>();
  readonly meta = new Map<string, string>();

  prepare(query: string): D1PreparedStatementLike {
    const sql = query.replace(/\s+/g, ' ').trim();
    const db = this;
    class Statement implements D1PreparedStatementLike {
      values: unknown[] = [];
      bind(...values: unknown[]) { this.values = values; return this; }
      async first<T>(): Promise<T | null> {
        if (sql.startsWith("SELECT value FROM canonical_store_meta")) {
          const value = db.meta.get('active_namespace');
          return (value ? { value } : null) as T | null;
        }
        if (sql.startsWith('SELECT namespace, epoch')) return (db.rows.get(String(this.values[0])) ?? null) as T | null;
        throw new Error(`Unsupported first: ${sql}`);
      }
      async run(): Promise<D1RunResult> {
        if (sql.startsWith('CREATE TABLE')) return { meta: { changes: 0 } };
        if (sql.startsWith('INSERT OR IGNORE INTO canonical_namespaces')) {
          const namespace = String(this.values[0]);
          if (db.rows.has(namespace)) return { meta: { changes: 0 } };
          db.rows.set(namespace, { namespace, epoch: 1, writable: 1, generation: 0, snapshot_json: String(this.values[1]) });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('INSERT OR IGNORE INTO canonical_store_meta')) {
          if (db.meta.has('active_namespace')) return { meta: { changes: 0 } };
          db.meta.set('active_namespace', String(this.values[0]));
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE canonical_namespaces SET snapshot_json')) {
          const [snapshot, , namespace, epoch, generation] = this.values;
          const row = db.rows.get(String(namespace));
          if (!row || row.epoch !== Number(epoch) || row.generation !== Number(generation) || !row.writable) return { meta: { changes: 0 } };
          row.snapshot_json = String(snapshot); row.generation += 1;
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE canonical_namespaces SET epoch')) {
          const [writable, , namespace, epoch] = this.values;
          const row = db.rows.get(String(namespace));
          if (!row || row.epoch !== Number(epoch)) return { meta: { changes: 0 } };
          row.epoch += 1; row.writable = Number(writable);
          return { meta: { changes: 1 } };
        }
        throw new Error(`Unsupported run: ${sql}`);
      }
    }
    return new Statement();
  }
}

async function exerciseEpochFence(store: AppStore): Promise<void> {
  const initialPin = await store.pin();
  const committed = await store.commit(initialPin, (snapshot) => ({ ...snapshot, customers: [customer] }));
  expect((await store.readSnapshot(committed.pin)).customers).toEqual([customer]);
  await expect(store.commit(initialPin, (snapshot) => snapshot)).rejects.toBeInstanceOf(AtomicCommitError);

  const frozen = await store.setWriteState(committed.pin, false);
  expect(frozen.epoch).toBe(committed.pin.epoch + 1);
  await expect(store.commit(committed.pin, (snapshot) => snapshot)).rejects.toBeInstanceOf(StaleStoreEpochError);
  await expect(store.commit(frozen, (snapshot) => snapshot)).rejects.toBeInstanceOf(WriteFrozenError);

  const reopened = await store.setWriteState(frozen, true);
  expect(reopened.epoch).toBe(frozen.epoch + 1);
  await expect(store.commit(reopened, (snapshot) => snapshot)).resolves.toMatchObject({ pin: { epoch: reopened.epoch } });
}

describe('canonical repository atomicity', () => {
  it('pins namespace/epoch and fences stale mutations for file and D1 stores', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-canonical-'));
    await exerciseEpochFence(createCanonicalFileAppStore({ rootDir: root }));
    await exerciseEpochFence(createCanonicalD1AppStore(new MemoryD1()));
  });

  it('does not expose a partially published file generation after fault injection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-canonical-fault-'));
    let fail = true;
    const store = createCanonicalFileAppStore({
      rootDir: root,
      faultInjection(point) { if (fail && point === 'before-manifest-publish') throw new Error('injected'); },
    });
    const pin = await store.pin();
    await expect(store.commit(pin, (snapshot) => ({ ...snapshot, customers: [customer] }))).rejects.toBeInstanceOf(AtomicCommitError);
    fail = false;
    const visiblePin = await store.pin();
    expect(visiblePin.generation).toBe(0);
    expect((await store.readSnapshot(visiblePin)).customers).toEqual([]);
  });

  it('does not mutate D1 when a fault occurs before its conditional atomic update', async () => {
    const db = new MemoryD1();
    let fail = true;
    const store = createCanonicalD1AppStore(db, { faultInjection() { if (fail) throw new Error('injected'); } });
    const pin = await store.pin();
    await expect(store.commit(pin, (snapshot) => ({ ...snapshot, customers: [customer] }))).rejects.toThrow('injected');
    fail = false;
    const visiblePin = await store.pin();
    expect(visiblePin.generation).toBe(0);
    expect((await store.readSnapshot(visiblePin)).customers).toEqual([]);
  });
});
