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
import { DependencyKind } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { bootstrapRepository } from '../../server/bootstrap/repository';
import { prepareRepositoryData } from '../../server/bootstrap/repositoryData';
import {
  acknowledgeRootDependencies,
  confirmRoot,
  DependencyReviewRequiredError,
  reviewRootDependencies,
} from '../../server/domain/services/confirmation';
import { saveRobotModel } from '../../server/domain/services/robotModel';
import { startNextDraft } from '../../server/domain/services/draftLifecycle';
import { ResourceConflictError, type ResourceRepository } from '../../server/domain/repository';
import { decodeExportBundle } from '../../server/export/codec';
import { createD1ResourceRepository } from '../../server/repositories/d1ResourceRepository';
import type { AppData } from '../../shared/transport/restDto';
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
    createEtag: () => `confirmation-etag-${++etag}`,
  });
  const data = prepareRepositoryData(structuredClone(fixtureData));
  await bootstrapRepository(repository, data);
  return { db, repository, data };
}

describe('root-scoped dependency review and confirmation', () => {
  it('requires an exact review, seals one immutable TaskSop bundle, and retries idempotently', async () => {
    const { db, repository, data } = await harness();
    const prepared = data.currents.find((item) => item.candidateVersionSequence !== undefined &&
      item.protoSchema.endsWith('.TaskSop'))!;
    const draft = await repository.getCurrent(prepared.name);
    expect(draft).toMatchObject({ lifecycle: 'DRAFT' });

    const review = await reviewRootDependencies(repository, prepared.name);
    expect(review.empty).toBe(false);
    expect(review.proposal.rootEtag).toBe(draft!.etag);
    expect(review.proposal.dependencies.length).toBeGreaterThan(0);
    await expect(confirmRoot(repository, {
      rootName: prepared.name,
      expectedEtag: draft!.etag,
      commandId: 'confirm-before-review',
    })).rejects.toBeInstanceOf(DependencyReviewRequiredError);

    const acknowledged = await acknowledgeRootDependencies(repository, {
      rootName: prepared.name,
      expectedEtag: draft!.etag,
      proposalDigest: review.digest,
    });
    expect(acknowledged.etag).not.toBe(draft!.etag);
    expect(acknowledged.reviewedManifestDigest).toBe(review.digest);

    const confirmed = await confirmRoot(repository, {
      rootName: prepared.name,
      expectedEtag: acknowledged.etag,
      commandId: 'confirm-after-review',
      now: new Date('2026-07-14T10:30:00.000Z'),
    });
    expect(confirmed).toMatchObject({
      idempotent: false,
      root: { lifecycle: 'CONFIRMED' },
      revision: { exportEligible: true, revisionOrigin: 'RUNTIME_CONFIRMED' },
      bundle: { rootKind: 'TASK_SOP' },
    });
    expect(decodeExportBundle(confirmed.bundle.bundleProtoJson).content?.revisionName)
      .toBe(confirmed.revision.name);
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_CONFIRMATION_COMMANDS').get())
      .toEqual({ count: 0 });

    const retried = await confirmRoot(repository, {
      rootName: prepared.name,
      expectedEtag: acknowledged.etag,
      commandId: 'confirm-after-review',
    });
    expect(retried).toMatchObject({ idempotent: true, revision: { name: confirmed.revision.name } });
    expect(retried.bundle.bundleProtoJson).toBe(confirmed.bundle.bundleProtoJson);
    const nextDraft = await startNextDraft(repository, {
      rootName: prepared.name,
      expectedEtag: confirmed.root.etag,
      now: new Date('2026-07-14T10:45:00.000Z'),
    });
    expect(nextDraft).toMatchObject({
      lifecycle: 'DRAFT',
      currentRevisionName: confirmed.revision.name,
      candidateVersionSequence: confirmed.revision.versionSequence + 1,
    });
    expect(nextDraft.candidateVersionLabel).not.toBe(confirmed.revision.versionLabel);

    const nextReview = await reviewRootDependencies(repository, prepared.name);
    const nextAcknowledged = await acknowledgeRootDependencies(repository, {
      rootName: prepared.name,
      expectedEtag: nextDraft.etag,
      proposalDigest: nextReview.digest,
    });
    const nextConfirmed = await confirmRoot(repository, {
      rootName: prepared.name,
      expectedEtag: nextAcknowledged.etag,
      commandId: 'confirm-next-version',
      now: new Date('2026-07-14T11:00:00.000Z'),
    });
    expect(nextConfirmed.revision.name).not.toBe(confirmed.revision.name);

    await expect(confirmRoot(repository, {
      rootName: prepared.name,
      expectedEtag: acknowledged.etag,
      commandId: 'confirm-after-review',
    })).rejects.toBeInstanceOf(ResourceConflictError);
    await expect(confirmRoot(repository, {
      rootName: prepared.name,
      expectedEtag: nextAcknowledged.etag,
      commandId: 'wrong-confirmation-command',
    })).rejects.toBeInstanceOf(ResourceConflictError);
    await expect(confirmRoot(repository, {
      rootName: prepared.name,
      expectedEtag: nextAcknowledged.etag,
      commandId: 'confirm-next-version',
    })).resolves.toMatchObject({
      idempotent: true,
      revision: { name: nextConfirmed.revision.name },
    });
    db.close();
  });

  it('pins Requirement revision dependencies into a self-contained sealed bundle', async () => {
    const { db, repository, data } = await harness();
    const prepared = data.currents.find((item) => item.name === 'requirements/req-we-home')!;
    const importedDraft = (await repository.getCurrent(prepared.name))!;
    const resource = JSON.parse(importedDraft.protoJson) as {
      spec: { productionItems: Array<{ taskSopRevision: string }> };
    } & Record<string, unknown>;
    const revisions = await Promise.all(resource.spec.productionItems.map((item) =>
      repository.getRevision(item.taskSopRevision)));
    resource.spec.productionItems = resource.spec.productionItems.filter((_item, index) =>
      revisions[index]?.exportEligible);
    const draft = await repository.updateCurrent(importedDraft.name, importedDraft.etag, {
      protoSchema: importedDraft.protoSchema,
      protoJson: JSON.stringify(resource),
    });
    expect(resource.spec.productionItems.length).toBeGreaterThan(0);
    const beforeReviewQueries = db.executed.length;
    const review = await reviewRootDependencies(repository, prepared.name);
    const dependencyReads = db.executed.slice(beforeReviewQueries);
    expect(dependencyReads.filter((entry) => entry.operation === 'all' &&
      entry.sql.includes('FROM SOP_CATALOG_RESOURCES') && entry.sql.includes('json_each(?)'))).toHaveLength(1);
    expect(dependencyReads.filter((entry) => entry.operation === 'all' &&
      entry.sql.includes('FROM SOP_REVISIONS') && entry.sql.includes('json_each(?)'))).toHaveLength(1);
    expect(dependencyReads.some((entry) => entry.operation === 'first' &&
      (entry.sql.includes('FROM SOP_CATALOG_RESOURCES') || entry.sql.includes('FROM SOP_REVISIONS')))).toBe(false);
    expect(review.proposal.dependencies.map((item) => item.kind)).toEqual(expect.arrayContaining([
      DependencyKind.CUSTOMER,
      DependencyKind.ROBOT_MODEL_REVISION,
      DependencyKind.TASK_SOP_REVISION,
    ]));
    const acknowledged = await acknowledgeRootDependencies(repository, {
      rootName: prepared.name,
      expectedEtag: draft.etag,
      proposalDigest: review.digest,
    });
    const confirmed = await confirmRoot(repository, {
      rootName: prepared.name,
      expectedEtag: acknowledged.etag,
      commandId: 'confirm-requirement',
      now: new Date('2026-07-14T11:00:00.000Z'),
    });
    const bundle = decodeExportBundle(confirmed.bundle.bundleProtoJson);
    expect(confirmed.bundle.rootKind).toBe('REQUIREMENT');
    expect(bundle.content?.requirements).toHaveLength(1);
    expect(bundle.content?.taskSops.length).toBeGreaterThan(0);
    expect(bundle.content?.robotModelRevisions).toHaveLength(1);
    expect(bundle.content?.requirements[0]?.source?.uid).toBe(confirmed.root.uid);
    db.close();
  });

  it('rejects 501 direct Requirement dependencies before dependency detail reads', async () => {
    const { db, repository, data } = await harness();
    const prepared = data.currents.find((item) => item.name === 'requirements/req-we-home')!;
    const current = (await repository.getCurrent(prepared.name))!;
    const proto = JSON.parse(current.protoJson) as {
      attachments: string[];
      spec: { productionItems: unknown[] };
    };
    proto.attachments = Array.from({ length: 499 }, (_, index) => `attachments/cap-${index}`);
    proto.spec.productionItems = [];
    const oversized = await repository.updateCurrent(current.name, current.etag, {
      protoSchema: current.protoSchema,
      protoJson: JSON.stringify(proto),
    });
    let catalogReads = 0;
    let revisionReads = 0;
    const counted = {
      ...repository,
      async getCatalogs(...args: Parameters<ResourceRepository['getCatalogs']>) {
        catalogReads += 1;
        return repository.getCatalogs(...args);
      },
      async getRevisions(...args: Parameters<ResourceRepository['getRevisions']>) {
        revisionReads += 1;
        return repository.getRevisions(...args);
      },
    } satisfies ResourceRepository;

    await expect(reviewRootDependencies(counted, oversized.name))
      .rejects.toThrow('Direct dependency limit exceeded: 501 > 500');
    expect(catalogReads).toBe(0);
    expect(revisionReads).toBe(0);
    db.close();
  });

  it.each([
    {
      stage: 'revision insert',
      failure: 'revision',
      sql: `CREATE TRIGGER TEST_FAIL_CONFIRM_REVISION
        BEFORE INSERT ON SOP_REVISIONS
        BEGIN SELECT RAISE(ABORT, 'forced confirmation revision failure'); END`,
    },
    {
      stage: 'bundle insert',
      failure: 'bundle',
      sql: `CREATE TRIGGER TEST_FAIL_CONFIRM_BUNDLE
        BEFORE INSERT ON SOP_EXPORT_BUNDLES
        BEGIN SELECT RAISE(ABORT, 'forced confirmation bundle failure'); END`,
    },
    {
      stage: 'root transition',
      failure: 'root',
      sql: `CREATE TRIGGER TEST_FAIL_CONFIRM_ROOT
        BEFORE UPDATE ON SOP_CURRENT_RESOURCES
        WHEN OLD.lifecycle = 'DRAFT' AND NEW.lifecycle = 'CONFIRMED'
        BEGIN SELECT RAISE(ABORT, 'forced confirmation root failure'); END`,
    },
    {
      stage: 'command cleanup',
      failure: 'cleanup',
      sql: `CREATE TRIGGER TEST_FAIL_CONFIRM_CLEANUP
        BEFORE DELETE ON SOP_CONFIRMATION_COMMANDS
        BEGIN SELECT RAISE(ABORT, 'forced confirmation cleanup failure'); END`,
    },
  ])('rolls back every confirmation fragment when the $stage fails', async ({ stage, failure, sql }) => {
    const { db, repository, data } = await harness();
    const prepared = data.currents.find((item) => item.candidateVersionSequence !== undefined &&
      item.protoSchema.endsWith('.TaskSop'))!;
    const draft = (await repository.getCurrent(prepared.name))!;
    const review = await reviewRootDependencies(repository, prepared.name);
    const acknowledged = await acknowledgeRootDependencies(repository, {
      rootName: prepared.name,
      expectedEtag: draft.etag,
      proposalDigest: review.digest,
    });
    const before = {
      revisions: db.database.prepare('SELECT count(*) AS count FROM SOP_REVISIONS').get(),
      bundles: db.database.prepare('SELECT count(*) AS count FROM SOP_EXPORT_BUNDLES').get(),
      root: await repository.getCurrent(prepared.name),
    };
    db.exec(sql);

    await expect(confirmRoot(repository, {
      rootName: prepared.name,
      expectedEtag: acknowledged.etag,
      commandId: `confirm-failure-${stage.replaceAll(' ', '-')}`,
    })).rejects.toThrow(`forced confirmation ${failure} failure`);

    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_CONFIRMATION_COMMANDS').get())
      .toEqual({ count: 0 });
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_REVISIONS').get())
      .toEqual(before.revisions);
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_EXPORT_BUNDLES').get())
      .toEqual(before.bundles);
    expect(await repository.getCurrent(prepared.name)).toEqual(before.root);
    db.close();
  });

  it('returns the fresh dependency diff when a displayed acknowledgement proposal is stale', async () => {
    const { db, repository, data } = await harness();
    const prepared = data.currents.find((item) => item.candidateVersionSequence !== undefined &&
      item.protoSchema.endsWith('.TaskSop'))!;
    const review = await reviewRootDependencies(repository, prepared.name);
    let dependency;
    for (const item of review.proposal.dependencies) {
      dependency = await repository.getCatalog(item.resourceName);
      if (dependency) break;
    }
    expect(dependency).toBeDefined();
    const value = JSON.parse(dependency!.protoJson) as Record<string, unknown>;
    await repository.updateCatalog(dependency!.name, dependency!.etag, {
      protoSchema: dependency!.protoSchema,
      protoJson: JSON.stringify({ ...value, displayName: `${dependency!.displayName} changed` }),
    });

    const result = acknowledgeRootDependencies(repository, {
      rootName: prepared.name,
      expectedEtag: review.proposal.rootEtag,
      proposalDigest: review.digest,
    });
    await expect(result).rejects.toBeInstanceOf(DependencyReviewRequiredError);
    await expect(result).rejects.toMatchObject({
      diff: {
        digest: expect.not.stringMatching(`^${review.digest}$`),
        proposal: {
          rootName: prepared.name,
          rootEtag: review.proposal.rootEtag,
          dependencies: expect.arrayContaining([expect.objectContaining({ resourceName: dependency!.name })]),
        },
      },
    });
    db.close();
  });

  it('maps dependency drift inside acknowledgement and confirmation commits to a fresh diff', async () => {
    const { db, repository, data } = await harness();
    const prepared = data.currents.find((item) => item.candidateVersionSequence !== undefined &&
      item.protoSchema.endsWith('.TaskSop'))!;
    const initialReview = await reviewRootDependencies(repository, prepared.name);
    let dependency;
    for (const item of initialReview.proposal.dependencies) {
      dependency = await repository.getCatalog(item.resourceName);
      if (dependency) break;
    }
    expect(dependency).toBeDefined();
    let change = 0;
    const mutateDependency = async () => {
      const current = (await repository.getCatalog(dependency!.name))!;
      const value = JSON.parse(current.protoJson) as Record<string, unknown>;
      dependency = await repository.updateCatalog(current.name, current.etag, {
        protoSchema: current.protoSchema,
        protoJson: JSON.stringify({ ...value, displayName: `${current.displayName} race ${++change}` }),
      });
    };

    const acknowledgementRace = {
      ...repository,
      async replaceReviewedDependencies(...args: Parameters<ResourceRepository['replaceReviewedDependencies']>) {
        await mutateDependency();
        return repository.replaceReviewedDependencies(...args);
      },
    } satisfies ResourceRepository;
    await expect(acknowledgeRootDependencies(acknowledgementRace, {
      rootName: prepared.name,
      expectedEtag: initialReview.proposal.rootEtag,
      proposalDigest: initialReview.digest,
    })).rejects.toMatchObject({
      diff: {
        proposal: {
          dependencies: expect.arrayContaining([expect.objectContaining({ resourceName: dependency!.name })]),
        },
      },
    });

    const freshReview = await reviewRootDependencies(repository, prepared.name);
    const acknowledged = await acknowledgeRootDependencies(repository, {
      rootName: prepared.name,
      expectedEtag: freshReview.proposal.rootEtag,
      proposalDigest: freshReview.digest,
    });
    const historyBefore = await repository.listRevisions(prepared.name, { limit: 200 });
    const confirmationRace = {
      ...repository,
      async confirm(...args: Parameters<ResourceRepository['confirm']>) {
        await mutateDependency();
        return repository.confirm(...args);
      },
    } satisfies ResourceRepository;
    await expect(confirmRoot(confirmationRace, {
      rootName: prepared.name,
      expectedEtag: acknowledged.etag,
      commandId: 'confirm-dependency-race',
    })).rejects.toMatchObject({
      diff: { changed: expect.arrayContaining([expect.objectContaining({ resourceName: dependency!.name })]) },
    });
    expect((await repository.listRevisions(prepared.name, { limit: 200 })).items)
      .toHaveLength(historyBefore.items.length);
    expect((await repository.getCurrent(prepared.name))!.lifecycle).toBe('DRAFT');
    db.close();
  });

  it('updates one RobotModel and appends its immutable revision atomically', async () => {
    const { db, repository, data } = await harness();
    const prepared = data.currents.find((item) => item.protoSchema.endsWith('.RobotModel'))!;
    const before = (await repository.getCurrent(prepared.name))!;
    const historyBefore = await repository.listRevisions(prepared.name, { limit: 200 });
    const resource = JSON.parse(before.protoJson) as Record<string, unknown>;
    resource.displayName = 'Updated robot model';

    const saved = await saveRobotModel(repository, {
      rootName: before.name,
      expectedEtag: before.etag,
      resourceProtoJson: JSON.stringify(resource),
      now: new Date('2026-07-14T12:00:00.000Z'),
    });
    expect(saved).toMatchObject({
      idempotent: false,
      root: { displayName: 'Updated robot model' },
      revision: { kind: 'ROBOT_MODEL_REVISION', exportEligible: false },
    });
    expect(saved.root.currentRevisionName).toBe(saved.revision.name);
    expect((await repository.listRevisions(prepared.name, { limit: 200 })).items)
      .toHaveLength(historyBefore.items.length + 1);

    await expect(saveRobotModel(repository, {
      rootName: before.name,
      expectedEtag: before.etag,
      resourceProtoJson: JSON.stringify(resource),
    })).rejects.toMatchObject({ code: 'STALE_ETAG' });
    expect((await repository.listRevisions(prepared.name, { limit: 200 })).items)
      .toHaveLength(historyBefore.items.length + 1);
    db.close();
  });

  it('rejects one of two concurrent RobotModel writers with different content', async () => {
    const { db, repository, data } = await harness();
    const prepared = data.currents.find((item) => item.protoSchema.endsWith('.RobotModel'))!;
    const before = (await repository.getCurrent(prepared.name))!;
    const historyBefore = await repository.listRevisions(prepared.name, { limit: 200 });
    const resource = JSON.parse(before.protoJson) as Record<string, unknown>;
    const write = (displayName: string) => saveRobotModel(repository, {
      rootName: before.name,
      expectedEtag: before.etag,
      resourceProtoJson: JSON.stringify({ ...resource, displayName }),
      now: new Date('2026-07-14T12:30:00.000Z'),
    });

    const results = await Promise.allSettled([
      write('Concurrent robot A'),
      write('Concurrent robot B'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ResourceConflictError);
    const after = (await repository.getCurrent(before.name))!;
    expect(['Concurrent robot A', 'Concurrent robot B']).toContain(after.displayName);
    expect((await repository.listRevisions(before.name, { limit: 200 })).items)
      .toHaveLength(historyBefore.items.length + 1);
    db.close();
  });
});
