import { describe, expect, it } from 'vitest';
import type { AppStore, CanonicalSnapshot, StorePin } from '../../server/domain/appStore';
import { createCanonicalApiStore, CanonicalRuntime } from '../../server/domain/services/runtime';
import { projectCanonicalToRest } from '../../server/domain/services/projection';
import { AtomicCommitError, StaleStoreEpochError, WriteFrozenError } from '../../server/domain/errors';
import { convertLegacyToV1alpha1 } from '../../server/migrations/legacyToV1alpha1';
import { handleApiRequest } from '../../server/api';
import { seedData } from '../e2e/fixtures/seed';

function memoryStore(initial: CanonicalSnapshot, namespace = 'validated-test'): AppStore {
  let snapshot = structuredClone(initial);
  let pin: StorePin = { namespace, epoch: 7, generation: 0, writable: true };
  return {
    async pin(selected) {
      if (selected && selected !== namespace) throw new Error(`unknown namespace ${selected}`);
      return { ...pin };
    },
    async readSnapshot(expected) {
      if (expected.epoch !== pin.epoch) throw new StaleStoreEpochError(namespace, expected.epoch, pin.epoch);
      if (expected.generation !== pin.generation) throw new AtomicCommitError('generation changed');
      return structuredClone(snapshot);
    },
    async commit(expected, mutation) {
      if (expected.epoch !== pin.epoch) throw new StaleStoreEpochError(namespace, expected.epoch, pin.epoch);
      if (!pin.writable) throw new WriteFrozenError(namespace);
      if (expected.generation !== pin.generation) throw new AtomicCommitError('generation changed');
      snapshot = await mutation(structuredClone(snapshot));
      pin = { ...pin, generation: pin.generation + 1 };
      return { pin: { ...pin }, snapshot: structuredClone(snapshot) };
    },
    async setWriteState(expected, writable) {
      if (expected.epoch !== pin.epoch) throw new StaleStoreEpochError(namespace, expected.epoch, pin.epoch);
      pin = { ...pin, epoch: pin.epoch + 1, writable };
      return { ...pin };
    },
  };
}

function canonicalSeed(): CanonicalSnapshot {
  const conversion = convertLegacyToV1alpha1(seedData);
  expect(conversion.report.issues).toEqual([]);
  return conversion.snapshot;
}

describe('canonical versioning services', () => {
  it('round-trips source IDs and version IDs through the REST projection', () => {
    const projected = projectCanonicalToRest(canonicalSeed());
    expect(projected.customers.map((item) => item.id)).toEqual(seedData.customers.map((item) => item.id));
    expect(projected.scenes[0].subscenes[0].versions[0]).toMatchObject({
      version: seedData.scenes[0].subscenes[0].versions[0].version,
      versionId: seedData.scenes[0].subscenes[0].versions[0].versionId,
    });
    expect(projected.requirements[0]).toMatchObject({
      id: seedData.requirements[0].id,
      versions: [{ versionId: seedData.requirements[0].versions[0].versionId }],
    });
  });

  it('uses canonical generated resources as catalog CRUD authority', async () => {
    const runtime = new CanonicalRuntime(memoryStore(canonicalSeed()), { namespace: 'validated-test' });
    const current = (await runtime.read()).data;
    const result = await runtime.replaceCatalog('customers', [
      ...current.customers,
      { id: 'cus-service', name: 'Service customer', contact: { name: '', phone: '', email: '' } },
    ]);
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'cus-service', name: 'Service customer' })]));
    const canonical = (await runtime.read()).snapshot.customers.find((item) => item.sourceId === 'cus-service');
    expect(canonical).toMatchObject({ name: 'customers/cus-service', displayName: 'Service customer', sourceId: 'cus-service' });
  });

  it('atomically creates an immutable RobotModelRevision for every successful save and keeps requirement pins stable', async () => {
    const store = memoryStore(canonicalSeed());
    const apiStore = createCanonicalApiStore(store, { namespace: 'validated-test' });
    const before = await apiStore.readData();
    const pinnedBefore = (await store.readSnapshot(await store.pin('validated-test'))).requirements[0].spec!.robotModelRevision;
    const model = { ...before.robotModels[0], terminal: 'new-gripper' };
    const response = await handleApiRequest(apiStore, { method: 'POST', pathname: '/api/robot-models', body: model });
    expect(response.status).toBe(200);
    const snapshot = await store.readSnapshot(await store.pin('validated-test'));
    const revisions = snapshot.robotModelRevisions.filter((item) => item.snapshot?.sourceId === model.id);
    expect(revisions).toHaveLength(2);
    expect(revisions.at(-1)).toMatchObject({ previousRevision: revisions[0].name, versionLabel: '1.0.1' });
    expect(revisions[0].snapshot?.endEffector).not.toBe('new-gripper');
    expect(snapshot.requirements[0].spec!.robotModelRevision).toBe(pinnedBefore);
  });
});
