import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../server/api';
import { createCanonicalApiStore, CanonicalRuntime } from '../../server/domain/services/runtime';
import { CanonicalDataError } from '../../server/domain/errors';
import { convertLegacyToV1alpha1 } from '../../server/migrations/legacyToV1alpha1';
import { createCanonicalFileAppStore } from '../../server/store';
import { seedData } from '../e2e/fixtures/seed';

describe('canonical resource API', () => {
  it('boots and mutates an explicit VALIDATED namespace without changing the active marker', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-u5-inactive-'));
    const snapshot = convertLegacyToV1alpha1(seedData).snapshot;
    const namespace = 'validated-fixture';
    const appStore = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace, snapshot } });
    const apiStore = createCanonicalApiStore(appStore, { namespace });

    const response = await handleApiRequest(apiStore, {
      method: 'POST', pathname: '/api/customers',
      body: { id: 'cus-inactive', name: 'Inactive generation customer', contact: { name: '', phone: '', email: '' } },
    });
    expect(response.status).toBe(200);
    expect((await apiStore.readData()).customers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'cus-inactive' })]));
    expect((await readFile(path.join(root, 'active-namespace'), 'utf8')).trim()).toBe('v1alpha1-default');
    expect((await appStore.pin()).namespace).toBe('v1alpha1-default');
  });

  it('keeps generated-only catalog fields and blocks referenced customer/material deletion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-u5-catalog-'));
    const snapshot = convertLegacyToV1alpha1(seedData).snapshot;
    snapshot.materials[0].colors.push('canonical-secondary');
    snapshot.materials[0].compositions.push('canonical-composition');
    const store = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'validated', snapshot } });
    const runtime = new CanonicalRuntime(store, { namespace: 'validated' });
    const data = (await runtime.read()).data;
    await runtime.replaceCatalog('materials', data.materials.map((item) => ({ ...item, color: 'UI-primary' })));
    const material = (await runtime.read()).snapshot.materials[0];
    expect(material.colors).toEqual(['UI-primary', 'canonical-secondary']);
    expect(material.compositions).toEqual([seedData.materials[0].material, 'canonical-composition']);
    await expect(runtime.replaceCatalog('customers', [])).rejects.toBeInstanceOf(CanonicalDataError);
  });

  it('maps canonical business guards to compatible 400 responses', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-u5-errors-'));
    const snapshot = convertLegacyToV1alpha1(seedData).snapshot;
    const store = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'validated', snapshot } });
    const apiStore = createCanonicalApiStore(store, { namespace: 'validated' });
    const current = await apiStore.readData();
    current.requirements[0].versions[0].selectedSubscenes = [{
      id: 'missing', title: 'Missing task', sceneName: 'missing', targetDurationHours: 1,
      taskSop: { sceneName: 'missing', title: 'missing', version: '0.0.1', status: 'draft' },
    }];
    await expect(apiStore.writeRequirements(current.requirements)).rejects.toBeInstanceOf(CanonicalDataError);
  });

  it('pins one namespace/epoch for the whole request and rejects an epoch flip between read and commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-u5-request-pin-'));
    const snapshot = convertLegacyToV1alpha1(seedData).snapshot;
    const base = createCanonicalFileAppStore({ rootDir: root, bootstrap: { namespace: 'validated', snapshot } });
    let flipAfterRead = true;
    const fenced = {
      pin: base.pin.bind(base),
      async readSnapshot(pin: Awaited<ReturnType<typeof base.pin>>) {
        const value = await base.readSnapshot(pin);
        if (flipAfterRead && pin.namespace === 'validated') {
          flipAfterRead = false;
          const frozen = await base.setWriteState(pin, false);
          await base.setWriteState(frozen, true);
        }
        return value;
      },
      commit: base.commit.bind(base),
      setWriteState: base.setWriteState.bind(base),
    };
    const api = createCanonicalApiStore(fenced, { namespace: 'validated' });
    const response = await handleApiRequest(api, {
      method: 'POST', pathname: '/api/customers',
      body: { id: 'cus-race', name: 'Must not commit', contact: { name: '', phone: '', email: '' } },
    });
    expect(response.status).toBe(409);
    expect((await createCanonicalApiStore(base, { namespace: 'validated' }).readData()).customers)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'cus-race' })]));
  });
});
