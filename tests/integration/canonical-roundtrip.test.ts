import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../server/api';
import { createCanonicalApiStore } from '../../server/domain/services/runtime';
import { convertLegacyToV1alpha1 } from '../../server/migrations/legacyToV1alpha1';
import { createCanonicalFileAppStore } from '../../server/store';
import { seedData } from '../e2e/fixtures/seed';

describe('canonical-only field round trips', () => {
  it('preserves hidden Proto fields through confirmed-to-patch and draft edits', async () => {
    const legacy = structuredClone(seedData);
    const sourceTask = legacy.scenes[0].subscenes[0].versions[0];
    const material = legacy.materials[0];
    sourceTask.materials = [{
      materialId: material.id, skuId: material.skuId, type: material.type,
      quantity: { mode: 'fixed', value: 1, unit: '件' }, color: material.color,
      material: material.material, packageType: material.packageType,
    }];
    sourceTask.objectStates.initial = [{ object: material.type, allowedLocations: [{
      location: '工作台', referencePath: [], supportSurface: '工作台', allowedRegions: [], allowedPose: [], allowedForm: [],
      parameters: ['visible-value'], constraints: [],
    }] }];
    sourceTask.operation.allowedOperations = [{ description: '允许操作' }];

    const snapshot = convertLegacyToV1alpha1(legacy).snapshot;
    const sourceRevision = snapshot.taskSopRevisions[0];
    sourceRevision.snapshot!.spec!.objects[0].materialDescriptor!.size = 'hidden-size';
    sourceRevision.snapshot!.spec!.objects[0].materialDescriptor!.weight = 'hidden-weight';
    sourceRevision.snapshot!.spec!.objects[0].roles = ['hidden-role'];
    sourceRevision.snapshot!.spec!.collection!.policy!.allowed[0].note = 'hidden-note';
    sourceRevision.snapshot!.spec!.objectStates!.initial[0].allowedLocations[0].parameters[0].key = 'semantic-key';
    snapshot.requirementRevisions[0].snapshot!.spec!.globalRequirements!.topics = [{
      $typeName: 'coscene.sop.v1alpha1.TopicRequirement', topicId: 'hidden-topic', constraints: ['hidden-constraint'],
    }];

    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-canonical-roundtrip-'));
    const store = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'validated', snapshot } });
    const api = createCanonicalApiStore(store, { namespace: 'validated' });
    expect((await store.readSnapshot(await store.pin('validated'))).requirementRevisions[0].snapshot!.spec!.globalRequirements!.topics)
      .toEqual([expect.objectContaining({ topicId: 'hidden-topic' })]);
    let data = await api.readData();
    const task = data.scenes[0].subscenes[0];
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: `/api/scenes/${data.scenes[0].id}/subscenes/${encodeURIComponent(task.code)}/versions`,
      body: { baseVersion: '0.0.1', description: 'new patch' },
    })).status).toBe(200);
    data = await api.readData();
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: `/api/scenes/${data.scenes[0].id}/subscenes/${encodeURIComponent(task.code)}/versions`,
      body: { baseVersion: '0.0.2', description: 'edited draft' },
    })).status).toBe(200);

    data = await api.readData();
    const requirement = data.requirements[0];
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: `/api/requirements/${requirement.id}/confirm`, body: { version: '0.0.1' },
    })).status).toBe(200);
    expect((await store.readSnapshot(await store.pin('validated'))).requirementRevisions[0].snapshot!.spec!.globalRequirements!.topics)
      .toEqual([expect.objectContaining({ topicId: 'hidden-topic' })]);
    expect((await handleApiRequest(api, {
      method: 'PUT', pathname: `/api/requirements/${requirement.id}`,
      body: { baseVersion: '0.0.1', businessGoal: 'new patch' },
    })).status).toBe(200);

    const after = await store.readSnapshot(await store.pin('validated'));
    const patchedTask = after.taskSopRevisions.find((revision) => revision.versionLabel === '0.0.2')!;
    expect(patchedTask.snapshot!.spec!.objects[0]).toMatchObject({
      roles: ['hidden-role'], materialDescriptor: { size: 'hidden-size', weight: 'hidden-weight' },
    });
    expect(patchedTask.snapshot!.spec!.collection!.policy!.allowed[0].note).toBe('hidden-note');
    expect(patchedTask.snapshot!.spec!.objectStates!.initial[0].allowedLocations[0].parameters[0].key).toBe('semantic-key');
    const patchedRequirement = after.requirementRevisions.find((revision) => revision.versionLabel === '0.0.2')!;
    expect(patchedRequirement.snapshot!.spec!.globalRequirements!.topics).toEqual([
      expect.objectContaining({ topicId: 'hidden-topic', constraints: ['hidden-constraint'] }),
    ]);
  });

  it('projects confirmed attachment metadata from the frozen revision context', async () => {
    const legacy = structuredClone(seedData);
    legacy.requirements[0].versions[0].attachments = [{
      id: 'att-frozen', name: 'frozen.txt', size: 12, contentType: 'text/plain',
      storageKey: 'requirements/req-baseline/att-frozen.txt', uploadedAt: '2026-01-01T00:00:00.000Z',
    }];
    const snapshot = convertLegacyToV1alpha1(legacy).snapshot;
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-frozen-projection-'));
    const store = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'validated', snapshot } });
    const api = createCanonicalApiStore(store, { namespace: 'validated' });
    const requirement = (await api.readData()).requirements[0];
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: `/api/requirements/${requirement.id}/confirm`, body: { version: '0.0.1' },
    })).status).toBe(200);

    const pin = await store.pin('validated');
    await store.commit(pin, (current) => ({
      ...current,
      attachments: current.attachments.map((attachment) =>
        attachment.sourceId === 'att-frozen' ? { ...attachment, filename: 'changed-after-confirm.txt' } : attachment),
    }));

    const confirmed = (await createCanonicalApiStore(store, { namespace: 'validated' }).readData())
      .requirements[0].versions[0];
    expect(confirmed.attachments?.[0].name).toBe('frozen.txt');
  });

  it('preserves the renamed second-draft canonical fields instead of copying its parent', async () => {
    const legacy = structuredClone(seedData);
    const first = legacy.requirements[0].versions[0];
    first.status = 'confirmed';
    first.versionId = 'reqv-parent';
    const second = structuredClone(first);
    second.version = '0.0.2';
    second.versionId = undefined;
    second.parentVersionId = undefined;
    second.status = 'draft';
    legacy.requirements[0].versions.push(second);
    const snapshot = convertLegacyToV1alpha1(legacy).snapshot;
    snapshot.requirementRevisions[0].snapshot!.spec!.globalRequirements!.topics = [{
      $typeName: 'coscene.sop.v1alpha1.TopicRequirement', topicId: 'parent-topic', constraints: ['parent'],
    }];
    snapshot.requirementRevisions[1].snapshot!.spec!.globalRequirements!.topics = [{
      $typeName: 'coscene.sop.v1alpha1.TopicRequirement', topicId: 'draft-topic', constraints: ['draft'],
    }];
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-renamed-draft-'));
    const store = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'validated', snapshot } });
    const api = createCanonicalApiStore(store, { namespace: 'validated' });
    const requirement = (await api.readData()).requirements[0];

    const confirmation = await handleApiRequest(api, {
      method: 'POST', pathname: `/api/requirements/${requirement.id}/confirm`, body: { version: '0.0.2' },
    });
    expect(confirmation.status, JSON.stringify(confirmation.body)).toBe(200);

    const after = await store.readSnapshot(await store.pin('validated'));
    const confirmed = after.requirementRevisions.find((revision) => revision.versionLabel === '0.0.2')!;
    expect(confirmed.snapshot!.spec!.globalRequirements!.topics).toEqual([
      expect.objectContaining({ topicId: 'draft-topic', constraints: ['draft'] }),
    ]);
  });

  it('projects archived attachment metadata from its immutable frozen context', async () => {
    const legacy = structuredClone(seedData);
    legacy.requirements[0].versions[0].status = 'archived';
    legacy.requirements[0].versions[0].attachments = [{
      id: 'att-archived', name: 'archived.txt', size: 12, contentType: 'text/plain',
      storageKey: 'requirements/req-baseline/att-archived.txt', uploadedAt: '2026-01-01T00:00:00.000Z',
    }];
    const snapshot = convertLegacyToV1alpha1(legacy).snapshot;
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-archived-projection-'));
    const store = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'validated', snapshot } });
    const pin = await store.pin('validated');
    await store.commit(pin, (current) => ({
      ...current,
      attachments: current.attachments.map((attachment) =>
        attachment.sourceId === 'att-archived' ? { ...attachment, filename: 'changed-after-archive.txt' } : attachment),
    }));

    const archived = (await createCanonicalApiStore(store, { namespace: 'validated' }).readData())
      .requirements[0].versions[0];
    expect(archived.attachments?.[0].name).toBe('archived.txt');
  });
});
