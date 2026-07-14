import { describe, expect, it } from 'vitest';
import { bootstrapValidatedD1Generation } from '../../server/migrations/d1RuntimeBootstrap';
import type { D1DatabaseLike, D1PreparedStatementLike, D1RunResult } from '../../server/d1Store';
import { decodeCanonicalSnapshot, encodeCanonicalSnapshot } from '../../server/domain/appStore';
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

class RuntimeD1 implements D1DatabaseLike {
  readonly generations = new Map<string, GenerationRow>();
  readonly meta = new Map<string, string>([['active_namespace', 'previous-active']]);
  readonly namespaces = new Map<string, { namespace: string; epoch: number; writable: number; generation: number; snapshot_json: string }>();

  prepare(query: string): D1PreparedStatementLike {
    const sql = query.replace(/\s+/g, ' ').trim();
    const db = this;
    return new class implements D1PreparedStatementLike {
      values: unknown[] = [];
      bind(...values: unknown[]) { this.values = values; return this; }
      async first<T>(): Promise<T | null> {
        if (sql === 'SELECT value FROM canonical_store_meta WHERE key = ?') {
          const value = db.meta.get(String(this.values[0]));
          return (value ? { value } : null) as T | null;
        }
        if (sql.includes("canonical_store_meta WHERE key = 'runtime_namespace'")) {
          const value = db.meta.get('runtime_namespace');
          return (value ? { value } : null) as T | null;
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
          const id = String(this.values[0]);
          if (db.generations.has(id)) return { meta: { changes: 0 } };
          db.generations.set(id, {
            generation_id: id,
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
          const parameterizedKey = this.values.length === 2;
          const key = parameterizedKey ? String(this.values[0]) : sql.includes("'active_namespace'") ? 'active_namespace' : 'runtime_namespace';
          const value = String(this.values[parameterizedKey ? 1 : 0]);
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
        throw new Error(`Unsupported run: ${sql}`);
      }
    }();
  }
}

describe('Pages canonical inactive-generation boot', () => {
  it('anchors the first validated generation and ignores later legacy changes without touching active_namespace', async () => {
    const db = new RuntimeD1();
    const first = await bootstrapValidatedD1Generation(db, structuredClone(seedData));
    const changed = structuredClone(seedData);
    changed.customers[0].name = 'changed legacy data';
    const second = await bootstrapValidatedD1Generation(db, changed);

    expect(second.generationId).toBe(first.generationId);
    expect(second.snapshot.customers[0].displayName).toBe(seedData.customers[0].name);
    expect(db.meta.get('runtime_namespace')).toBe(first.generationId);
    expect(db.meta.get('active_namespace')).toBe('previous-active');
  });

  it('persists rollback leases into an existing canonical namespace once, anchored to upgrade time', async () => {
    const db = new RuntimeD1();
    const legacy = structuredClone(seedData);
    legacy.materials[0].images = [{
      id: 'lease-image', name: 'lease.png', size: 4, contentType: 'image/png',
      storageKey: 'managed/lease.png', uploadedAt: '2025-01-01T00:00:00.000Z',
    }];
    const installed = await bootstrapValidatedD1Generation(db, legacy, {
      clock: () => new Date('2025-01-01T00:00:00.000Z'), rollbackAttachmentLeaseMs: 60_000,
    });
    const row = db.namespaces.get(installed.generationId)!;
    const preUpgrade = decodeCanonicalSnapshot(row.snapshot_json);
    preUpgrade.materials = preUpgrade.materials.map((material) => ({ ...material, images: [] }));
    preUpgrade.attachments = [];
    preUpgrade.operational.leases = [];
    row.snapshot_json = encodeCanonicalSnapshot(preUpgrade);
    db.meta.delete(`rollback_attachment_lease:${installed.generationId}`);

    const first = await bootstrapValidatedD1Generation(db, legacy, {
      clock: () => new Date('2026-07-14T10:00:00.000Z'), rollbackAttachmentLeaseMs: 60_000,
    });
    const afterFirst = decodeCanonicalSnapshot(row.snapshot_json);
    expect(afterFirst.operational.leases).toContainEqual({
      storageKey: 'managed/lease.png', generationId: first.generationId, expiresAt: '2026-07-14T10:01:00.000Z',
    });
    const generationAfterFirst = row.generation;

    // A restart must neither extend the lease nor write a new canonical generation.
    const second = await bootstrapValidatedD1Generation(db, legacy, {
      clock: () => new Date('2026-07-20T00:00:00.000Z'), rollbackAttachmentLeaseMs: 60_000,
    });
    expect(second.snapshot.operational.leases).toEqual(afterFirst.operational.leases);
    expect(row.generation).toBe(generationAfterFirst);
    expect(db.meta.get(`rollback_attachment_lease:${first.generationId}`)).toContain('2026-07-14T10:00:00.000Z');

    // Characterize that persistence, not only the returned bootstrap value, is authoritative.
    expect(encodeCanonicalSnapshot(second.snapshot)).toBe(row.snapshot_json);
  });

  it('rejects an anchored BUILDING generation', async () => {
    const db = new RuntimeD1();
    const first = await bootstrapValidatedD1Generation(db, structuredClone(seedData));
    db.generations.get(first.generationId)!.lifecycle = 'BUILDING';
    await expect(bootstrapValidatedD1Generation(db, structuredClone(seedData))).rejects.toThrow('not VALIDATED');
  });

  it('rejects corrupt manifest/digest data instead of serving or rebuilding it', async () => {
    const db = new RuntimeD1();
    const first = await bootstrapValidatedD1Generation(db, structuredClone(seedData));
    const row = db.generations.get(first.generationId)!;
    const manifest = JSON.parse(row.manifest_json) as { semanticDigest: string };
    manifest.semanticDigest = 'corrupt';
    row.manifest_json = JSON.stringify(manifest);
    await expect(bootstrapValidatedD1Generation(db, structuredClone(seedData))).rejects.toThrow('reconciliation');
  });

  it.each([
    'formatVersion',
    'converterVersion',
    'storageSchemaVersion',
    'canonicalSchemaVersion',
    'identityVersion',
  ] as const)('rejects an anchored generation with incompatible manifest %s', async (field) => {
    const db = new RuntimeD1();
    const first = await bootstrapValidatedD1Generation(db, structuredClone(seedData));
    const row = db.generations.get(first.generationId)!;
    const manifest = JSON.parse(row.manifest_json) as Record<string, unknown>;
    manifest[field] = 'incompatible/version';
    row.manifest_json = JSON.stringify(manifest);

    await expect(bootstrapValidatedD1Generation(db, structuredClone(seedData))).rejects.toThrow('reconciliation');
  });

  it.each([
    'converter_version',
    'storage_schema_version',
    'canonical_schema_version',
    'identity_version',
  ] as const)('rejects an anchored generation whose independent %s column disagrees', async (field) => {
    const db = new RuntimeD1();
    const first = await bootstrapValidatedD1Generation(db, structuredClone(seedData));
    db.generations.get(first.generationId)![field] = 'incompatible/version';

    await expect(bootstrapValidatedD1Generation(db, structuredClone(seedData))).rejects.toThrow('reconciliation');
  });
});
