import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { seedData } from '../fixtures/seed';

const runtimeRoot = path.resolve('test-results/runtime');
const dataDir = path.join(runtimeRoot, 'data');

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

const files: Record<string, unknown> = {
  'metadata.json': seedData.metadata,
  'customers.json': seedData.customers,
  'materials.json': seedData.materials,
  'robot-models.json': seedData.robotModels,
  'scenes.json': seedData.scenes,
  'requirements.json': seedData.requirements,
  'global-fields.json': seedData.globalFields,
  'material-state-rules.json': seedData.materialStateRules,
};

await Promise.all(
  Object.entries(files).map(([name, value]) => writeFile(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf-8')),
);

process.env.APP_PASSWORD = 'e2e-password';
process.env.PORT = '8787';
process.env.SOP_DATA_DIR = dataDir;
process.env.SOP_UPLOADS_DIR = path.join(runtimeRoot, 'uploads');
process.env.SOP_EXPORTS_DIR = path.join(runtimeRoot, 'exports');

await import('../../../server/index');
