import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../server/api';
import { createCanonicalApiStore } from '../../server/domain/services/runtime';
import { Lifecycle } from '../../gen/coscene/sop/v1alpha1/common_pb';
import { convertLegacyToV1alpha1 } from '../../server/migrations/legacyToV1alpha1';
import { createCanonicalFileAppStore } from '../../server/store';
import { seedData } from '../e2e/fixtures/seed';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sop-u5-revisions-'));
  const snapshot = convertLegacyToV1alpha1(seedData).snapshot;
  const store = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'validated', snapshot } });
  return { store, api: createCanonicalApiStore(store, { namespace: 'validated' }) };
}

describe('canonical revision API', () => {
  it('creates exact TaskSop and Requirement patch chains with fresh source version IDs', async () => {
    const { store, api } = await fixture();
    const data = await api.readData();
    const scene = data.scenes[0];
    const task = scene.subscenes[0];
    const confirmed = task.versions[0];
    const taskPatch = await handleApiRequest(api, {
      method: 'POST', pathname: `/api/scenes/${scene.id}/subscenes/${encodeURIComponent(task.code)}/versions`,
      body: { baseVersion: confirmed.version, description: 'next task patch' },
    });
    expect(taskPatch.status).toBe(200);
    const patchedTask = (await api.readData()).scenes[0].subscenes[0].versions.at(-1)!;
    expect(patchedTask).toMatchObject({ version: '0.0.2', parentVersionId: confirmed.versionId, status: 'draft' });
    expect(patchedTask.versionId).toBeTruthy();
    expect(patchedTask.versionId).not.toBe(confirmed.versionId);

    const confirmRequirement = await handleApiRequest(api, {
      method: 'POST', pathname: `/api/requirements/${data.requirements[0].id}/confirm`, body: { version: '0.0.1' },
    });
    expect(confirmRequirement.status).toBe(200);
    const confirmedRequirement = (await api.readData()).requirements[0].versions[0];
    const requirementPatch = await handleApiRequest(api, {
      method: 'PUT', pathname: `/api/requirements/${data.requirements[0].id}`,
      body: { baseVersion: confirmedRequirement.version, businessGoal: 'next requirement patch' },
    });
    expect(requirementPatch.status).toBe(200);
    const patchedRequirement = (await api.readData()).requirements[0].versions.at(-1)!;
    expect(patchedRequirement).toMatchObject({ version: '0.0.2', parentVersionId: confirmedRequirement.versionId, status: 'draft' });
    expect(patchedRequirement.versionId).not.toBe(confirmedRequirement.versionId);

    const canonical = await store.readSnapshot(await store.pin('validated'));
    const taskRevisions = canonical.taskSopRevisions.filter((item) => item.snapshot?.name === canonical.taskSops[0].name);
    expect(taskRevisions.find((item) => item.versionLabel === '0.0.2')?.previousRevision)
      .toBe(taskRevisions.find((item) => item.versionLabel === '0.0.1')?.name);
    const requirementRevisions = canonical.requirementRevisions.filter((item) => item.snapshot?.name === canonical.requirements[0].name);
    expect(requirementRevisions.find((item) => item.versionLabel === '0.0.2')?.previousRevision)
      .toBe(requirementRevisions.find((item) => item.versionLabel === '0.0.1')?.name);
  });

  it('freezes only the exact confirmation catalog closure and never refreshes it', async () => {
    const { store, api } = await fixture();
    const before = await api.readData();
    const initialCanonical = await store.readSnapshot(await store.pin('validated'));
    expect(initialCanonical.taskSopRevisions[0].frozenDependencies?.globalFields.map((item) => item.sourceId))
      .toEqual(['field-baseline']);
    await handleApiRequest(api, {
      method: 'POST', pathname: '/api/customers',
      body: { id: 'cus-unrelated', name: 'Unrelated', contact: { name: '', phone: '', email: '' } },
    });
    const confirmed = await handleApiRequest(api, {
      method: 'POST', pathname: `/api/requirements/${before.requirements[0].id}/confirm`, body: { version: '0.0.1' },
    });
    expect(confirmed.status).toBe(200);
    let canonical = await store.readSnapshot(await store.pin('validated'));
    const revision = canonical.requirementRevisions.find((item) => item.snapshot?.lifecycle === Lifecycle.CONFIRMED)!;
    expect(revision.frozenDependencies?.customers.map((item) => item.sourceId)).toEqual(['cus-baseline']);
    expect(revision.frozenDependencies?.attachments).toEqual([]);

    await handleApiRequest(api, {
      method: 'POST', pathname: '/api/customers',
      body: { ...before.customers[0], name: 'Changed after confirmation' },
    });
    canonical = await store.readSnapshot(await store.pin('validated'));
    const unchanged = canonical.requirementRevisions.find((item) => item.name === revision.name)!;
    expect(unchanged.frozenDependencies?.customers[0].displayName).toBe(seedData.customers[0].name);
  });

  it('keeps a Requirement exact robot pin after later RobotModel saves', async () => {
    const { store, api } = await fixture();
    const before = await store.readSnapshot(await store.pin('validated'));
    const pin = before.requirements[0].spec!.robotModelRevision;
    const model = (await api.readData()).robotModels[0];
    await handleApiRequest(api, { method: 'POST', pathname: '/api/robot-models', body: { ...model, terminal: 'changed' } });
    const after = await store.readSnapshot(await store.pin('validated'));
    expect(after.requirements[0].spec!.robotModelRevision).toBe(pin);
    expect(after.robotModels[0].currentRevision).not.toBe(pin);
  });

  it('allows incomplete drafts but rejects confirmation until Task and Requirement dependencies are complete', async () => {
    const { api } = await fixture();
    let data = await api.readData();
    const scene = data.scenes[0];
    const task = scene.subscenes[0];
    const taskDraft = await handleApiRequest(api, {
      method: 'POST', pathname: `/api/scenes/${scene.id}/subscenes/${encodeURIComponent(task.code)}/versions`,
      body: { baseVersion: task.versions[0].version, robotState: { initial: '', target: '' } },
    });
    expect(taskDraft.status).toBe(200);
    let draft = (await api.readData()).scenes[0].subscenes[0].versions.at(-1)!;
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: `/api/scenes/${scene.id}/subscenes/${encodeURIComponent(task.code)}/confirm`,
      body: { version: draft.version },
    })).status).toBe(400);
    await handleApiRequest(api, {
      method: 'POST', pathname: `/api/scenes/${scene.id}/subscenes/${encodeURIComponent(task.code)}/versions`,
      body: { baseVersion: draft.version, robotState: { initial: 'ready', target: 'done' } },
    });
    draft = (await api.readData()).scenes[0].subscenes[0].versions.at(-1)!;
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: `/api/scenes/${scene.id}/subscenes/${encodeURIComponent(task.code)}/confirm`,
      body: { version: draft.version },
    })).status).toBe(200);

    data = await api.readData();
    const requirement = data.requirements[0];
    const incompleteRequirement = await handleApiRequest(api, {
      method: 'PUT', pathname: `/api/requirements/${requirement.id}`,
      body: { baseVersion: requirement.versions[0].version, customerId: '', robotModelId: '', deadline: '' },
    });
    expect(incompleteRequirement.status).toBe(200);
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: `/api/requirements/${requirement.id}/confirm`, body: { version: '0.0.1' },
    })).status).toBe(400);
    expect((await handleApiRequest(api, {
      method: 'PUT', pathname: `/api/requirements/${requirement.id}`,
      body: { baseVersion: '0.0.1', customerId: data.customers[0].id, robotModelId: data.robotModels[0].id, deadline: '2026-12-31' },
    })).status).toBe(200);
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: `/api/requirements/${requirement.id}/confirm`, body: { version: '0.0.1' },
    })).status).toBe(200);
  });

  it('allows an unselected material in a draft and fails closed on confirmation', async () => {
    const { api } = await fixture();
    const data = await api.readData();
    const scene = data.scenes[0];
    const task = scene.subscenes[0];
    const saved = await handleApiRequest(api, {
      method: 'POST', pathname: `/api/scenes/${scene.id}/subscenes/${encodeURIComponent(task.code)}/versions`,
      body: {
        baseVersion: task.versions[0].version,
        robotState: { initial: 'ready', target: 'done' },
        materials: [{
          materialId: '', skuId: '', type: 'Unselected object',
          quantity: { mode: 'fixed', value: 1, unit: '件' }, color: '', material: '', packageType: '',
        }],
        objectStates: {
          initial: [{
            object: 'Unselected object',
            allowedLocations: [{
              location: 'desk', referencePath: [], supportSurface: 'desk', allowedRegions: [], allowedPose: [], allowedForm: [],
              parameters: [], exampleImageAttachmentIds: [], constraints: [],
            }],
          }],
          target: [],
        },
      },
    });
    expect(saved.status).toBe(200);
    const draft = (await api.readData()).scenes[0].subscenes[0].versions.at(-1)!;
    const confirm = await handleApiRequest(api, {
      method: 'POST', pathname: `/api/scenes/${scene.id}/subscenes/${encodeURIComponent(task.code)}/confirm`,
      body: { version: draft.version },
    });
    expect(confirm).toMatchObject({ status: 400 });
    expect((confirm.body as { message: string }).message).toContain('任务物料不存在');
  });
});
