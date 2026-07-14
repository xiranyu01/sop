import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { seedData } from '../fixtures/seed';

const runtimeRoot = path.resolve('test-results/pages-runtime');
const stateDir = path.join(runtimeRoot, 'state');
const seedFile = path.join(runtimeRoot, 'seed.sql');
const wranglerConfig = await readFile('wrangler.toml', 'utf8');
const databaseId = /database_id\s*=\s*"([^"]+)"/.exec(wranglerConfig)?.[1];
if (!databaseId) throw new Error('wrangler.toml must define a D1 database_id for Pages E2E');

await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });

const rows: Record<string, unknown> = {
  metadata: seedData.metadata,
  customers: seedData.customers,
  materials: seedData.materials,
  robotModels: seedData.robotModels,
  scenes: seedData.scenes,
  requirements: seedData.requirements,
  globalFields: seedData.globalFields,
  materialStateRules: seedData.materialStateRules,
};
const sqlValue = (value: unknown) => JSON.stringify(value).replaceAll("'", "''");
const seedSql = Object.entries(rows)
  .map(([key, value]) =>
    `INSERT INTO app_data (key, value, updated_at) VALUES ('${key}', '${sqlValue(value)}', '2026-07-14T00:00:00.000Z');`)
  .join('\n');
await writeFile(seedFile, `${seedSql}\n`, 'utf8');

function runWrangler(args: string[]): void {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed with status ${result.status}`);
}

runWrangler(['d1', 'execute', 'sop-prod', '--local', `--persist-to=${stateDir}`, '--file=schema.sql', '--yes']);
runWrangler(['d1', 'execute', 'sop-prod', '--local', `--persist-to=${stateDir}`, `--file=${seedFile}`, '--yes']);

const child = spawn('pnpm', [
  'exec', 'wrangler', 'pages', 'dev', 'dist',
  '--ip=127.0.0.1', '--port=8787', `--persist-to=${stateDir}`,
  `--d1=DB=${databaseId}`, '--r2=ATTACHMENTS=sop-e2e-attachments',
  '--binding=APP_PASSWORD=e2e-password', '--binding=R2_PUBLIC_BASE_URL=https://assets.example.test',
  '--binding=CANONICAL_BOOTSTRAP_MODE=auto',
  '--compatibility-date=2026-06-25', '--log-level=warn',
], { stdio: 'inherit' });

const stop = () => child.kill('SIGTERM');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

await new Promise<void>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0 || signal === 'SIGTERM') resolve();
    else reject(new Error(`wrangler pages dev exited with code ${code} (${signal ?? 'no signal'})`));
  });
});
