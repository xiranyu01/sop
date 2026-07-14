import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import path from 'node:path';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { GlobalFieldSchema } from '../../../gen/coscene/sop/v1alpha1/catalog_pb';
import { GlobalFieldGroup, GlobalFieldStatus } from '../../../gen/coscene/sop/v1alpha1/common_pb';
import { toDomainJson } from '../../../shared/domain/codec';
import { assertValidDomainMessage } from '../../../shared/domain/validation';
import {
  bootstrapRepository,
} from '../../../server/bootstrap/repository';
import {
  assertPreparedDataMatchesRelease,
  loadRepositoryFixtures,
} from '../../../server/bootstrap/cli';
import { prepareRepositoryData } from '../../../server/bootstrap/repositoryData';
import { repositoryReleaseManifest } from '../../../server/bootstrap/releaseManifest';
import { repositoryReadiness } from '../../../server/bootstrap/status';
import { deterministicUid, resourceName } from '../../../server/domain/identity';
import {
  createD1ResourceRepository,
  type D1AllResultLike,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1RunResultLike,
} from '../../../server/repositories/d1ResourceRepository';

const host = '127.0.0.1';
const publicPort = 8787;
const preflightPort = 8788;
const password = 'e2e-password';
const databaseName = 'sop-prod';
const capacityGlobalFieldCount = 1_200;
const minimumCapacityEntityCount = 1_250;
const capacityGlobalFieldPrefix = 'zzzz-e2e-capacity';
const wranglerConfig = await readFile('wrangler.toml', 'utf8');
const databaseId = /database_id\s*=\s*"([^"]+)"/.exec(wranglerConfig)?.[1];
if (!databaseId) throw new Error('wrangler.toml must define a D1 database_id for Pages E2E');

await mkdir(path.resolve('test-results'), { recursive: true });
const runtimeRoot = await mkdtemp(path.resolve('test-results/pages-runtime-'));
const stateDir = path.join(runtimeRoot, 'state');
const wranglerLog = path.join(runtimeRoot, 'wrangler.log');
const subprocessEnvironment = {
  ...process.env,
  CI: '1',
  WRANGLER_LOG: 'error',
  WRANGLER_LOG_PATH: wranglerLog,
};

class SqliteStatement implements D1PreparedStatementLike {
  constructor(
    private readonly owner: LocalD1,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqliteStatement(this.owner, this.sql, values);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement().get(...this.sqlValues()) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1AllResultLike<T>> {
    return { results: this.statement().all(...this.sqlValues()) as T[], success: true };
  }

  async run(): Promise<D1RunResultLike> {
    return this.runSync();
  }

  runSync(): D1RunResultLike {
    const result = this.statement().run(...this.sqlValues());
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  private statement(): StatementSync {
    return this.owner.database.prepare(this.sql);
  }

  private sqlValues(): SQLInputValue[] {
    return this.values as SQLInputValue[];
  }
}

class LocalD1 implements D1DatabaseLike {
  readonly database: DatabaseSync;

  constructor(filename: string) {
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA foreign_keys = ON');
  }

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteStatement(this, sql);
  }

  async batch<T extends D1RunResultLike = D1RunResultLike>(statements: D1PreparedStatementLike[]): Promise<T[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteStatement)) throw new TypeError('Unexpected local D1 statement');
        return statement.runSync() as T;
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}

function capacityGlobalFieldWrite(index: number) {
  const ordinal = String(index).padStart(4, '0');
  const sourceId = `${capacityGlobalFieldPrefix}-${ordinal}`;
  const label = `E2E 容量字段 ${ordinal}`;
  const now = new Date('2026-07-14T00:00:00.000Z');
  const message = create(GlobalFieldSchema, {
    name: resourceName('globalFields', sourceId),
    uid: deterministicUid('globalField', sourceId),
    sourceId,
    group: GlobalFieldGroup.REFERENCE_OBJECT,
    label,
    value: label,
    description: 'Pages E2E pagination capacity row',
    status: GlobalFieldStatus.ACTIVE,
    updateTime: timestampFromDate(now),
    etag: '',
  });
  assertValidDomainMessage(GlobalFieldSchema, message);
  return {
    protoSchema: GlobalFieldSchema.typeName,
    protoJson: JSON.stringify(toDomainJson(GlobalFieldSchema, message)),
    now: now.toISOString(),
  };
}

async function seedCapacityGlobalFields(
  database: LocalD1,
  repository: ReturnType<typeof createD1ResourceRepository>,
): Promise<void> {
  const startedAt = Date.now();
  database.database.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < capacityGlobalFieldCount; index += 1) {
      await repository.createCatalog(capacityGlobalFieldWrite(index));
    }
    database.database.exec('COMMIT');
  } catch (error) {
    database.database.exec('ROLLBACK');
    throw error;
  }

  const counts = database.database.prepare(`SELECT
    (SELECT COUNT(*) FROM SOP_CATALOG_RESOURCES) +
    (SELECT COUNT(*) FROM SOP_CURRENT_RESOURCES) +
    (SELECT COUNT(*) FROM SOP_REVISIONS) +
    (SELECT COUNT(*) FROM SOP_EXPORT_BUNDLES) AS total`).get() as { total: number } | undefined;
  const total = Number(counts?.total ?? 0);
  if (total < minimumCapacityEntityCount) {
    throw new Error(`Pages E2E capacity seed produced ${total} repository entities; expected at least ${minimumCapacityEntityCount}`);
  }
  console.log(
    `Pages E2E capacity seed added ${capacityGlobalFieldCount} GlobalFields; ${total} repository entities ready in ${Date.now() - startedAt} ms`,
  );
}

function runWrangler(args: string[]): void {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: process.cwd(),
    env: subprocessEnvironment,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} failed with status ${result.status ?? 'unknown'}`);
  }
}

async function sqliteFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return sqliteFiles(candidate);
    return entry.isFile() && entry.name.endsWith('.sqlite') && entry.name !== 'metadata.sqlite'
      ? [candidate]
      : [];
  }));
  return nested.flat();
}

async function bootstrapLocalDatabase(): Promise<void> {
  runWrangler([
    'd1', 'migrations', 'apply', databaseName,
    '--local', `--persist-to=${stateDir}`,
  ]);

  const databaseFiles = await sqliteFiles(stateDir);
  if (databaseFiles.length !== 1) {
    throw new Error(`Expected one local D1 database, found ${databaseFiles.length}`);
  }

  // Fixture conversion is an operator/test concern. Pages runtime code never
  // imports this path and only accepts the exact, completed release marker.
  const prepared = prepareRepositoryData(await loadRepositoryFixtures('data'));
  assertPreparedDataMatchesRelease(prepared);
  const database = new LocalD1(databaseFiles[0]);
  try {
    let etagSequence = 0;
    const repository = createD1ResourceRepository(database, {
      clock: () => '2026-07-14T00:00:00.000Z',
      createEtag: () => `e2e-etag-${++etagSequence}`,
    });
    const result = await bootstrapRepository(repository, prepared);
    if (result.state !== 'COMPLETE') throw new Error('Local repository bootstrap did not complete');
    await seedCapacityGlobalFields(database, repository);
    const readiness = await repositoryReadiness(repository, repositoryReleaseManifest);
    if (!readiness.ready) throw new Error(`Local repository is not ready: ${readiness.reason}`);
  } finally {
    database.close();
  }
}

function startPages(port: number): ChildProcess {
  return spawn('pnpm', [
    'exec', 'wrangler', 'pages', 'dev', 'dist',
    `--ip=${host}`, `--port=${port}`, `--persist-to=${stateDir}`,
    `--d1=DB=${databaseId}`, '--r2=ATTACHMENTS=sop-e2e-attachments',
    `--binding=APP_PASSWORD=${password}`,
    '--binding=R2_PUBLIC_BASE_URL=https://assets.example.test',
    '--compatibility-date=2026-06-25', '--log-level=warn',
  ], {
    cwd: process.cwd(),
    env: subprocessEnvironment,
    stdio: 'inherit',
  });
}

async function stopPages(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

async function waitForReady(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastHealth: number | undefined;
  let lastReadiness: number | undefined;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://${host}:${port}/api/health`);
      lastHealth = health.status;
      const readiness = await fetch(`http://${host}:${port}/api/readiness`, {
        headers: { authorization: `Bearer ${password}` },
      });
      lastReadiness = readiness.status;
      if (health.status === 204 && readiness.status === 200) return;
    } catch {
      // Pages is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Pages did not become ready (health=${lastHealth ?? 'unreachable'}, readiness=${lastReadiness ?? 'unreachable'})`,
  );
}

type ResourceProbe = {
  name: string;
  uid: string;
  etag: string;
  resource: Record<string, unknown>;
};

type PersistenceProbe = {
  material: ResourceProbe;
  attachment: { uid: string; objectKey: string; filename: string; sizeBytes: number };
  confirmedRoot: { name: string; etag: string; revisionName: string; yaml: string };
};

async function apiFetch(port: number, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${password}`);
  const response = await fetch(`http://${host}:${port}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response;
}

async function apiJson<T>(port: number, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return apiFetch(port, path, { ...init, headers }).then((response) => response.json() as Promise<T>);
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function normalizedResourceProbe(value: ResourceProbe): ResourceProbe {
  return { name: value.name, uid: value.uid, etag: value.etag, resource: value.resource };
}

function normalizedAttachmentProbe(
  value: PersistenceProbe['attachment'],
): PersistenceProbe['attachment'] {
  return {
    uid: value.uid,
    objectKey: value.objectKey,
    filename: value.filename,
    sizeBytes: value.sizeBytes,
  };
}

async function writePersistenceProbe(port: number): Promise<PersistenceProbe> {
  const created = await apiJson<{ resource: ResourceProbe }>(port, '/api/resources/materials', {
    method: 'POST',
    body: jsonBody({ resource: {
      displayName: 'Pages restart probe material',
      sourceId: 'pages-restart-probe',
      sku: 'RESTART-PROBE',
    } }),
  });
  const updatedProto = { ...created.resource.resource, category: 'persisted-after-runtime-write' };
  const updated = await apiJson<{ resource: ResourceProbe }>(
    port,
    `/api/resources/materials/${encodeURIComponent(created.resource.name)}`,
    {
      method: 'PUT',
      body: jsonBody({ expectedEtag: created.resource.etag, resource: updatedProto }),
    },
  );

  const attachmentBase = `/api/resources/materials/${encodeURIComponent(updated.resource.name)}/attachments`;
  const bytes = new TextEncoder().encode('restart-persisted-attachment');
  const initialized = await apiJson<{ uid: string; objectKey: string }>(port, attachmentBase, {
    method: 'POST',
    body: jsonBody({ filename: 'restart.txt', mediaType: 'text/plain', sizeBytes: bytes.byteLength }),
  });
  await apiFetch(port, `${attachmentBase}/${encodeURIComponent(initialized.uid)}/parts/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: new Blob([bytes]),
  });
  const attachment = await apiJson<PersistenceProbe['attachment']>(
    port,
    `${attachmentBase}/${encodeURIComponent(initialized.uid)}/complete`,
    { method: 'POST' },
  );

  const roots = await apiJson<{ items: Array<{ name: string; lifecycle?: string }> }>(
    port,
    '/api/resources/taskSops?pageSize=200',
  );
  const draftSummary = roots.items.find((item) => item.lifecycle === 'DRAFT');
  if (!draftSummary) throw new Error('Restart probe requires one bootstrap TaskSop draft');
  const rootPath = `/api/resources/taskSops/${encodeURIComponent(draftSummary.name)}`;
  let root = await apiJson<ResourceProbe>(port, rootPath);
  let confirmation = await fetch(`http://${host}:${port}${rootPath}/confirmations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${password}`, 'content-type': 'application/json' },
    body: jsonBody({ expectedEtag: root.etag }),
  });
  if (confirmation.status === 409) {
    const blocked = await confirmation.json() as {
      error?: { kind?: string; details?: { dependencyDiff?: { proposalDigest?: string; rootEtag?: string } } };
    };
    const proposal = blocked.error?.details?.dependencyDiff;
    if (blocked.error?.kind !== 'DEPENDENCY_CHANGED' || !proposal?.proposalDigest || !proposal.rootEtag) {
      throw new Error(`Restart probe confirmation was unexpectedly rejected: ${JSON.stringify(blocked)}`);
    }
    const acknowledged = await apiJson<{ resource: ResourceProbe }>(port, `${rootPath}/review-acknowledgements`, {
      method: 'POST',
      body: jsonBody({ expectedEtag: proposal.rootEtag, proposalDigest: proposal.proposalDigest }),
    });
    root = acknowledged.resource;
    confirmation = await apiFetch(port, `${rootPath}/confirmations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ expectedEtag: root.etag }),
    });
  } else if (!confirmation.ok) {
    throw new Error(`Restart probe confirmation failed with ${confirmation.status}: ${await confirmation.text()}`);
  }
  const confirmed = await confirmation.json() as {
    resource: ResourceProbe;
    revision: { name: string };
  };
  const yaml = await apiFetch(
    port,
    `/api/revisions/${encodeURIComponent(confirmed.revision.name)}/export.yaml`,
  ).then((response) => response.text());

  return {
    material: normalizedResourceProbe(updated.resource),
    attachment: normalizedAttachmentProbe(attachment),
    confirmedRoot: {
      name: confirmed.resource.name,
      etag: confirmed.resource.etag,
      revisionName: confirmed.revision.name,
      yaml,
    },
  };
}

async function readPersistenceProbe(port: number, expected: PersistenceProbe): Promise<PersistenceProbe> {
  const material = await apiJson<ResourceProbe>(
    port,
    `/api/resources/materials/${encodeURIComponent(expected.material.name)}`,
  );
  const attachment = await apiJson<PersistenceProbe['attachment']>(
    port,
    `/api/resources/materials/${encodeURIComponent(expected.material.name)}/attachments/${encodeURIComponent(expected.attachment.uid)}`,
  );
  const confirmedRoot = await apiJson<ResourceProbe>(
    port,
    `/api/resources/taskSops/${encodeURIComponent(expected.confirmedRoot.name)}`,
  );
  const revision = await apiJson<{ name: string }>(
    port,
    `/api/revisions/${encodeURIComponent(expected.confirmedRoot.revisionName)}`,
  );
  const yaml = await apiFetch(
    port,
    `/api/revisions/${encodeURIComponent(expected.confirmedRoot.revisionName)}/export.yaml`,
  ).then((response) => response.text());
  return {
    material: normalizedResourceProbe(material),
    attachment: normalizedAttachmentProbe(attachment),
    confirmedRoot: {
      name: confirmedRoot.name,
      etag: confirmedRoot.etag,
      revisionName: revision.name,
      yaml,
    },
  };
}

async function verifyRestartPersistence(): Promise<void> {
  const first = startPages(preflightPort);
  let before: PersistenceProbe;
  try {
    await waitForReady(preflightPort);
    before = await writePersistenceProbe(preflightPort);
  } finally {
    await stopPages(first);
  }

  const restarted = startPages(preflightPort);
  try {
    await waitForReady(preflightPort);
    const after = await readPersistenceProbe(preflightPort, before);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`Pages restart lost runtime resource/revision/bundle/attachment state: ${JSON.stringify({ before, after })}`);
    }
  } finally {
    await stopPages(restarted);
  }
}

let server: ChildProcess | undefined;
try {
  await bootstrapLocalDatabase();
  await verifyRestartPersistence();
  server = startPages(publicPort);
  await waitForReady(publicPort);
  console.log(`Pages E2E runtime ready at http://${host}:${publicPort}`);

  const requestStop = () => {
    if (server?.exitCode === null) server.kill('SIGTERM');
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM') resolve();
      else reject(new Error(`wrangler pages dev exited with code ${code ?? 'unknown'} (${signal ?? 'no signal'})`));
    });
  });
} finally {
  if (server) await stopPages(server);
  await rm(runtimeRoot, { recursive: true, force: true });
}
