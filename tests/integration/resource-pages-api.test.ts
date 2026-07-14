import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrapRepository } from '../../server/bootstrap/repository';
import { prepareRepositoryData } from '../../server/bootstrap/repositoryData';
import { repositoryBootstrapMarkerValue } from '../../server/bootstrap/status';
import { handleResourceApiRequest } from '../../server/http/resourceApi';
import { createD1ResourceRepository } from '../../server/repositories/d1ResourceRepository';
import { seedData } from '../e2e/fixtures/seed';
import { SqliteD1 } from '../helpers/sqliteD1';

async function harness() {
  const migration = await readFile(resolve('migrations/0001_resource_storage.sql'), 'utf8');
  const db = new SqliteD1(migration);
  let etag = 0;
  const repository = createD1ResourceRepository(db, {
    clock: () => '2026-07-14T10:00:00.000Z',
    createEtag: () => `api-etag-${++etag}`,
  });
  const data = prepareRepositoryData(structuredClone(seedData));
  await bootstrapRepository(repository, data);
  const expectedBootstrapMarker = repositoryBootstrapMarkerValue('COMPLETE', data);
  const request = (path: string, init?: RequestInit) => handleResourceApiRequest(
    new Request(`https://sop.test${path}`, init),
    repository,
    { expectedBootstrapMarker, requestId: 'request-1' },
  );
  return { db, repository, data, request, expectedBootstrapMarker };
}

describe('Pages resource API adapter', () => {
  it('pages summaries, fetches one detail, and returns only the mutated resource with its fresh etag', async () => {
    const { db, repository, data, request } = await harness();
    const source = data.catalogs.find((item) => item.protoSchema.endsWith('.Material'))!;

    const list = await request('/api/resources/materials?pageSize=1');
    expect(list.status).toBe(200);
    const page = await list.json() as { items: Array<Record<string, unknown>>; nextCursor?: string };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).not.toHaveProperty('resource');
    expect(page.items[0]).not.toHaveProperty('protoJson');

    const detailResponse = await request(`/api/resources/materials/${encodeURIComponent(source.name)}`);
    const detail = await detailResponse.json() as { name: string; etag: string; resource: Record<string, unknown> };
    expect(detailResponse.status).toBe(200);
    expect(detail).toMatchObject({ name: source.name, resource: { name: source.name } });

    const changed = {
      ...detail.resource,
      name: 'materials/client-forged',
      uid: 'not-a-uuid',
      sourceId: { forged: true },
      createTime: 'not-a-time',
      updateTime: 'not-a-time',
      etag: 'client-forged-etag',
      displayName: 'API updated material',
    };
    const update = await request(`/api/resources/materials/${encodeURIComponent(source.name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: changed, expectedEtag: detail.etag }),
    });
    expect(update.status).toBe(200);
    const result = await update.json() as {
      resource: { name: string; uid: string; etag: string; resource: Record<string, unknown> };
    };
    expect(result).toEqual(expect.objectContaining({
      resource: expect.objectContaining({
        name: source.name,
        etag: expect.not.stringMatching(`^${detail.etag}$`),
        resource: expect.objectContaining({
          name: detail.resource.name,
          uid: detail.resource.uid,
          sourceId: detail.resource.sourceId,
          displayName: 'API updated material',
        }),
      }),
    }));
    expect(result.resource.resource.createTime).toBe(detail.resource.createTime);
    expect(result.resource.resource.updateTime).not.toBe('not-a-time');
    expect(result.resource.resource.etag).toBe(result.resource.etag);
    expect(result.resource.resource.etag).not.toBe('client-forged-etag');
    await expect(repository.getCatalog('materials/client-forged')).resolves.toBeUndefined();
    expect(result).not.toHaveProperty('items');
    expect(result).not.toHaveProperty('resources');

    const createdResponse = await request('/api/resources/materials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: { displayName: 'Created by API', sourceId: 'api-created' } }),
    });
    expect(createdResponse.status).toBe(201);
    await expect(createdResponse.json()).resolves.toMatchObject({
      resource: {
        name: 'materials/api-created',
        uid: expect.stringMatching(/^[a-f0-9-]{36}$/),
        etag: expect.any(String),
        resource: {
          name: 'materials/api-created',
          uid: expect.stringMatching(/^[a-f0-9-]{36}$/),
          displayName: 'Created by API',
          sourceId: 'api-created',
          createTime: expect.any(String),
          updateTime: expect.any(String),
          etag: expect.any(String),
        },
      },
    });

    const forgedIdentity = await request('/api/resources/materials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: {
        name: 'materials/client-owned',
        uid: '00000000-0000-4000-8000-000000000999',
        displayName: 'Forbidden identity',
      } }),
    });
    expect(forgedIdentity.status).toBe(400);
    await expect(forgedIdentity.json()).resolves.toMatchObject({ error: { kind: 'VALIDATION' } });

    const forgedTimestamp = await request('/api/resources/materials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: {
        displayName: 'Forbidden timestamp',
        sourceId: 'client-timestamp',
        createTime: '2000-01-01T00:00:00Z',
      } }),
    });
    expect(forgedTimestamp.status).toBe(400);
    await expect(forgedTimestamp.json()).resolves.toMatchObject({ error: { kind: 'VALIDATION' } });
    await expect(repository.getCatalog('materials/client-timestamp')).resolves.toBeUndefined();

    const stale = await request(`/api/resources/materials/${encodeURIComponent(source.name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: changed, expectedEtag: detail.etag }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { kind: 'STALE_RESOURCE', details: { resourceName: source.name, actualEtag: result.resource.etag } },
    });
    db.close();
  });

  it('returns query-critical catalog and current fields directly in summary pages', async () => {
    const { db, data, request } = await harness();
    const material = data.catalogs.find((item) => item.protoSchema.endsWith('.Material'))!;
    const globalField = data.catalogs.find((item) => item.protoSchema.endsWith('.GlobalField'))!;
    const taskSop = data.currents.find((item) => item.protoSchema.endsWith('.TaskSop'))!;
    const requirement = data.currents.find((item) => item.protoSchema.endsWith('.Requirement'))!;
    const materialResource = JSON.parse(material.protoJson) as { sourceId: string; sku: string };
    const globalFieldResource = JSON.parse(globalField.protoJson) as { group: string; status: string };
    const taskSopResource = JSON.parse(taskSop.protoJson) as { sourceId: string; scene: string };
    const requirementResource = JSON.parse(requirement.protoJson) as {
      spec: { customer: string; robotModelRevision: string };
    };

    const fetchSummary = async (kind: string, name: string): Promise<Record<string, unknown>> => {
      const response = await request(`/api/resources/${kind}?pageSize=200`);
      expect(response.status).toBe(200);
      const page = await response.json() as { items: Array<Record<string, unknown>> };
      const summary = page.items.find((item) => item.name === name);
      expect(summary, `${kind} summary ${name}`).toBeDefined();
      expect(summary).not.toHaveProperty('resource');
      expect(summary).not.toHaveProperty('protoJson');
      return summary!;
    };

    await expect(fetchSummary('materials', material.name)).resolves.toMatchObject({
      sourceId: materialResource.sourceId,
      sku: materialResource.sku,
    });
    await expect(fetchSummary('globalFields', globalField.name)).resolves.toMatchObject({
      fieldGroup: globalFieldResource.group,
      fieldStatus: globalFieldResource.status,
    });
    await expect(fetchSummary('taskSops', taskSop.name)).resolves.toMatchObject({
      sourceId: taskSopResource.sourceId,
      sceneName: taskSopResource.scene,
    });
    await expect(fetchSummary('requirements', requirement.name)).resolves.toMatchObject({
      customerName: requirementResource.spec.customer,
      robotModelRevisionName: requirementResource.spec.robotModelRevision,
    });
    db.close();
  });

  it('keeps draft identity, lifecycle, version, review, and timestamps server-owned on ordinary PUT', async () => {
    const { db, data, request } = await harness();
    const requirement = data.currents.find((item) => item.protoSchema.endsWith('.Requirement'))!;
    const detailResponse = await request(`/api/resources/requirements/${encodeURIComponent(requirement.name)}`);
    const detail = await detailResponse.json() as {
      etag: string;
      resource: Record<string, unknown>;
    };
    const authoritative = detail.resource;
    const forged = {
      ...authoritative,
      name: 'requirements/client-forged',
      uid: '00000000-0000-4000-8000-000000000999',
      sourceId: 'client-forged-source',
      lifecycle: 'LIFECYCLE_DRAFT',
      currentRevision: `${requirement.name}/revisions/client-forged`,
      candidateVersionSequence: '999',
      candidateVersionLabel: '9.9.9',
      candidateSourceVersionId: 'client-forged-version',
      reviewedDependencyDigest: 'f'.repeat(64),
      createTime: '2000-01-01T00:00:00Z',
      updateTime: '2000-01-01T00:00:00Z',
      etag: 'client-forged-etag',
      displayName: 'Business field update survives',
    };

    const updateResponse = await request(
      `/api/resources/requirements/${encodeURIComponent(requirement.name)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedEtag: detail.etag, resource: forged }),
      },
    );
    expect(updateResponse.status).toBe(200);
    const updated = await updateResponse.json() as { resource: { resource: Record<string, unknown> } };
    expect(updated.resource.resource).toMatchObject({
      name: authoritative.name,
      uid: authoritative.uid,
      sourceId: authoritative.sourceId,
      lifecycle: authoritative.lifecycle,
      candidateVersionSequence: authoritative.candidateVersionSequence,
      candidateVersionLabel: authoritative.candidateVersionLabel,
      displayName: 'Business field update survives',
    });
    expect(updated.resource.resource.currentRevision).toBe(authoritative.currentRevision);
    expect(updated.resource.resource.candidateSourceVersionId).toBe(authoritative.candidateSourceVersionId);
    expect(updated.resource.resource.reviewedDependencyDigest).toBe(authoritative.reviewedDependencyDigest);
    expect(updated.resource.resource.createTime).toBe(authoritative.createTime);
    expect(updated.resource.resource.updateTime).not.toBe('2000-01-01T00:00:00Z');
    expect(updated.resource.resource.etag).not.toBe('client-forged-etag');
    db.close();
  });

  it('reviews, acknowledges, and atomically confirms one root through the public resource routes', async () => {
    const { db, repository, data, request } = await harness();
    const requirement = data.currents.find((item) => item.protoSchema.endsWith('.Requirement'))!;
    const detailResponse = await request(`/api/resources/requirements/${encodeURIComponent(requirement.name)}`);
    const detail = await detailResponse.json() as { etag: string };

    const reviewResponse = await request(
      `/api/resources/requirements/${encodeURIComponent(requirement.name)}/review-proposal`,
      { method: 'POST' },
    );
    expect(reviewResponse.status).toBe(200);
    const review = await reviewResponse.json() as { proposalDigest: string; rootEtag: string; dependencies: unknown[] };
    expect(review).toMatchObject({ rootEtag: detail.etag, proposalDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(review.dependencies.length).toBeGreaterThan(0);

    const blocked = await request(
      `/api/resources/requirements/${encodeURIComponent(requirement.name)}/confirmations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedEtag: detail.etag }),
      },
    );
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { kind: 'DEPENDENCY_CHANGED', details: { dependencyDiff: { proposalDigest: review.proposalDigest } } },
    });

    const acknowledgedResponse = await request(
      `/api/resources/requirements/${encodeURIComponent(requirement.name)}/review-acknowledgements`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedEtag: detail.etag, proposalDigest: review.proposalDigest }),
      },
    );
    expect(acknowledgedResponse.status).toBe(200);
    const acknowledged = await acknowledgedResponse.json() as { resource: { etag: string } };
    expect(acknowledged.resource.etag).not.toBe(detail.etag);

    const confirmationResponse = await request(
      `/api/resources/requirements/${encodeURIComponent(requirement.name)}/confirmations`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedEtag: acknowledged.resource.etag }),
      },
    );
    expect(confirmationResponse.status).toBe(200);
    const confirmation = await confirmationResponse.json() as {
      resource: { lifecycle: string; name: string; etag: string; resource: Record<string, unknown> };
      revision: { name: string; exportEligible: boolean };
      exportPath: string;
      idempotent: boolean;
    };
    expect(confirmation).toMatchObject({
      resource: { name: requirement.name, lifecycle: 'CONFIRMED' },
      revision: { exportEligible: true },
      idempotent: false,
    });
    expect(confirmation.exportPath).toBe(`/api/revisions/${encodeURIComponent(confirmation.revision.name)}/export.yaml`);
    const exported = await request(confirmation.exportPath);
    expect(exported.status).toBe(200);
    expect(await exported.text()).toContain('root_uid:');

    const nextDraftResponse = await request(
      `/api/resources/requirements/${encodeURIComponent(requirement.name)}/drafts`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedEtag: confirmation.resource.etag }),
      },
    );
    expect(nextDraftResponse.status).toBe(200);
    const nextDraft = await nextDraftResponse.json() as {
      resource: { etag: string; lifecycle: string; currentRevision: string; resource: Record<string, unknown> };
    };
    expect(nextDraft).toMatchObject({
      resource: {
        lifecycle: 'DRAFT',
        currentRevision: confirmation.revision.name,
        resource: {
          lifecycle: 'LIFECYCLE_DRAFT',
          candidateVersionLabel: '0.0.2',
        },
      },
    });

    const revisionCount = (await repository.listRevisions(requirement.name, { limit: 200 })).items.length;
    const discardResponse = await request(
      `/api/resources/requirements/${encodeURIComponent(requirement.name)}/drafts`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedEtag: nextDraft.resource.etag }),
      },
    );
    expect(discardResponse.status).toBe(200);
    await expect(discardResponse.json()).resolves.toMatchObject({
      resource: {
        lifecycle: 'CONFIRMED',
        currentRevision: confirmation.revision.name,
        archived: false,
        resource: {
          lifecycle: 'LIFECYCLE_CONFIRMED',
          currentRevision: confirmation.revision.name,
        },
      },
    });
    expect((await repository.listRevisions(requirement.name, { limit: 200 })).items).toHaveLength(revisionCount);
    expect(await repository.getExportBundle(confirmation.revision.name)).toBeDefined();
    db.close();
  });

  it('soft-archives an initial draft when there is no confirmed revision to restore', async () => {
    const { db, data, request } = await harness();
    const source = data.currents.find((item) => item.protoSchema.endsWith('.Requirement'))!;
    const sourceDetailResponse = await request(`/api/resources/requirements/${encodeURIComponent(source.name)}`);
    const sourceDetail = await sourceDetailResponse.json() as { resource: Record<string, unknown> };
    const resource = structuredClone(sourceDetail.resource);
    for (const field of [
      'name', 'uid', 'etag', 'currentRevision', 'candidateVersionSequence',
      'candidateVersionLabel', 'candidateSourceVersionId', 'reviewedDependencyDigest',
      'createTime', 'updateTime',
    ]) delete resource[field];
    resource.sourceId = 'discard-initial-draft';
    resource.displayName = 'Discard initial draft';
    resource.lifecycle = 'LIFECYCLE_DRAFT';

    const createResponse = await request('/api/resources/requirements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      resource: { name: string; etag: string; currentRevision?: string };
    };
    expect(created.resource.currentRevision).toBeUndefined();

    const discardResponse = await request(
      `/api/resources/requirements/${encodeURIComponent(created.resource.name)}/drafts`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedEtag: created.resource.etag }),
      },
    );
    expect(discardResponse.status).toBe(200);
    await expect(discardResponse.json()).resolves.toMatchObject({
      resource: {
        name: created.resource.name,
        lifecycle: 'ARCHIVED',
        archived: true,
        resource: { lifecycle: 'LIFECYCLE_ARCHIVED' },
      },
    });

    const pageResponse = await request('/api/resources/requirements?pageSize=200');
    const page = await pageResponse.json() as { items: Array<{ name: string }> };
    expect(page.items).not.toContainEqual(expect.objectContaining({ name: created.resource.name }));
    db.close();
  });

  it('returns revision summaries, one revision detail, and YAML only from its sealed bundle', async () => {
    const { db, data, request } = await harness();
    const task = data.currents.find((item) => item.protoSchema.endsWith('.TaskSop'))!;
    const exportable = data.revisions.find((item) => item.ownerName === task.name && item.exportEligible)!;

    const historyResponse = await request(`/api/resources/taskSops/${encodeURIComponent(task.name)}/revisions?pageSize=200`);
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json() as { items: Array<Record<string, unknown>> };
    expect(history.items.length).toBeGreaterThan(0);
    expect(history.items.every((item) => !('resource' in item))).toBe(true);

    const detailResponse = await request(`/api/revisions/${encodeURIComponent(exportable.name)}`);
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      name: exportable.name,
      ownerName: task.name,
      exportEligible: true,
      resource: { name: exportable.name },
    });

    const exportResponse = await request(`/api/revisions/${encodeURIComponent(exportable.name)}/export.yaml`);
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get('content-type')).toContain('application/yaml');
    expect(await exportResponse.text()).toContain('format: coscene.sop.export');

    const pdfResponse = await request(`/api/revisions/${encodeURIComponent(exportable.name)}/export.pdf`);
    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers.get('content-type')).toContain('application/vnd.coscene.sop.pdf-model+json');
    await expect(pdfResponse.json()).resolves.toMatchObject({
      rendererVersion: 'sop-pdf-v1',
      page: { size: 'A4' },
      trace: expect.arrayContaining([
        expect.objectContaining({ label: '版本名', value: exportable.name }),
      ]),
    });

    const checkpoint = data.revisions.find((item) => !item.exportEligible)!;
    const blocked = await request(`/api/revisions/${encodeURIComponent(checkpoint.name)}/export.yaml`);
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ error: { kind: 'IMMUTABLE_REVISION' } });
    db.close();
  });

  it('saves one RobotModel and appends its immutable revision atomically', async () => {
    const { db, repository, data, request } = await harness();
    const robot = data.currents.find((item) => item.protoSchema.endsWith('.RobotModel'))!;
    const beforeResponse = await request(`/api/resources/robotModels/${encodeURIComponent(robot.name)}`);
    const before = await beforeResponse.json() as {
      etag: string;
      currentRevision?: string;
      resource: Record<string, unknown>;
    };
    const historyBefore = await request(`/api/resources/robotModels/${encodeURIComponent(robot.name)}/revisions`);
    const beforeItems = (await historyBefore.json() as { items: unknown[] }).items;

    const savedResponse = await request(`/api/resources/robotModels/${encodeURIComponent(robot.name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedEtag: before.etag,
        resource: {
          ...before.resource,
          name: 'robotModels/client-forged',
          uid: 'not-a-uuid',
          sourceId: { forged: true },
          currentRevision: 'not-a-revision',
          createTime: 'not-a-time',
          updateTime: 'not-a-time',
          etag: 'client-forged-etag',
          displayName: 'Updated robot model',
        },
      }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = await savedResponse.json() as {
      resource: { name: string; uid: string; etag: string; currentRevision?: string; resource: Record<string, unknown> };
    };
    expect(saved.resource.etag).not.toBe(before.etag);
    expect(saved.resource.currentRevision).not.toBe(before.currentRevision);
    expect(saved.resource.resource).toMatchObject({
      name: before.resource.name,
      uid: before.resource.uid,
      sourceId: before.resource.sourceId,
      displayName: 'Updated robot model',
    });
    expect(saved.resource.resource.createTime).toBe(before.resource.createTime);
    expect(saved.resource.resource.currentRevision).toBe(saved.resource.currentRevision);
    expect(saved.resource.resource.currentRevision).not.toBe('not-a-revision');
    expect(saved.resource.resource.updateTime).not.toBe('not-a-time');
    expect(saved.resource.resource.etag).toBe(saved.resource.etag);
    expect(saved.resource.resource.etag).not.toBe('client-forged-etag');
    await expect(repository.getCurrent('robotModels/client-forged')).resolves.toBeUndefined();

    const historyAfter = await request(`/api/resources/robotModels/${encodeURIComponent(robot.name)}/revisions`);
    const afterItems = (await historyAfter.json() as { items: Array<{ exportEligible: boolean }> }).items;
    expect(afterItems).toHaveLength(beforeItems.length + 1);
    expect(afterItems.every((item) => item.exportEligible === false)).toBe(true);
    db.close();
  });

  it('creates a RobotModel with v1 atomically and rolls back both rows when revision insertion fails', async () => {
    const { db, request } = await harness();
    const createdResponse = await request('/api/resources/robotModels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resource: {
          displayName: 'Atomic robot model',
          sourceId: 'atomic-robot',
          manufacturer: 'coScene',
        },
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as {
      resource: { name: string; uid: string; etag: string; currentRevision: string; resource: Record<string, unknown> };
    };
    expect(created.resource).toMatchObject({
      name: 'robotModels/atomic-robot',
      uid: expect.stringMatching(/^[a-f0-9-]{36}$/),
      etag: expect.any(String),
      currentRevision: 'robotModels/atomic-robot/revisions/v-1-0-0',
      resource: {
        name: 'robotModels/atomic-robot',
        uid: expect.stringMatching(/^[a-f0-9-]{36}$/),
        currentRevision: 'robotModels/atomic-robot/revisions/v-1-0-0',
        sourceId: 'atomic-robot',
        createTime: expect.any(String),
        updateTime: expect.any(String),
        etag: expect.any(String),
      },
    });

    const forgedCurrentRevision = await request('/api/resources/robotModels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resource: {
        displayName: 'Forbidden current revision',
        sourceId: 'client-current-revision',
        currentRevision: 'robotModels/atomic-robot/revisions/client-owned',
      } }),
    });
    expect(forgedCurrentRevision.status).toBe(400);
    await expect(forgedCurrentRevision.json()).resolves.toMatchObject({ error: { kind: 'VALIDATION' } });
    expect(db.database.prepare(`SELECT count(*) AS count FROM SOP_CURRENT_RESOURCES
      WHERE name = 'robotModels/client-current-revision'`).get()).toEqual({ count: 0 });

    const historyResponse = await request(
      `/api/resources/robotModels/${encodeURIComponent(created.resource.name)}/revisions`,
    );
    expect(historyResponse.status).toBe(200);
    await expect(historyResponse.json()).resolves.toMatchObject({
      items: [{
        name: created.resource.currentRevision,
        versionLabel: '1.0.0',
        exportEligible: false,
      }],
    });
    expect(db.database.prepare(`SELECT current_revision_name FROM SOP_CURRENT_RESOURCES
      WHERE name = ?`).get(created.resource.name)).toEqual({
      current_revision_name: created.resource.currentRevision,
    });
    expect(db.database.prepare(`SELECT owner_name, version_sequence FROM SOP_REVISIONS
      WHERE name = ?`).get(created.resource.currentRevision)).toEqual({
      owner_name: created.resource.name,
      version_sequence: 1,
    });

    const beforeFailure = {
      roots: db.database.prepare('SELECT count(*) AS count FROM SOP_CURRENT_RESOURCES').get(),
      revisions: db.database.prepare('SELECT count(*) AS count FROM SOP_REVISIONS').get(),
    };
    db.exec(`CREATE TRIGGER TEST_FORCE_ROBOT_REVISION_FAILURE
      BEFORE INSERT ON SOP_REVISIONS
      WHEN NEW.owner_name = 'robotModels/atomic-failure'
      BEGIN
        SELECT RAISE(ABORT, 'forced robot revision failure');
      END`);
    const failedResponse = await request('/api/resources/robotModels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        resource: {
          displayName: 'Must roll back',
          sourceId: 'atomic-failure',
        },
      }),
    });
    expect(failedResponse.status).toBe(500);
    await expect(failedResponse.json()).resolves.toMatchObject({ error: { kind: 'STORAGE_UNAVAILABLE' } });
    expect(db.database.prepare(`SELECT count(*) AS count FROM SOP_CURRENT_RESOURCES
      WHERE name = 'robotModels/atomic-failure'`).get()).toEqual({ count: 0 });
    expect(db.database.prepare(`SELECT count(*) AS count FROM SOP_REVISIONS
      WHERE owner_name = 'robotModels/atomic-failure'`).get()).toEqual({ count: 0 });
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_CURRENT_RESOURCES').get())
      .toEqual(beforeFailure.roots);
    expect(db.database.prepare('SELECT count(*) AS count FROM SOP_REVISIONS').get())
      .toEqual(beforeFailure.revisions);
    db.close();
  });

  it('fails closed on readiness and has no canonical-data route', async () => {
    const { db, repository, request } = await harness();
    const unready = await handleResourceApiRequest(
      new Request('https://sop.test/api/resources/materials'),
      repository,
      { expectedBootstrapMarker: 'different-release-marker', requestId: 'request-2' },
    );
    expect(unready.status).toBe(503);
    await expect(unready.json()).resolves.toMatchObject({ error: { kind: 'NOT_INITIALIZED' } });

    const removed = await request('/api/canonical-data');
    expect(removed.status).toBe(404);
    await expect(removed.json()).resolves.toMatchObject({ error: { kind: 'NOT_FOUND' } });
    db.close();
  });
});
