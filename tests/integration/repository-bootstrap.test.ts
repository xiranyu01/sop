import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import customers from '../../data/customers.json';
import globalFields from '../../data/global-fields.json';
import materialStateRules from '../../data/material-state-rules.json';
import materials from '../../data/materials.json';
import metadata from '../../data/metadata.json';
import requirements from '../../data/requirements.json';
import robotModels from '../../data/robot-models.json';
import scenes from '../../data/scenes.json';
import { describe, expect, it } from 'vitest';
import type { AppData } from '../../shared/transport/restDto';
import { bootstrapRepository } from '../../server/bootstrap/repository';
import { prepareRepositoryData } from '../../server/bootstrap/repositoryData';
import { repositoryReleaseManifest } from '../../server/bootstrap/releaseManifest';
import { repositoryBootstrapMetaKey, repositoryReadiness } from '../../server/bootstrap/status';
import { RepositoryNotReadyError, type ResourceRepository } from '../../server/domain/repository';
import { createD1ResourceRepository } from '../../server/repositories/d1ResourceRepository';
import { SqliteD1 } from '../helpers/sqliteD1';

const fixtureData = {
  metadata,
  customers,
  materials,
  robotModels,
  scenes,
  requirements,
  globalFields,
  materialStateRules,
} as AppData;

async function harness() {
  const migration = await readFile(resolve('migrations/0001_resource_storage.sql'), 'utf8');
  const db = new SqliteD1(migration);
  let etag = 0;
  const repository = createD1ResourceRepository(db, {
    clock: () => '2026-07-14T10:00:00.000Z',
    createEtag: () => `bootstrap-etag-${++etag}`,
  });
  return { db, repository, data: prepareRepositoryData(structuredClone(fixtureData)) };
}

function failOnce(repository: ResourceRepository, afterCreates: number): ResourceRepository {
  let remaining = afterCreates;
  let failed = false;
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== 'createCatalog' || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (!failed && remaining-- === 0) {
          failed = true;
          throw new Error('injected bootstrap interruption');
        }
        return (value as (...input: unknown[]) => unknown)(...args);
      };
    },
  });
}

describe('explicit repository bootstrap', () => {
  it('initializes independent records, preserves draft checkpoints, and is restart-idempotent', async () => {
    const { db, repository, data } = await harness();
    expect(await repositoryReadiness(repository, data)).toEqual({ ready: false, reason: 'bootstrap marker is missing' });
    const first = await bootstrapRepository(repository, data);
    expect(first).toEqual({ state: 'COMPLETE', idempotent: false, recovered: false });
    expect(await repositoryReadiness(repository, repositoryReleaseManifest)).toEqual({ ready: true });

    const task = data.currents.find((item) => item.protoJson.includes('scene-home-NO.001'))!;
    const history = await repository.listRevisions(task.name, { limit: 100 });
    expect(history.items.filter((item) => item.revisionOrigin === 'IMPORTED_DRAFT_CHECKPOINT')).toHaveLength(2);
    expect(history.items.filter((item) => item.exportEligible)).toHaveLength(2);
    expect(await repository.getExportBundle(history.items.find((item) => item.revisionOrigin === 'IMPORTED_DRAFT_CHECKPOINT')!.name)).toBeUndefined();

    const restarted = createD1ResourceRepository(db, {
      clock: () => '2026-07-14T11:00:00.000Z',
      createEtag: () => 'must-not-be-used',
    });
    expect(await bootstrapRepository(restarted, data)).toEqual({ state: 'COMPLETE', idempotent: true, recovered: false });
    db.close();
  });

  it('recovers same-digest partial work without overwrite', async () => {
    const { db, repository, data } = await harness();
    await expect(bootstrapRepository(failOnce(repository, 2), data)).rejects.toThrow('injected bootstrap interruption');
    const marker = await repository.getMeta(repositoryBootstrapMetaKey);
    expect(marker?.value).toContain('IN_PROGRESS');

    const result = await bootstrapRepository(repository, data);
    expect(result).toEqual({ state: 'COMPLETE', idempotent: false, recovered: true });
    expect(await repositoryReadiness(repository, repositoryReleaseManifest)).toEqual({ ready: true });
    db.close();
  });

  it('lets concurrent same-digest operators converge on one complete marker', async () => {
    const { db, repository, data } = await harness();
    const results = await Promise.all([
      bootstrapRepository(repository, data),
      bootstrapRepository(repository, data),
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.state === 'COMPLETE')).toBe(true);
    expect(await repositoryReadiness(repository, repositoryReleaseManifest)).toEqual({ ready: true });
    db.close();
  });

  it('blocks a different digest while an interrupted bootstrap owns the database', async () => {
    const { db, repository, data } = await harness();
    await expect(bootstrapRepository(failOnce(repository, 0), data)).rejects.toThrow('injected bootstrap interruption');
    const changed = { ...data, datasetDigest: 'f'.repeat(64) };
    await expect(bootstrapRepository(repository, changed)).rejects.toThrow('different version or dataset digest');
    expect((await repository.getMeta(repositoryBootstrapMetaKey))?.value).toContain('IN_PROGRESS');
    db.close();
  });

  it('fails same-digest recovery instead of overwriting a changed record', async () => {
    const { db, repository, data } = await harness();
    await expect(bootstrapRepository(failOnce(repository, 2), data)).rejects.toThrow('injected bootstrap interruption');
    const expected = data.catalogs[0]!;
    const stored = await repository.getCatalog(expected.name);
    expect(stored).toBeDefined();
    const changed = JSON.parse(expected.protoJson) as Record<string, unknown>;
    changed.displayName = 'operator-conflict';
    await repository.updateCatalog(expected.name, stored!.etag, {
      protoSchema: expected.protoSchema,
      protoJson: JSON.stringify(changed),
    });

    await expect(bootstrapRepository(repository, data)).rejects.toThrow(`Bootstrap catalog conflict: ${expected.name}`);
    expect((await repository.getMeta(repositoryBootstrapMetaKey))?.value).toContain('IN_PROGRESS');
    db.close();
  });

  it('cannot complete when a prospective bootstrap row reaches the D1 safety limit', async () => {
    const { db, repository, data } = await harness();
    const oversized = structuredClone(data);
    const first = oversized.catalogs[0]!;
    const payload = JSON.parse(first.protoJson) as Record<string, unknown>;
    payload.displayName = 'x'.repeat(1_800_000);
    first.protoJson = JSON.stringify(payload);

    await expect(bootstrapRepository(repository, oversized)).rejects.toThrow('limit is 1800000');
    expect((await repository.getMeta(repositoryBootstrapMetaKey))?.value).toContain('IN_PROGRESS');
    expect(await repositoryReadiness(repository, oversized)).toEqual({ ready: false, reason: 'bootstrap is incomplete' });
    db.close();
  });

  it('blocks readiness when a confirmed current pointer loses its sealed bundle', async () => {
    const { db, repository, data } = await harness();
    await bootstrapRepository(repository, data);
    const storedCurrents = await Promise.all(data.currents.map((item) => repository.getCurrent(item.name)));
    const draft = storedCurrents.find((item) => item?.lifecycle === 'DRAFT' && item.currentRevisionName);
    expect(draft?.currentRevisionName).toBeTruthy();
    const proto = JSON.parse(draft!.protoJson) as Record<string, unknown>;
    proto.lifecycle = 'LIFECYCLE_CONFIRMED';
    delete proto.candidateVersionSequence;
    delete proto.candidateVersionLabel;
    delete proto.candidateSourceVersionId;
    const current = await repository.updateCurrent(draft!.name, draft!.etag, {
      protoSchema: draft!.protoSchema,
      protoJson: JSON.stringify(proto),
    });
    await expect(repository.auditProjectionParity()).resolves.toBeUndefined();

    db.exec('DROP TRIGGER SOP_EXPORT_BUNDLES_IMMUTABLE_DELETE');
    db.database.prepare('DELETE FROM SOP_EXPORT_BUNDLES WHERE root_revision_name = ?')
      .run(current.currentRevisionName!);

    await expect(repository.auditProjectionParity()).rejects.toBeInstanceOf(RepositoryNotReadyError);
    expect(await repositoryReadiness(repository, data)).toEqual({
      ready: false,
      reason: 'repository integrity audit failed',
    });
    db.close();
  });

  it('blocks readiness when sealed bundle content no longer matches its stored hash', async () => {
    const { db, repository, data } = await harness();
    await bootstrapRepository(repository, data);
    const row = db.database.prepare(`SELECT root_revision_name, bundle_proto_json
      FROM SOP_EXPORT_BUNDLES LIMIT 1`).get() as {
        root_revision_name: string;
        bundle_proto_json: string;
      } | undefined;
    expect(row).toBeDefined();
    const bundle = JSON.parse(row!.bundle_proto_json) as { content: { rootName: string } };
    bundle.content.rootName = 'taskSops/tampered-after-seal';

    db.exec('DROP TRIGGER SOP_EXPORT_BUNDLES_IMMUTABLE_UPDATE');
    db.database.prepare('UPDATE SOP_EXPORT_BUNDLES SET bundle_proto_json = ? WHERE root_revision_name = ?')
      .run(JSON.stringify(bundle), row!.root_revision_name);

    await expect(repository.auditProjectionParity()).rejects.toBeInstanceOf(RepositoryNotReadyError);
    expect(await repositoryReadiness(repository, data)).toEqual({
      ready: false,
      reason: 'repository integrity audit failed',
    });
    db.close();
  });
});
