import { describe, expect, it } from 'vitest';
import { bootstrapValidatedD1Generation } from '../../server/migrations/d1RuntimeBootstrap';
import type { D1DatabaseLike, D1PreparedStatementLike, D1RunResult } from '../../server/d1Store';
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

  prepare(query: string): D1PreparedStatementLike {
    const sql = query.replace(/\s+/g, ' ').trim();
    const db = this;
    return new class implements D1PreparedStatementLike {
      values: unknown[] = [];
      bind(...values: unknown[]) { this.values = values; return this; }
      async first<T>(): Promise<T | null> {
        if (sql.includes("canonical_store_meta WHERE key = 'runtime_namespace'")) {
          const value = db.meta.get('runtime_namespace');
          return (value ? { value } : null) as T | null;
        }
        if (sql.includes('FROM canonical_migration_generations WHERE generation_id = ?')) {
          return (db.generations.get(String(this.values[0])) ?? null) as T | null;
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
        if (sql.startsWith('INSERT OR IGNORE INTO canonical_store_meta')) {
          if (db.meta.has('runtime_namespace')) return { meta: { changes: 0 } };
          db.meta.set('runtime_namespace', String(this.values[0]));
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
