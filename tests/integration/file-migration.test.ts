import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MigrationInterruptedError, MigrationValidationError, migrateLegacyFiles } from '../../server/migrations/runner';

describe('legacy file migration', () => {
  it.each(['after-building-manifest', 'after-snapshot', 'after-report'] as const)('resumes safely after %s interruption without exposing an active marker', async (interruptAt) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-file-checkpoint-'));
    await expect(migrateLegacyFiles({ legacyDir: 'data', canonicalRoot: root, interruptAt })).rejects.toBeInstanceOf(MigrationInterruptedError);
    await expect(readFile(path.join(root, 'active-namespace'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(migrateLegacyFiles({ legacyDir: 'data', canonicalRoot: root })).resolves.toMatchObject({ manifest: { lifecycle: 'VALIDATED' } });
  });

  it('resumes a BUILDING generation, validates it without activation, and makes an identical rerun a no-op', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-file-migration-'));
    await expect(migrateLegacyFiles({ legacyDir: 'data', canonicalRoot: root, interruptAt: 'after-snapshot' })).rejects.toBeInstanceOf(MigrationInterruptedError);
    await expect(readFile(path.join(root, 'active-namespace'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const completed = await migrateLegacyFiles({ legacyDir: 'data', canonicalRoot: root });
    expect(completed.manifest.lifecycle).toBe('VALIDATED');
    expect(completed.noOp).toBe(false);
    const manifestFile = path.join(root, 'migration-generations', completed.generationId, 'manifest.json');
    const snapshotFile = path.join(root, 'migration-generations', completed.generationId, 'snapshot.json');
    const before = [await readFile(manifestFile, 'utf8'), await readFile(snapshotFile, 'utf8')];

    const repeated = await migrateLegacyFiles({ legacyDir: 'data', canonicalRoot: root });
    expect(repeated.noOp).toBe(true);
    expect([await readFile(manifestFile, 'utf8'), await readFile(snapshotFile, 'utf8')]).toEqual(before);
    const reportFile = path.join(root, 'migration-generations', completed.generationId, 'report.json');
    const report = JSON.parse(await readFile(reportFile, 'utf8')) as { semanticDigest: string };
    report.semanticDigest = 'corrupt';
    await writeFile(reportFile, JSON.stringify(report));
    await expect(migrateLegacyFiles({ legacyDir: 'data', canonicalRoot: root })).rejects.toThrow('reconciliation');
  });

  it('creates a new generation when source content changes and never mutates the old generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-file-source-change-'));
    const legacy = path.join(root, 'legacy');
    await cp('data', legacy, { recursive: true });
    const first = await migrateLegacyFiles({ legacyDir: legacy, canonicalRoot: root });
    const customersFile = path.join(legacy, 'customers.json');
    const customers = JSON.parse(await readFile(customersFile, 'utf8')) as Array<{ notes?: string }>;
    customers[0].notes = 'changed source';
    await writeFile(customersFile, JSON.stringify(customers));
    const second = await migrateLegacyFiles({ legacyDir: legacy, canonicalRoot: root });
    expect(second.generationId).not.toBe(first.generationId);
    expect(JSON.parse(await readFile(path.join(root, 'migration-generations', first.generationId, 'manifest.json'), 'utf8'))).toMatchObject({ lifecycle: 'VALIDATED' });
  });

  it('fails closed when managed attachment bytes are not reachable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-file-attachment-'));
    const legacy = path.join(root, 'legacy');
    await cp('data', legacy, { recursive: true });
    const materialsFile = path.join(legacy, 'materials.json');
    const materials = JSON.parse(await readFile(materialsFile, 'utf8')) as Array<Record<string, unknown>>;
    materials[0].images = [{ id: 'missing', name: 'missing.png', size: 12, contentType: 'image/png', storageKey: 'materials/missing.png', uploadedAt: '2026-01-01T00:00:00.000Z' }];
    await writeFile(materialsFile, JSON.stringify(materials));
    await expect(migrateLegacyFiles({ legacyDir: legacy, canonicalRoot: root, attachmentRoot: path.join(root, 'uploads') })).rejects.toBeInstanceOf(MigrationValidationError);
  });
});
