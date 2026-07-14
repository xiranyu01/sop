import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { D1PreparedStatementLike, D1RunResult } from '../../server/d1Store';
import { readLegacyDirectory, migrateLegacyD1, migrateLegacyFiles, MigrationInterruptedError, type MigrationD1DatabaseLike } from '../../server/migrations/runner';

type Row = {
  generation_id: string;
  lifecycle: string;
  source_fingerprint: string;
  maintenance_epoch: number;
  manifest_json: string;
  snapshot_json: string | null;
  report_json: string | null;
};

class MigrationMemoryD1 implements MigrationD1DatabaseLike {
  readonly rows = new Map<string, Row>();
  readonly activeMarkers = new Map<string, string>();

  prepare(query: string): D1PreparedStatementLike {
    const sql = query.replace(/\s+/g, ' ').trim();
    const db = this;
    return new class implements D1PreparedStatementLike {
      values: unknown[] = [];
      bind(...values: unknown[]) { this.values = values; return this; }
      async first<T>(): Promise<T | null> {
        if (sql.startsWith('SELECT generation_id')) return (db.rows.get(String(this.values[0])) ?? null) as T | null;
        throw new Error(`Unsupported first: ${sql}`);
      }
      async run(): Promise<D1RunResult> {
        if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE UNIQUE INDEX')) return { meta: { changes: 0 } };
        if (sql.startsWith('INSERT INTO canonical_migration_generations')) {
          const [id, sourceFingerprint, , , , , epoch, manifest, createdAt] = this.values;
          const existing = db.rows.get(String(id));
          if (existing) {
            if (existing.lifecycle !== 'BUILDING' || existing.maintenance_epoch !== Number(epoch)) return { meta: { changes: 0 } };
            existing.manifest_json = String(manifest);
          } else {
            db.rows.set(String(id), { generation_id: String(id), lifecycle: 'BUILDING', source_fingerprint: String(sourceFingerprint), maintenance_epoch: Number(epoch), manifest_json: String(manifest), snapshot_json: null, report_json: null });
          }
          void createdAt;
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE canonical_migration_generations SET report_json')) {
          const [report, id, epoch] = this.values; const row = db.rows.get(String(id));
          if (!row || row.lifecycle !== 'BUILDING' || row.maintenance_epoch !== Number(epoch)) return { meta: { changes: 0 } };
          row.report_json = String(report); return { meta: { changes: 1 } };
        }
        if (sql.startsWith('UPDATE canonical_migration_generations SET snapshot_json')) {
          const [snapshot, id, epoch] = this.values; const row = db.rows.get(String(id));
          if (!row || row.lifecycle !== 'BUILDING' || row.maintenance_epoch !== Number(epoch)) return { meta: { changes: 0 } };
          row.snapshot_json = String(snapshot); return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE canonical_migration_generations SET lifecycle = 'VALIDATED'")) {
          const [manifest, snapshot, report, , id, epoch] = this.values; const row = db.rows.get(String(id));
          if (!row || row.lifecycle !== 'BUILDING' || row.maintenance_epoch !== Number(epoch)) return { meta: { changes: 0 } };
          row.lifecycle = 'VALIDATED'; row.manifest_json = String(manifest); row.snapshot_json = String(snapshot); row.report_json = String(report);
          return { meta: { changes: 1 } };
        }
        throw new Error(`Unsupported run: ${sql}`);
      }
    }();
  }

  async batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<T[]> {
    return await Promise.all(statements.map((statement) => statement.run())) as unknown as T[];
  }
}

describe('legacy D1 migration', () => {
  it.each(['after-building-manifest', 'after-snapshot', 'after-report'] as const)('resumes safely after %s interruption', async (interruptAt) => {
    const legacy = await readLegacyDirectory('data'); const db = new MigrationMemoryD1();
    await expect(migrateLegacyD1(db, legacy, { maintenanceEpoch: 3, interruptAt })).rejects.toBeInstanceOf(MigrationInterruptedError);
    expect([...db.rows.values()][0].lifecycle).toBe('BUILDING');
    await expect(migrateLegacyD1(db, legacy, { maintenanceEpoch: 3 })).resolves.toMatchObject({ manifest: { lifecycle: 'VALIDATED' } });
  });

  it('resumes BUILDING under the same maintenance epoch and publishes only VALIDATED inactive data', async () => {
    const legacy = await readLegacyDirectory('data');
    const db = new MigrationMemoryD1();
    await expect(migrateLegacyD1(db, legacy, { maintenanceEpoch: 7, interruptAt: 'after-building-manifest' })).rejects.toBeInstanceOf(MigrationInterruptedError);
    expect([...db.rows.values()]).toHaveLength(1);
    expect([...db.rows.values()][0]).toMatchObject({ lifecycle: 'BUILDING', snapshot_json: null, maintenance_epoch: 7 });
    expect(db.activeMarkers.size).toBe(0);

    const completed = await migrateLegacyD1(db, legacy, { maintenanceEpoch: 7 });
    expect(completed.manifest.lifecycle).toBe('VALIDATED');
    expect([...db.rows.values()][0].snapshot_json).toBeTruthy();
    const repeated = await migrateLegacyD1(db, legacy, { maintenanceEpoch: 7 });
    expect(repeated.noOp).toBe(true);
    expect(db.activeMarkers.size).toBe(0);

    const fileRoot = await mkdtemp(path.join(os.tmpdir(), 'sop-parity-'));
    const file = await migrateLegacyFiles({ legacyDir: 'data', canonicalRoot: fileRoot });
    expect(completed.report).toEqual(file.report);

    const row = [...db.rows.values()][0];
    row.report_json = JSON.stringify({ ...JSON.parse(row.report_json!), semanticDigest: 'corrupt' });
    await expect(migrateLegacyD1(db, legacy, { maintenanceEpoch: 7 })).rejects.toThrow('reconciliation');
  });

  it('starts a distinct generation for changed source and rejects a stale maintenance epoch', async () => {
    const legacy = await readLegacyDirectory('data'); const db = new MigrationMemoryD1();
    const first = await migrateLegacyD1(db, legacy, { maintenanceEpoch: 1 });
    const changed = structuredClone(legacy); changed.customers[0].notes = 'changed';
    const second = await migrateLegacyD1(db, changed, { maintenanceEpoch: 1 });
    expect(second.generationId).not.toBe(first.generationId);
    await expect(migrateLegacyD1(db, legacy, { maintenanceEpoch: 2 })).rejects.toThrow('maintenance epoch');
  });
});
