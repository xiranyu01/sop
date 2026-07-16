import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createD1ResourceRepository,
  PROJECTION_AUDIT_PAGE_SIZE,
  type D1ResourceRepositoryOptions,
} from '../../server/repositories/d1ResourceRepository';
import {
  InvalidCursorError,
  ProjectionMismatchError,
  RepositoryNotReadyError,
  ResourceConflictError,
} from '../../server/domain/repository';
import { ROW_SIZE_REJECTION_BYTES } from '../../server/domain/rowSize';
import { createRobotModel } from '../../server/domain/services/robotModel';
import { SqliteD1 } from '../helpers/sqliteD1';
import { resourceStorageMigrationsSql } from '../helpers/resourceStorageMigrations';

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

function taskSopRevision(
  owner: { name: string; uid: string },
  revisionId: string,
  versionLabel: string,
  previousRevision?: string,
): string {
  const name = `${owner.name}/revisions/${revisionId}`;
  return json({
    name,
    uid: `uid-revision-${revisionId}`,
    snapshot: {
      name: owner.name,
      uid: owner.uid,
      displayName: `Task ${owner.name}`,
      scene: 'scenes/revision-order',
      lifecycle: 'LIFECYCLE_CONFIRMED',
      currentRevision: name,
      etag: `snapshot-etag-${revisionId}`,
    },
    previousRevision,
    versionLabel,
    origin: 'REVISION_ORIGIN_RUNTIME_CONFIRMED',
    exportEligible: true,
  });
}

describe('D1 resource repository contract', () => {
  let db: SqliteD1;
  let etagSequence: number;
  let options: D1ResourceRepositoryOptions;

  beforeEach(() => {
    db = new SqliteD1(resourceStorageMigrationsSql);
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

  it('returns bounded creation-time summary pages without selecting ProtoJSON', async () => {
    const repository = createD1ResourceRepository(db, options);
    for (const { name, createdAt } of [
      { name: 'c', createdAt: timestamp },
      { name: 'a', createdAt: '2026-07-14T11:00:00.000Z' },
      { name: 'b', createdAt: '2026-07-14T11:00:00.000Z' },
    ]) {
      await repository.createCatalog({ protoSchema: 'Material', protoJson: material(name), now: createdAt });
    }

    const first = await repository.listCatalog('MATERIAL', { limit: 2 });
    expect(first.items.map((item) => item.name)).toEqual(['materials/a', 'materials/b']);
    expect(first.items.map((item) => item.createdAt)).toEqual([
      '2026-07-14T11:00:00.000Z',
      '2026-07-14T11:00:00.000Z',
    ]);
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

  it('includes the current revision name in current-resource summaries', async () => {
    const repository = createD1ResourceRepository(db, options);
    const created = await createRobotModel(repository, {
      resourceProtoJson: json({
        name: 'robotModels/robot-a',
        uid: '11111111-1111-4111-8111-111111111111',
        displayName: 'Robot A',
      }),
      now: new Date(timestamp),
    });

    await expect(repository.listCurrent('ROBOT_MODEL')).resolves.toMatchObject({
      items: [{
        name: 'robotModels/robot-a',
        currentRevisionName: created.revision.name,
      }],
    });
    const listQuery = db.executed.filter((entry) => entry.operation === 'all' &&
      entry.sql.includes('SOP_CURRENT_RESOURCES')).at(-1)!;
    expect(listQuery.sql).not.toContain('proto_json');
    await expect(repository.getCurrents(['robotModels/robot-a', 'robotModels/robot-a'])).resolves.toEqual([
      expect.objectContaining({ name: 'robotModels/robot-a', protoJson: expect.any(String) }),
    ]);
  });

  it('returns bounded requirement list fields without returning ProtoJSON', async () => {
    const repository = createD1ResourceRepository(db, options);
    await repository.createCurrent({
      protoSchema: 'coscene.sop.v1alpha1.Requirement',
      protoJson: json({
        name: 'requirements/summary-a',
        uid: '22222222-2222-4222-8222-222222222222',
        displayName: 'Summary A',
        lifecycle: 'LIFECYCLE_DRAFT',
        candidateVersionSequence: '3',
        candidateVersionLabel: '1.2.0',
        spec: {
          customer: 'customers/acme',
          robotModelRevision: 'robotModels/robot-a/revisions/current',
          projectDisplayName: 'Project A',
          deadline: { year: 2026, month: 9, day: 30 },
          aggregateTarget: { duration: '5400s' },
          productionItems: [{
            id: 'item-1',
            displayName: 'Item 1',
            taskSopRevision: 'taskSops/task-a/revisions/v-1-0-0',
          }],
        },
      }),
      now: timestamp,
    });

    const page = await repository.listCurrent('REQUIREMENT');
    expect(page.items).toEqual([expect.objectContaining({
      name: 'requirements/summary-a',
      candidateVersionLabel: '1.2.0',
      customerName: 'customers/acme',
      projectDisplayName: 'Project A',
      deadline: '2026-09-30',
      productionItemCount: 1,
      aggregateDuration: '5400s',
    })]);
    const listQuery = db.executed.filter((entry) => entry.operation === 'all' &&
      entry.sql.includes('SOP_CURRENT_RESOURCES')).at(-1)!;
    expect(listQuery.sql).not.toContain('proto_json');
    expect(page.items.every((item) => !('protoJson' in item))).toBe(true);
  });

  it('bulk-reads distinct catalog details through one fixed-shape JSON bind', async () => {
    const repository = createD1ResourceRepository(db, options);
    for (const name of ['c', 'a', 'b']) {
      await repository.createCatalog({ protoSchema: 'Material', protoJson: material(name) });
    }
    const before = db.executed.length;

    const loaded = await repository.getCatalogs(['materials/c', 'materials/a', 'materials/c']);

    expect(loaded.map((item) => item.name)).toEqual(['materials/a', 'materials/c']);
    const queries = db.executed.slice(before).filter((entry) => entry.operation === 'all');
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('json_each(?)');
    expect(queries[0].values).toEqual([JSON.stringify(['materials/a', 'materials/c'])]);
    await expect(repository.getCatalogs(Array.from({ length: 501 }, (_, index) => `materials/${index}`)))
      .rejects.toThrow('Bulk resource read limit exceeded: 501 > 500');
  });

  it('rejects an oversized catalog update before SQL and preserves the stored row', async () => {
    const repository = createD1ResourceRepository(db, options);
    const created = await repository.createCatalog({
      protoSchema: 'Material',
      protoJson: material('row-limit', 'Safe value'),
    });
    const before = db.executed.length;

    await expect(repository.updateCatalog(created.name, created.etag, {
      protoSchema: created.protoSchema,
      protoJson: material('row-limit', 'x'.repeat(ROW_SIZE_REJECTION_BYTES)),
    })).rejects.toThrow('limit is 1800000');

    expect(db.executed.slice(before).some((entry) => entry.sql.includes('UPDATE SOP_CATALOG_RESOURCES'))).toBe(false);
    await expect(repository.getCatalog(created.name)).resolves.toMatchObject({
      displayName: 'Safe value',
      etag: created.etag,
    });
  });

  it('pages revisions by version sequence even when revision names sort differently', async () => {
    const repository = createD1ResourceRepository(db, options);
    const root = await repository.createCurrent({
      protoSchema: 'TaskSop',
      protoJson: taskSopDraft('revision-order'),
    });
    const revisions = [
      { id: 'z-first-by-sequence', sequence: 1, version: '1.0.0' },
      { id: 'a-second-by-sequence', sequence: 2, version: '1.0.1' },
      { id: 'm-third-by-sequence', sequence: 3, version: '1.0.2' },
    ];
    let previousRevision: string | undefined;
    for (const revision of revisions) {
      const revisionProtoJson = taskSopRevision(root, revision.id, revision.version, previousRevision);
      await repository.createRevision({
        protoSchema: 'TaskSopRevision',
        revisionProtoJson,
        versionSequence: revision.sequence,
      });
      previousRevision = `${root.name}/revisions/${revision.id}`;
    }

    const first = await repository.listRevisions(root.name, { limit: 1 });
    expect(first.items).toEqual([
      expect.objectContaining({ name: `${root.name}/revisions/z-first-by-sequence`, versionSequence: 1 }),
    ]);
    expect(first.nextCursor).toBeTruthy();

    const second = await repository.listRevisions(root.name, { limit: 1, cursor: first.nextCursor });
    expect(second.items).toEqual([
      expect.objectContaining({ name: `${root.name}/revisions/a-second-by-sequence`, versionSequence: 2 }),
    ]);
    expect(second.nextCursor).toBeTruthy();

    const third = await repository.listRevisions(root.name, { limit: 1, cursor: second.nextCursor });
    expect(third).toEqual({
      items: [expect.objectContaining({
        name: `${root.name}/revisions/m-third-by-sequence`,
        versionSequence: 3,
      })],
    });
    const listQuery = db.executed.filter((entry) => entry.operation === 'all'
      && entry.sql.includes('FROM SOP_REVISIONS WHERE owner_name')).at(-1)!;
    expect(listQuery.sql).toContain('ORDER BY version_sequence ASC, name ASC');

    const beforeBulk = db.executed.length;
    const loaded = await repository.getRevisions([
      `${root.name}/revisions/m-third-by-sequence`,
      `${root.name}/revisions/z-first-by-sequence`,
    ]);
    expect(loaded.map((item) => item.name)).toEqual([
      `${root.name}/revisions/m-third-by-sequence`,
      `${root.name}/revisions/z-first-by-sequence`,
    ]);
    const bulkQuery = db.executed.slice(beforeBulk).filter((entry) => entry.operation === 'all');
    expect(bulkQuery).toHaveLength(1);
    expect(bulkQuery[0].sql).toContain('json_each(?)');
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

  it('rolls back dependency acknowledgement when a displayed token changed', async () => {
    const repository = createD1ResourceRepository(db, options);
    const root = await repository.createCurrent({ protoSchema: 'TaskSop', protoJson: taskSopDraft('review-race') });
    const dependency = await repository.createCatalog({
      protoSchema: 'Material',
      protoJson: material('review-race-dependency'),
    });
    await repository.updateCatalog(dependency.name, dependency.etag, {
      protoSchema: dependency.protoSchema,
      protoJson: material('review-race-dependency', 'Changed after proposal'),
    });

    await expect(repository.replaceReviewedDependencies(root.name, root.etag, 'review-race-digest', [{
      rootName: root.name,
      dependencyRole: 'material',
      dependencyName: dependency.name,
      dependencyUid: dependency.uid,
      tokenKind: 'ETAG',
      reviewedToken: dependency.etag,
      createdAt: timestamp,
    }])).rejects.toThrow('dependency guard: stale etag token');

    await expect(repository.getCurrent(root.name)).resolves.toMatchObject({ etag: root.etag });
    await expect(repository.loadReviewedDependencies(root.name)).resolves.toEqual([]);
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

    const oversized = structuredClone(input);
    const oversizedBundle = JSON.parse(oversized.bundle.bundleProtoJson) as {
      content: { root: { ref?: string } };
    };
    oversizedBundle.content.root.ref = 'x'.repeat(ROW_SIZE_REJECTION_BYTES);
    oversized.bundle.bundleProtoJson = JSON.stringify(oversizedBundle);
    await expect(repository.confirm(oversized)).rejects.toThrow('limit is 1800000');
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_CONFIRMATION_COMMANDS').get()).toEqual({ count: 0 });
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_REVISIONS').get()).toEqual({ count: 0 });
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_EXPORT_BUNDLES').get()).toEqual({ count: 0 });
    await expect(repository.getCurrent(root.name)).resolves.toMatchObject({ lifecycle: 'DRAFT', etag: root.etag });

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

  it('audits Proto payloads in explicit bounded pages', async () => {
    const repository = createD1ResourceRepository(db, options);
    for (let index = 0; index < PROJECTION_AUDIT_PAGE_SIZE + 1; index += 1) {
      await repository.createCatalog({
        protoSchema: 'Material',
        protoJson: material(`audit-page-${String(index).padStart(2, '0')}`),
      });
    }
    db.executed.length = 0;

    await repository.auditProjectionParity();

    const payloadQueries = db.executed.filter((entry) =>
      entry.operation === 'all' && /(?:proto_json|revision_proto_json|bundle_proto_json)/u.test(entry.sql));
    expect(payloadQueries.length).toBeGreaterThan(4);
    expect(payloadQueries.every((entry) => entry.sql.includes('ORDER BY') && entry.sql.includes('LIMIT ?'))).toBe(true);
    expect(payloadQueries.every((entry) => entry.values.at(-1) === PROJECTION_AUDIT_PAGE_SIZE)).toBe(true);
    expect(payloadQueries.filter((entry) => entry.sql.includes('SOP_CATALOG_RESOURCES'))).toHaveLength(2);
  });

  it('fails closed when an optional physical projection remains populated after Proto omits it', async () => {
    const repository = createD1ResourceRepository(db, options);
    const created = await repository.createCatalog({ protoSchema: 'Material', protoJson: material('stale-sku') });
    db.database.prepare('UPDATE SOP_CATALOG_RESOURCES SET sku = ? WHERE name = ?')
      .run('stale-physical-value', created.name);

    await expect(repository.getCatalog(created.name)).rejects.toMatchObject({
      fields: ['sku'],
    });
    await expect(repository.auditProjectionParity()).rejects.toMatchObject({
      fields: ['sku'],
    });
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
