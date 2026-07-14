import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createD1ResourceRepository,
  type D1ResourceRepositoryOptions,
} from '../../server/repositories/d1ResourceRepository';
import {
  InvalidCursorError,
  ProjectionMismatchError,
  RepositoryNotReadyError,
  ResourceConflictError,
} from '../../server/domain/repository';
import { SqliteD1 } from '../helpers/sqliteD1';

const migrationSql = readFileSync(new URL('../../migrations/0001_resource_storage.sql', import.meta.url), 'utf8');
const timestamp = '2026-07-14T10:00:00.000Z';

function json(value: unknown): string {
  return JSON.stringify(value);
}

function material(name: string, displayName = name): string {
  return json({
    name: `materials/${name}`,
    uid: `uid-material-${name}`,
    displayName,
    etag: 'client-value-is-not-authoritative',
  });
}

function taskSopDraft(name: string, digest = 'review-digest-1'): string {
  return json({
    name: `taskSops/${name}`,
    uid: `uid-task-${name}`,
    displayName: `Task ${name}`,
    lifecycle: 'LIFECYCLE_DRAFT',
    candidateVersionSequence: '1',
    candidateVersionLabel: '1.0.0',
    candidateSourceVersionId: `legacy-${name}`,
    reviewedDependencyDigest: digest,
    etag: 'client-value-is-not-authoritative',
  });
}

describe('D1 resource repository contract', () => {
  let db: SqliteD1;
  let etagSequence: number;
  let options: D1ResourceRepositoryOptions;

  beforeEach(() => {
    db = new SqliteD1(migrationSql);
    etagSequence = 0;
    options = {
      clock: () => timestamp,
      createEtag: () => `etag-${++etagSequence}`,
    };
  });

  afterEach(() => db.close());

  it('updates exactly one catalog row with a fresh etag and rejects a stale writer', async () => {
    const repository = createD1ResourceRepository(db, options);
    const created = await repository.createCatalog({
      protoSchema: 'coscene.sop.v1alpha1.Material',
      protoJson: material('cup', 'Cup'),
      now: timestamp,
    });
    expect(created.etag).toBe('etag-1');
    expect(JSON.parse(created.protoJson)).toMatchObject({ etag: 'etag-1' });

    const updated = await repository.updateCatalog(created.name, created.etag, {
      protoSchema: created.protoSchema,
      protoJson: material('cup', 'Updated cup'),
      now: timestamp,
    });
    expect(updated).toMatchObject({ displayName: 'Updated cup', etag: 'etag-2' });

    await expect(repository.updateCatalog(created.name, created.etag, {
      protoSchema: created.protoSchema,
      protoJson: material('cup', 'Stale update'),
      now: timestamp,
    })).rejects.toBeInstanceOf(ResourceConflictError);
    await expect(repository.getCatalog(created.name)).resolves.toMatchObject({
      displayName: 'Updated cup',
      etag: 'etag-2',
    });
  });

  it('returns bounded canonical-name summary pages without selecting ProtoJSON', async () => {
    const repository = createD1ResourceRepository(db, options);
    for (const name of ['c', 'a', 'b']) {
      await repository.createCatalog({ protoSchema: 'Material', protoJson: material(name), now: timestamp });
    }

    const first = await repository.listCatalog('MATERIAL', { limit: 2 });
    expect(first.items.map((item) => item.name)).toEqual(['materials/a', 'materials/b']);
    expect(first.nextCursor).toBeTruthy();
    expect(first.items.every((item) => !('protoJson' in item))).toBe(true);

    const second = await repository.listCatalog('MATERIAL', { limit: 2, cursor: first.nextCursor });
    expect(second).toEqual({ items: [expect.objectContaining({ name: 'materials/c' })] });
    await repository.listCatalog('MATERIAL', { limit: 10_000 });
    const listQuery = db.executed.filter((entry) => entry.operation === 'all' && entry.sql.includes('SOP_CATALOG_RESOURCES')).at(-1)!;
    expect(listQuery.sql).not.toContain('proto_json');
    expect(listQuery.values.at(-1)).toBe(201);
    await expect(repository.listCatalog('MATERIAL', { cursor: 'not-a-valid-cursor' }))
      .rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('soft archive removes a catalog row from active pages without deleting it', async () => {
    const repository = createD1ResourceRepository(db, options);
    const created = await repository.createCatalog({ protoSchema: 'Material', protoJson: material('archived') });
    const archived = await repository.archiveCatalog(created.name, created.etag, {
      protoSchema: 'Material',
      protoJson: material('archived'),
    });
    expect(archived.archivedAt).toBe(timestamp);
    await expect(repository.getCatalog(created.name)).resolves.toMatchObject({ archivedAt: timestamp });
    await expect(repository.listCatalog('MATERIAL')).resolves.toMatchObject({ items: [] });
  });

  it('derives all current candidate and review columns from ProtoJSON', async () => {
    const repository = createD1ResourceRepository(db, options);
    const created = await repository.createCurrent({
      protoSchema: 'TaskSop',
      protoJson: taskSopDraft('wash'),
    });
    expect(created).toMatchObject({
      candidateVersionSequence: 1,
      candidateVersionLabel: '1.0.0',
      candidateSourceVersionId: 'legacy-wash',
      reviewedManifestDigest: 'review-digest-1',
    });

    await expect(repository.updateCurrent(created.name, created.etag, {
      protoSchema: 'TaskSop',
      protoJson: taskSopDraft('wash'),
      candidateVersionSequence: 2,
    })).rejects.toBeInstanceOf(ProjectionMismatchError);
  });

  it('atomically replaces the exact reviewed dependency set and updates the Proto digest', async () => {
    const repository = createD1ResourceRepository(db, options);
    const root = await repository.createCurrent({ protoSchema: 'TaskSop', protoJson: taskSopDraft('review') });
    const dependency = await repository.createCatalog({
      protoSchema: 'Material',
      protoJson: material('dependency'),
    });
    const acknowledged = await repository.replaceReviewedDependencies(root.name, root.etag, 'review-digest-2', [{
      rootName: root.name,
      dependencyRole: 'material',
      dependencyName: dependency.name,
      dependencyUid: dependency.uid,
      tokenKind: 'ETAG',
      reviewedToken: dependency.etag,
      createdAt: timestamp,
    }]);

    expect(acknowledged.reviewedManifestDigest).toBe('review-digest-2');
    expect(JSON.parse(acknowledged.protoJson)).toMatchObject({ reviewedDependencyDigest: 'review-digest-2' });
    await expect(repository.loadReviewedDependencies(root.name)).resolves.toEqual([
      expect.objectContaining({ dependencyName: dependency.name, reviewedToken: dependency.etag }),
    ]);
    await expect(repository.replaceReviewedDependencies(root.name, root.etag, 'stale', []))
      .rejects.toBeInstanceOf(ResourceConflictError);
  });

  it('confirms revision, sealed bundle, and current pointer in one idempotent batch', async () => {
    const repository = createD1ResourceRepository(db, options);
    const root = await repository.createCurrent({ protoSchema: 'TaskSop', protoJson: taskSopDraft('confirm') });
    const revisionName = `${root.name}/revisions/1-0-0`;
    const revisionJson = json({
      name: revisionName,
      uid: 'uid-revision-confirm',
      snapshot: {
        name: root.name,
        uid: root.uid,
        displayName: root.displayName,
        lifecycle: 'LIFECYCLE_CONFIRMED',
        currentRevision: revisionName,
        reviewedDependencyDigest: 'review-digest-1',
        etag: root.etag,
      },
      versionLabel: '1.0.0',
      origin: 'REVISION_ORIGIN_RUNTIME_CONFIRMED',
      exportEligible: true,
    });
    const bundleJson = json({
      schemaVersion: '1.0.0',
      contentSizeBytes: 512,
      contentSha256: 'a'.repeat(64),
      content: {
        revisionName,
        rendererVersion: 'renderer-1',
        root: { kind: 'ROOT_KIND_TASK_SOP' },
      },
    });
    const input = {
      commandId: 'confirm-command-1',
      rootName: root.name,
      expectedEtag: root.etag,
      reviewedManifestDigest: 'review-digest-1',
      confirmedRoot: {
        protoSchema: 'TaskSop',
        protoJson: json({
          name: root.name,
          uid: root.uid,
          displayName: root.displayName,
          lifecycle: 'LIFECYCLE_CONFIRMED',
          currentRevision: revisionName,
          reviewedDependencyDigest: 'review-digest-1',
          etag: root.etag,
        }),
      },
      revision: {
        protoSchema: 'TaskSopRevision',
        revisionProtoJson: revisionJson,
        versionSequence: 1,
      },
      bundle: {
        protoSchema: 'ExportBundle',
        bundleProtoJson: bundleJson,
        rootRevisionName: revisionName,
        rootKind: 'TASK_SOP' as const,
        schemaVersion: '1.0.0',
        rendererVersion: 'renderer-1',
        contentSizeBytes: 512,
        contentSha256: 'a'.repeat(64),
      },
    };

    const confirmed = await repository.confirm(input);
    expect(confirmed).toMatchObject({ idempotent: false, root: { lifecycle: 'CONFIRMED' } });
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_CONFIRMATION_COMMANDS').get()).toEqual({ count: 0 });
    const retried = await repository.confirm(input);
    expect(retried).toMatchObject({ idempotent: true, revision: { name: revisionName } });
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_REVISIONS').get()).toEqual({ count: 1 });
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_EXPORT_BUNDLES').get()).toEqual({ count: 1 });
  });

  it('fails closed on direct projection corruption and during readiness audit', async () => {
    const repository = createD1ResourceRepository(db, options);
    const created = await repository.createCatalog({ protoSchema: 'Material', protoJson: material('drift', 'Correct') });
    db.database.prepare('UPDATE SOP_CATALOG_RESOURCES SET display_name = ? WHERE name = ?').run('Corrupt', created.name);
    await expect(repository.getCatalog(created.name)).rejects.toBeInstanceOf(ProjectionMismatchError);
    await expect(repository.auditProjectionParity()).rejects.toBeInstanceOf(ProjectionMismatchError);
  });

  it('exposes compare-and-set metadata and exact readiness assertions', async () => {
    const repository = createD1ResourceRepository(db, options);
    await expect(repository.compareAndSetMeta({ key: 'bootstrap', nextValue: 'EMPTY' })).resolves.toBe(true);
    await expect(repository.compareAndSetMeta({ key: 'bootstrap', nextValue: 'OTHER' })).resolves.toBe(false);
    await expect(repository.compareAndSetMeta({
      key: 'bootstrap',
      expectedValue: 'EMPTY',
      nextValue: 'COMPLETE(dataset-1,v1)',
    })).resolves.toBe(true);
    await expect(repository.assertMeta('bootstrap', 'COMPLETE(dataset-1,v1)')).resolves.toMatchObject({
      value: 'COMPLETE(dataset-1,v1)',
    });
    await expect(repository.assertMeta('bootstrap', 'COMPLETE(dataset-2,v1)'))
      .rejects.toBeInstanceOf(RepositoryNotReadyError);
  });
});
