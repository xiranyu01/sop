import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    stdio: 'inherit',
    env: { ...process.env, CI: '1' },
  });
  if (result.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed with status ${result.status}`);
}

function runWranglerJson(command: string) {
  const result = spawnSync('pnpm', [
    'exec', 'wrangler', 'd1', 'execute', 'sop-prod', '--local', `--persist-to=${stateDir}`,
    `--command=${command}`, '--yes', '--json',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as Array<{ results?: Array<Record<string, unknown>>; meta?: { changes?: number } }>;
}

function startPages(port: number): ChildProcess {
  return spawn('pnpm', [
    'exec', 'wrangler', 'pages', 'dev', 'dist',
    '--ip=127.0.0.1', `--port=${port}`, `--persist-to=${stateDir}`,
    `--d1=DB=${databaseId}`, '--r2=ATTACHMENTS=sop-e2e-attachments',
    '--binding=APP_PASSWORD=e2e-password', '--binding=R2_PUBLIC_BASE_URL=https://assets.example.test',
    '--binding=CANONICAL_ROLLBACK_LEASE_DAYS=14',
    '--compatibility-date=2026-06-25', '--log-level=warn',
  ], { stdio: 'inherit' });
}

async function stopPages(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('wrangler pages dev did not stop')), 5_000)),
  ]);
}

async function waitForResponse(port: number, expectedStatus: number): Promise<Response> {
  const deadline = Date.now() + 20_000;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/canonical-data`, {
        headers: { authorization: 'Bearer e2e-password' },
      });
      lastStatus = response.status;
      if (response.status === expectedStatus) return response;
    } catch {
      // The local Pages server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Pages API did not reach status ${expectedStatus}; last status was ${lastStatus ?? 'unreachable'}`);
}

runWrangler([
  'd1', 'execute', 'sop-prod', '--local', `--persist-to=${stateDir}`,
  '--command=CREATE TABLE app_data (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)', '--yes',
]);
runWrangler(['d1', 'migrations', 'apply', 'sop-prod', '--local', `--persist-to=${stateDir}`]);
runWrangler(['d1', 'execute', 'sop-prod', '--local', `--persist-to=${stateDir}`, `--file=${seedFile}`, '--yes']);

const prepareServer = startPages(8788);
const prepared = await waitForResponse(8788, 503);
const { candidateNamespace } = await prepared.json() as { candidateNamespace?: string };
if (!candidateNamespace?.match(/^v1alpha1-[a-f0-9]+$/)) throw new Error(`Invalid candidate namespace: ${candidateNamespace}`);
await stopPages(prepareServer);

runWranglerJson(`INSERT OR IGNORE INTO canonical_store_meta (key, value)
  SELECT 'runtime_namespace', '${candidateNamespace}'
  FROM canonical_migration_generations AS generation
  WHERE generation.generation_id = '${candidateNamespace}'
    AND generation.lifecycle = 'VALIDATED'
    AND EXISTS (
      SELECT 1 FROM canonical_namespaces AS namespace
      WHERE namespace.namespace = generation.generation_id AND namespace.writable = 0
    )`);

const frozenServer = startPages(8788);
await waitForResponse(8788, 200);
const lockedMutation = await fetch('http://127.0.0.1:8788/api/customers', {
  method: 'POST',
  headers: { authorization: 'Bearer e2e-password', 'content-type': 'application/json' },
  body: JSON.stringify({ ...seedData.customers[0], name: 'must remain frozen' }),
});
if (lockedMutation.status !== 423) throw new Error(`Frozen namespace mutation returned ${lockedMutation.status}, expected 423`);
await stopPages(frozenServer);

const namespaceState = runWranglerJson(
  `SELECT epoch FROM canonical_namespaces WHERE namespace = '${candidateNamespace}' AND writable = 0`,
)[0]?.results?.[0];
const epoch = Number(namespaceState?.epoch);
if (!Number.isSafeInteger(epoch)) throw new Error(`Frozen namespace epoch is invalid: ${String(namespaceState?.epoch)}`);

runWranglerJson(`INSERT OR IGNORE INTO canonical_store_meta (key, value)
  SELECT 'writes_reopened:${candidateNamespace}', datetime('now')
  FROM canonical_namespaces
  WHERE namespace = '${candidateNamespace}' AND epoch = ${epoch} AND writable = 0`);
runWranglerJson(`UPDATE canonical_namespaces
  SET epoch = epoch + 1, writable = 1, updated_at = datetime('now')
  WHERE namespace = '${candidateNamespace}' AND epoch = ${epoch} AND writable = 0
    AND EXISTS (
      SELECT 1 FROM canonical_store_meta WHERE key = 'writes_reopened:${candidateNamespace}'
    )`);
runWranglerJson(`DELETE FROM canonical_store_meta
  WHERE key = 'runtime_namespace' AND value = '${candidateNamespace}'
    AND NOT EXISTS (
      SELECT 1 FROM canonical_store_meta WHERE key = 'writes_reopened:${candidateNamespace}'
    )
    AND EXISTS (
      SELECT 1 FROM canonical_namespaces WHERE namespace = '${candidateNamespace}' AND writable = 0
    )`);

const fenceRows = runWranglerJson(`SELECT key FROM canonical_store_meta
  WHERE key IN ('runtime_namespace', 'writes_reopened:${candidateNamespace}')`)[0]?.results ?? [];
if (fenceRows.length !== 2) throw new Error(`Post-reopen runtime marker rollback unexpectedly succeeded: ${JSON.stringify(fenceRows)}`);

const reopened = runWranglerJson(`SELECT namespace, epoch, writable
  FROM canonical_namespaces WHERE namespace = '${candidateNamespace}'`)[0]?.results?.[0];
if (reopened?.writable !== 1 || reopened.epoch !== epoch + 1) {
  throw new Error(`Reopen CAS did not publish the expected state: ${JSON.stringify(reopened)}`);
}

const child = startPages(8787);

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
