import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCanonicalApiStore } from '../../server/domain/services/runtime';
import { bootstrapValidatedFileGeneration } from '../../server/migrations/fileRuntimeBootstrap';
import { createCanonicalFileAppStore } from '../../server/store';
import { seedData } from '../e2e/fixtures/seed';

async function writeLegacyData(dataDir: string, customerName: string): Promise<void> {
  const data = structuredClone(seedData);
  data.customers[0].name = customerName;
  await mkdir(dataDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dataDir, 'metadata.json'), JSON.stringify(data.metadata)),
    writeFile(path.join(dataDir, 'customers.json'), JSON.stringify(data.customers)),
    writeFile(path.join(dataDir, 'materials.json'), JSON.stringify(data.materials)),
    writeFile(path.join(dataDir, 'robot-models.json'), JSON.stringify(data.robotModels)),
    writeFile(path.join(dataDir, 'scenes.json'), JSON.stringify(data.scenes)),
    writeFile(path.join(dataDir, 'requirements.json'), JSON.stringify(data.requirements)),
    writeFile(path.join(dataDir, 'global-fields.json'), JSON.stringify(data.globalFields)),
    writeFile(path.join(dataDir, 'material-state-rules.json'), JSON.stringify(data.materialStateRules)),
  ]);
}

describe('file canonical inactive-generation boot', () => {
  it('persists the first runtime generation across legacy changes and restarts without touching active namespace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-file-runtime-'));
    const dataDir = path.join(root, 'legacy');
    const canonicalRoot = path.join(root, 'canonical');
    await writeLegacyData(dataDir, 'first legacy customer');
    await mkdir(canonicalRoot, { recursive: true });
    await writeFile(path.join(canonicalRoot, 'active-namespace'), 'previous-active');

    const first = await bootstrapValidatedFileGeneration({ canonicalRoot, legacyDir: dataDir });
    const firstStore = createCanonicalFileAppStore({
      rootDir: canonicalRoot,
      bootstrap: { namespace: first.generationId, snapshot: first.snapshot },
    });
    const api = createCanonicalApiStore(firstStore, { namespace: first.generationId });
    const data = await api.readData();
    await api.writeCustomers([...data.customers, { id: 'canonical-only', name: 'canonical write', contact: { name: '', phone: '', email: '' }, notes: '' }]);

    await writeLegacyData(dataDir, 'changed legacy customer');
    const second = await bootstrapValidatedFileGeneration({ canonicalRoot, legacyDir: dataDir });
    const restartedStore = createCanonicalFileAppStore({
      rootDir: canonicalRoot,
      bootstrap: { namespace: second.generationId, snapshot: second.snapshot },
    });
    const restarted = await createCanonicalApiStore(restartedStore, { namespace: second.generationId }).readData();

    expect(second.generationId).toBe(first.generationId);
    expect(restarted.customers).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'canonical-only' })]));
    expect(restarted.customers.find((item) => item.id === seedData.customers[0].id)?.name).toBe('first legacy customer');
    expect((await readFile(path.join(canonicalRoot, 'runtime-namespace'), 'utf8')).trim()).toBe(first.generationId);
    expect((await readFile(path.join(canonicalRoot, 'active-namespace'), 'utf8')).trim()).toBe('previous-active');
  });

  it('upgrades an existing canonical namespace with a durable, non-extending rollback lease', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sop-file-runtime-lease-'));
    const dataDir = path.join(root, 'legacy');
    const canonicalRoot = path.join(root, 'canonical');
    const attachmentRoot = path.join(root, 'attachments');
    const data = structuredClone(seedData);
    data.materials[0].images = [{
      id: 'lease-image', name: 'lease.png', size: 4, contentType: 'image/png',
      storageKey: 'managed/lease.png', uploadedAt: '2025-01-01T00:00:00.000Z',
    }];
    await writeLegacyData(dataDir, 'first legacy customer');
    await writeFile(path.join(dataDir, 'materials.json'), JSON.stringify(data.materials));
    await mkdir(path.join(attachmentRoot, 'managed'), { recursive: true });
    await writeFile(path.join(attachmentRoot, 'managed/lease.png'), 'data');

    const installed = await bootstrapValidatedFileGeneration({
      canonicalRoot, legacyDir: dataDir, attachmentRoot,
      clock: () => new Date('2025-01-01T00:00:00.000Z'), rollbackAttachmentLeaseMs: 60_000,
    });
    const store = createCanonicalFileAppStore({ rootDir: canonicalRoot, bootstrap: { namespace: installed.generationId, snapshot: installed.snapshot } });
    const installedPin = await store.pin(installed.generationId);
    await store.commit(installedPin, (snapshot) => ({
      ...snapshot,
      materials: snapshot.materials.map((material) => ({ ...material, images: [] })),
      attachments: [],
      operational: { ...snapshot.operational, leases: [] },
    }));
    await rm(path.join(canonicalRoot, 'runtime-attachment-leases', `${installed.generationId}.json`));

    const first = await bootstrapValidatedFileGeneration({
      canonicalRoot, legacyDir: dataDir, attachmentRoot,
      clock: () => new Date('2026-07-14T10:00:00.000Z'), rollbackAttachmentLeaseMs: 60_000,
    });
    const firstPin = await store.pin(first.generationId);
    const firstPersisted = await store.readSnapshot(firstPin);
    expect(firstPersisted.operational.leases).toContainEqual({
      storageKey: 'managed/lease.png', generationId: first.generationId, expiresAt: '2026-07-14T10:01:00.000Z',
    });

    const second = await bootstrapValidatedFileGeneration({
      canonicalRoot, legacyDir: dataDir, attachmentRoot,
      clock: () => new Date('2026-07-20T00:00:00.000Z'), rollbackAttachmentLeaseMs: 60_000,
    });
    const secondPin = await store.pin(first.generationId);
    expect(secondPin.generation).toBe(firstPin.generation);
    expect(second.snapshot.operational.leases).toEqual(firstPersisted.operational.leases);
    expect(JSON.parse(await readFile(path.join(canonicalRoot, 'runtime-attachment-leases', `${first.generationId}.json`), 'utf8')))
      .toMatchObject({ createdAt: '2026-07-14T10:00:00.000Z', expiresAt: '2026-07-14T10:01:00.000Z' });
  });
});
