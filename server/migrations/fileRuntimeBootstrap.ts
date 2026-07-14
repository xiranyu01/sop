import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeCanonicalSnapshot, type CanonicalSnapshot } from '../domain/appStore';
import { referencedManagedStorageKeys } from '../domain/attachmentReachability';
import { addRollbackAttachmentLeases } from '../domain/attachmentService';
import { createCanonicalFileAppStore } from '../store';
import type { MigrationManifest } from './manifest';
import type { MigrationReport } from './report';
import { migrateLegacyFiles } from './runner';
import { reconcileValidatedRuntimeGeneration } from './runtimeGeneration';

export type FileRuntimeBootstrapOptions = {
  canonicalRoot: string;
  legacyDir: string;
  attachmentRoot?: string;
  clock?: () => Date;
  rollbackAttachmentLeaseMs?: number;
};

const defaultRollbackAttachmentLeaseMs = 7 * 24 * 60 * 60_000;

type RollbackLeaseAnchor = {
  generationId: string;
  createdAt: string;
  expiresAt: string;
};

function validateLeaseAnchor(value: unknown, generationId: string): RollbackLeaseAnchor {
  const anchor = value as Partial<RollbackLeaseAnchor>;
  if (!anchor || anchor.generationId !== generationId || typeof anchor.createdAt !== 'string' ||
    typeof anchor.expiresAt !== 'string' || Number.isNaN(new Date(anchor.createdAt).getTime()) ||
    Number.isNaN(new Date(anchor.expiresAt).getTime())) {
    throw new Error(`Canonical runtime attachment lease anchor is malformed: ${generationId}`);
  }
  return anchor as RollbackLeaseAnchor;
}

async function rollbackLeaseAnchor(
  canonicalRoot: string,
  generationId: string,
  rollbackLeaseMs: number,
  clock: () => Date,
): Promise<RollbackLeaseAnchor> {
  const root = path.join(canonicalRoot, 'runtime-attachment-leases');
  const file = path.join(root, `${generationId}.json`);
  try {
    return validateLeaseAnchor(JSON.parse(await readFile(file, 'utf8')), generationId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const created = clock();
  if (Number.isNaN(created.getTime())) throw new Error('Invalid rollback attachment lease clock');
  const anchor: RollbackLeaseAnchor = {
    generationId,
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + rollbackLeaseMs).toISOString(),
  };
  await mkdir(root, { recursive: true });
  try {
    await writeFile(file, JSON.stringify(anchor), { encoding: 'utf8', flag: 'wx' });
    return anchor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return validateLeaseAnchor(JSON.parse(await readFile(file, 'utf8')), generationId);
  }
}

function managedStorageKeys(snapshot: CanonicalSnapshot): Set<string> {
  return new Set([
    ...snapshot.attachments.flatMap((attachment) => attachment.storageKey ? [attachment.storageKey] : []),
    ...referencedManagedStorageKeys(snapshot),
  ]);
}

function generationLeases(
  snapshot: CanonicalSnapshot,
  generationId: string,
  expiresAt: string,
  rollbackSnapshot: CanonicalSnapshot = snapshot,
): CanonicalSnapshot {
  const next = addRollbackAttachmentLeases(snapshot, generationId, expiresAt);
  const managed = new Set([
    ...managedStorageKeys(next),
    ...managedStorageKeys(rollbackSnapshot),
  ]);
  const existing = new Set(next.operational.leases.map((lease) => `${lease.generationId}:${lease.storageKey}`));
  for (const storageKey of managed) {
    const key = `${generationId}:${storageKey}`;
    if (!existing.has(key)) next.operational.leases.push({ storageKey, generationId, expiresAt });
  }
  next.operational.leases = next.operational.leases.map((lease) =>
    lease.generationId === generationId && managed.has(lease.storageKey) ? { ...lease, expiresAt } : lease);
  return next;
}

async function readRuntimeNamespace(file: string): Promise<string | undefined> {
  try {
    const namespace = (await readFile(file, 'utf8')).trim();
    if (!namespace) throw new Error('Canonical runtime namespace marker is empty');
    return namespace;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function loadValidatedGeneration(canonicalRoot: string, generationId: string) {
  const root = path.join(canonicalRoot, 'migration-generations', generationId);
  let manifest: MigrationManifest;
  let report: MigrationReport;
  let encodedSnapshot: string;
  try {
    [manifest, report, encodedSnapshot] = await Promise.all([
      readFile(path.join(root, 'manifest.json'), 'utf8').then((value) => JSON.parse(value) as MigrationManifest),
      readFile(path.join(root, 'report.json'), 'utf8').then((value) => JSON.parse(value) as MigrationReport),
      readFile(path.join(root, 'snapshot.json'), 'utf8'),
    ]);
  } catch (error) {
    throw new Error(`Canonical runtime generation is incomplete or malformed: ${generationId}`, { cause: error });
  }
  if (manifest.lifecycle !== 'VALIDATED') {
    throw new Error(`Canonical runtime generation is not VALIDATED: ${generationId}`);
  }
  const validated = reconcileValidatedRuntimeGeneration({
    generationId,
    lifecycle: manifest.lifecycle,
    sourceFingerprint: manifest.sourceFingerprint,
    storedVersions: {
      converterVersion: manifest.converterVersion,
      storageSchemaVersion: manifest.storageSchemaVersion,
      canonicalSchemaVersion: manifest.canonicalSchemaVersion,
      identityVersion: manifest.identityVersion,
    },
    manifest,
    report,
    encodedSnapshot,
  });
  return validated;
}

async function persistRollbackLeases(
  canonicalRoot: string,
  generation: Awaited<ReturnType<typeof loadValidatedGeneration>>,
  anchor: RollbackLeaseAnchor,
) {
  const bootstrapSnapshot = generationLeases(generation.snapshot, generation.generationId, anchor.expiresAt);
  const store = createCanonicalFileAppStore({
    rootDir: canonicalRoot,
    bootstrap: { namespace: generation.generationId, snapshot: bootstrapSnapshot },
  });
  const pin = await store.pin(generation.generationId);
  const current = await store.readSnapshot(pin);
  const next = generationLeases(current, generation.generationId, anchor.expiresAt, generation.snapshot);
  if (encodeCanonicalSnapshot(current) === encodeCanonicalSnapshot(next)) return { ...generation, snapshot: current };
  const committed = await store.commit(pin, () => next);
  return { ...generation, snapshot: committed.snapshot };
}

async function prepareRuntimeGeneration(
  canonicalRoot: string,
  generationId: string,
  rollbackLeaseMs: number,
  clock: () => Date,
) {
  const generation = await loadValidatedGeneration(canonicalRoot, generationId);
  const anchor = await rollbackLeaseAnchor(canonicalRoot, generationId, rollbackLeaseMs, clock);
  return persistRollbackLeases(canonicalRoot, generation, anchor);
}

export async function bootstrapValidatedFileGeneration(options: FileRuntimeBootstrapOptions) {
  const canonicalRoot = path.resolve(options.canonicalRoot);
  const rollbackLeaseMs = options.rollbackAttachmentLeaseMs ?? defaultRollbackAttachmentLeaseMs;
  if (!Number.isSafeInteger(rollbackLeaseMs) || rollbackLeaseMs < 0) throw new Error('Invalid rollback attachment lease duration');
  const clock = options.clock ?? (() => new Date());
  const marker = path.join(canonicalRoot, 'runtime-namespace');
  const anchored = await readRuntimeNamespace(marker);
  if (anchored) return prepareRuntimeGeneration(canonicalRoot, anchored, rollbackLeaseMs, clock);

  const migration = await migrateLegacyFiles({
    legacyDir: options.legacyDir,
    canonicalRoot,
    attachmentRoot: options.attachmentRoot,
    clock,
  });
  await loadValidatedGeneration(canonicalRoot, migration.generationId);
  await mkdir(canonicalRoot, { recursive: true });
  try {
    await writeFile(marker, `${migration.generationId}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const selected = await readRuntimeNamespace(marker);
  if (!selected) throw new Error('Canonical runtime namespace marker was not published');
  return prepareRuntimeGeneration(canonicalRoot, selected, rollbackLeaseMs, clock);
}
