import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { GlobalFieldSchema } from '../../../gen/coscene/sop/v1alpha1/catalog_pb';
import { GlobalFieldGroup, GlobalFieldStatus } from '../../../gen/coscene/sop/v1alpha1/common_pb';
import { toDomainJson } from '../../../shared/domain/codec';
import { assertValidDomainMessage } from '../../../shared/domain/validation';
import {
  parseLocalDevOptions,
  readWranglerLocalBindings,
  localPagesArgs,
  runLocalDevCli,
  spawnLocalWrangler,
  stopLocalWrangler,
  waitForLocalWrangler,
  withLocalD1,
} from '../../../server/bootstrap/localDev';
import { repositoryReleaseManifest } from '../../../server/bootstrap/releaseManifest';
import { repositoryReadiness } from '../../../server/bootstrap/status';
import { deterministicUid, resourceName } from '../../../server/domain/identity';
import {
  createD1ResourceRepository,
  type D1DatabaseLike,
} from '../../../server/repositories/d1ResourceRepository';

const host = '127.0.0.1';
const publicPort = 8787;
// Keep the restart probe off Pages' default 8788 so E2E can run while a
// developer has the normal local service open.
const preflightPort = 8790;
const password = 'e2e-password';
const capacityGlobalFieldCount = 1_200;
const minimumCapacityEntityCount = 1_250;
const capacityGlobalFieldPrefix = 'zzzz-e2e-capacity';

await mkdir(path.resolve('test-results'), { recursive: true });
const runtimeRoot = await mkdtemp(path.resolve('test-results/pages-runtime-'));
const stateDir = path.join(runtimeRoot, 'state');
const localBindings = await readWranglerLocalBindings(undefined, stateDir);
const subprocessEnvironment = {
  ...process.env,
  CI: '1',
};

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
  database: D1DatabaseLike,
  repository: ReturnType<typeof createD1ResourceRepository>,
): Promise<void> {
  const startedAt = Date.now();
  for (let index = 0; index < capacityGlobalFieldCount; index += 1) {
    await repository.createCatalog(capacityGlobalFieldWrite(index));
  }

  const counts = await database.prepare(`SELECT
    (SELECT COUNT(*) FROM SOP_CATALOG_RESOURCES) +
    (SELECT COUNT(*) FROM SOP_CURRENT_RESOURCES) +
    (SELECT COUNT(*) FROM SOP_REVISIONS) +
    (SELECT COUNT(*) FROM SOP_EXPORT_BUNDLES) AS total`).first<{ total: number }>();
  const total = Number(counts?.total ?? 0);
  if (total < minimumCapacityEntityCount) {
    throw new Error(`Pages E2E capacity seed produced ${total} repository entities; expected at least ${minimumCapacityEntityCount}`);
  }
  console.log(
    `Pages E2E capacity seed added ${capacityGlobalFieldCount} GlobalFields; ${total} repository entities ready in ${Date.now() - startedAt} ms`,
  );
}

async function bootstrapLocalDatabase(): Promise<void> {
  await runLocalDevCli(
    parseLocalDevOptions(['init', '--persist-to', stateDir]),
    () => undefined,
  );

  await withLocalD1(stateDir, async (database) => {
    let etagSequence = 0;
    const repository = createD1ResourceRepository(database, {
      clock: () => '2026-07-14T00:00:00.000Z',
      createEtag: () => `e2e-etag-${++etagSequence}`,
    });
    await seedCapacityGlobalFields(database, repository);
    const readiness = await repositoryReadiness(repository, repositoryReleaseManifest);
    if (!readiness.ready) throw new Error(`Local repository is not ready: ${readiness.reason}`);
  });
}

function startPages(port: number): ChildProcess {
  const pagesArgs = localPagesArgs(
    localBindings,
    parseLocalDevOptions(['serve', '--port', String(port), '--persist-to', stateDir]),
  );
  return spawnLocalWrangler([
    ...pagesArgs,
    `--ip=${host}`,
    `--binding=APP_PASSWORD=${password}`,
    '--binding=R2_PUBLIC_BASE_URL=https://assets.example.test',
    '--log-level=warn',
  ], { sourceEnvironment: subprocessEnvironment });
}

async function stopPages(child: ChildProcess): Promise<void> {
  await stopLocalWrangler(child);
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

  await waitForLocalWrangler(server, 'Pages E2E runtime', true);
} finally {
  if (server) await stopPages(server);
  await rm(runtimeRoot, { recursive: true, force: true });
}
