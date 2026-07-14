import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../server/api';
import { createCanonicalApiStore } from '../../server/domain/services/runtime';
import { convertLegacyToV1alpha1 } from '../../server/migrations/legacyToV1alpha1';
import { createCanonicalFileAppStore } from '../../server/store';
import { seedData } from '../e2e/fixtures/seed';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sop-export-api-'));
  const store = createCanonicalFileAppStore({
    rootDir: root,
    bootstrap: { namespace: 'validated', snapshot: convertLegacyToV1alpha1(structuredClone(seedData)).snapshot },
  });
  return createCanonicalApiStore(store, { namespace: 'validated' });
}

describe('canonical export API', () => {
  it('exports confirmed TaskSop and Requirement roots from a pinned canonical snapshot', async () => {
    const api = await fixture();
    const task = await handleApiRequest(api, {
      method: 'POST', pathname: '/api/scenes/scene-baseline/subscenes/NO.001/export-yaml', body: { version: '0.0.1' },
    });
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    expect(YAML.parse((task.body as { yaml: string }).yaml)).toEqual(expect.objectContaining({
      format: 'coscene.sop.export', schema_version: '1.0.0', root: expect.objectContaining({ kind: 'task_sop' }),
    }));

    expect((await handleApiRequest(api, {
      method: 'POST', pathname: '/api/requirements/REQ001/export-yaml', body: { version: '0.0.1' },
    })).status).toBe(400);
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: '/api/requirements/REQ001/confirm', body: { version: '0.0.1' },
    })).status).toBe(200);
    const requirement = await handleApiRequest(api, {
      method: 'POST', pathname: '/api/requirements/REQ001/export-yaml', body: { version: '0.0.1' },
    });
    expect(requirement.status, JSON.stringify(requirement.body)).toBe(200);
    expect(YAML.parse((requirement.body as { yaml: string }).yaml).root.kind).toBe('requirement');
    const patch = await handleApiRequest(api, {
      method: 'PUT', pathname: '/api/requirements/REQ001', body: { baseVersion: '0.0.1' },
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
  });

  it('rejects latest drafts instead of falling back and returns 404 for missing versions', async () => {
    const api = await fixture();
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: '/api/scenes/scene-baseline/subscenes/NO.001/versions',
      body: { baseVersion: '0.0.1', description: 'latest draft' },
    })).status).toBe(200);
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: '/api/scenes/scene-baseline/subscenes/NO.001/export-yaml', body: {},
    })).status).toBe(400);
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: '/api/scenes/scene-baseline/subscenes/NO.001/export-yaml', body: { version: '9.9.9' },
    })).status).toBe(404);
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: '/api/requirements/missing/export-yaml', body: { version: '0.0.1' },
    })).status).toBe(404);
  });

  it('keeps confirmed exports immutable while allowing a new patch from a referenced TaskSop', async () => {
    const api = await fixture();
    const created = await handleApiRequest(api, {
      method: 'POST', pathname: '/api/requirements',
      body: {
        title: 'Export lifecycle', projectName: 'Project', customerId: 'cus-baseline', robotModelId: 'robot-baseline',
        selectedSubscenes: [{
          id: 'item', title: 'Item', sceneName: '基线场景', targetDurationHours: 1, targetCollectionCount: 2,
          taskSop: { sceneName: '基线场景', title: '基线任务 SOP', version: '0.0.1', status: 'confirmed' },
        }],
      },
    });
    expect(created.status).toBe(200);
    const requirement = (created.body as Array<{ id: string }>).at(-1)!;
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: `/api/requirements/${requirement.id}/confirm`, body: { version: '0.0.1' },
    })).status).toBe(200);
    const forged = await api.readData();
    forged.requirements.find((item) => item.id === requirement.id)!.versions[0].title = 'forged confirmed edit';
    await expect(api.writeRequirements(forged.requirements)).rejects.toThrow('已确认客户需求版本不可修改');
    expect((await handleApiRequest(api, {
      method: 'POST', pathname: `/api/requirements/${requirement.id}/export-yaml`, body: { version: '0.0.1' },
    })).status).toBe(200);
    const patched = await handleApiRequest(api, {
      method: 'PUT', pathname: `/api/requirements/${requirement.id}`, body: { baseVersion: '0.0.1' },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  });
});
