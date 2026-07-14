import { describe, expect, it } from 'vitest';
import type { AppData } from '../../src/types';
import type { LegacyApiStore } from '../../shared/transport/restDto';
import { encodeRestDto } from '../../shared/transport/restDto';
import { handleApiRequest } from '../../server/api';
import { seedData } from '../e2e/fixtures/seed';

function memoryLegacyStore(initial: AppData): LegacyApiStore {
  let data = structuredClone(initial);
  return {
    async readData() { return structuredClone(data); },
    async writeCustomers(value) { data.customers = structuredClone(value); return value; },
    async writeMaterials(value) { data.materials = structuredClone(value); return value; },
    async writeRobotModels(value) { data.robotModels = structuredClone(value); return value; },
    async writeScenes(value) { data.scenes = structuredClone(value); return value; },
    async writeRequirements(value) { data.requirements = structuredClone(value); return value; },
    async writeGlobalFields(value) { data.globalFields = structuredClone(value); return value; },
    async writeMaterialStateRules(value) { data.materialStateRules = structuredClone(value); return value; },
    async writeExport(id, version) { return `/exports/requirements/${id}/${version}.yaml`; },
  };
}

describe('legacy REST compatibility boundary', () => {
  it('preserves current data and CRUD response payloads through DTO round trips', async () => {
    const store = memoryLegacyStore(seedData);
    const baseline = await handleApiRequest(store, { method: 'GET', pathname: '/api/data' });
    expect(baseline).toEqual({ status: 200, body: encodeRestDto(seedData) });

    const created = await handleApiRequest(store, {
      method: 'POST', pathname: '/api/customers',
      body: { id: 'cus-characterized', name: '契约客户', contact: { name: '联系人', phone: '', email: '' } },
    });
    expect(created.status).toBe(200);
    expect(created.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'cus-characterized', name: '契约客户' })]));
    expect((await store.readData()).customers).toHaveLength(seedData.customers.length + 1);
  });

  it('preserves existing auth, validation and not-found error shapes', async () => {
    const store = memoryLegacyStore(seedData);
    expect(await handleApiRequest(store, {
      method: 'GET', pathname: '/api/data', authorization: 'Bearer wrong', auth: { password: 'secret' },
    })).toEqual({ status: 401, body: { message: '访问密码无效或已过期' } });
    expect((await handleApiRequest(store, { method: 'POST', pathname: '/api/materials', body: { skuId: 'SKU001' } }))).toEqual({
      status: 400, body: { message: 'SKU 编号 SKU001 已存在' },
    });
    expect(await handleApiRequest(store, { method: 'GET', pathname: '/api/not-found' })).toEqual({
      status: 404, body: { message: '接口不存在' },
    });
  });
});

