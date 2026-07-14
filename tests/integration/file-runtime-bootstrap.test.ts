import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
});
