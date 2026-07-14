import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AppData } from '../../src/types';
import { canonicalSchemaVersion, decodeCanonicalSnapshot, encodeCanonicalSnapshot } from '../domain/appStore';
import type { D1DatabaseLike, D1PreparedStatementLike } from '../d1Store';
import { converterVersion, migrationFormatVersion, migrationGenerationId, storageSchemaVersion, type MigrationManifest, type MigrationVersions } from './manifest';
import { convertLegacyToV1alpha1, decodeLegacyAppData } from './legacyToV1alpha1';
import { canonicalCardinalities, canonicalIdentities, canonicalSemanticDigest, fingerprintSource } from './semanticProjection';
import { identityVersion, stableHash, stableJson } from './identity';
import type { MigrationReport } from './report';

export const defaultMigrationVersions: MigrationVersions = {
  converterVersion,
  storageSchemaVersion,
  canonicalSchemaVersion,
  identityVersion,
};

export type MigrationInterruptPoint = 'after-building-manifest' | 'after-snapshot' | 'after-report';

export class MigrationInterruptedError extends Error {
  constructor(readonly point: MigrationInterruptPoint) {
    super(`Migration interrupted at ${point}`);
    this.name = 'MigrationInterruptedError';
  }
}

export class MigrationValidationError extends Error {
  constructor(readonly report: MigrationReport) {
    super(`Migration validation failed with ${report.issues.length} issue(s)`);
    this.name = 'MigrationValidationError';
  }
}

export type MigrationRunResult = {
  generationId: string;
  manifest: MigrationManifest;
  report: MigrationReport;
  noOp: boolean;
};

type CommonMigrationOptions = {
  versions?: Partial<MigrationVersions>;
  clock?: () => Date;
  maintenanceEpoch?: number;
  interruptAt?: MigrationInterruptPoint;
  attachmentExists?: (storageKey: string) => boolean | Promise<boolean>;
};

function resolvedVersions(value: Partial<MigrationVersions> = {}): MigrationVersions {
  return { ...defaultMigrationVersions, ...value };
}

function buildManifest(data: AppData, report: MigrationReport, versions: MigrationVersions, now: string, maintenanceEpoch: number): MigrationManifest {
  return {
    formatVersion: migrationFormatVersion,
    generationId: migrationGenerationId(report.sourceFingerprint, versions),
    lifecycle: 'BUILDING',
    sourceFingerprint: report.sourceFingerprint,
    sourceWatermark: data.metadata.appDataSchemaVersion,
    ...versions,
    expectedCardinalities: report.cardinalities,
    expectedIdentities: {},
    recordFingerprints: report.recordFingerprints,
    semanticDigest: report.semanticDigest,
    checkpoints: [
      { name: 'decode-and-convert', completed: true, recordCount: Object.keys(report.recordFingerprints).length, digest: stableHash(stableJson(report.recordFingerprints)) },
      { name: 'snapshot-published', completed: false, recordCount: Object.values(report.cardinalities).reduce((sum, count) => sum + count, 0), digest: report.semanticDigest },
      { name: 'semantic-reconciliation', completed: false, recordCount: Object.keys(report.recordFingerprints).length, digest: report.semanticDigest },
    ],
    maintenanceEpoch,
    createdAt: now,
  };
}

function assertCompatibleManifest(manifest: MigrationManifest, sourceFingerprint: string, versions: MigrationVersions, maintenanceEpoch: number): void {
  if (manifest.sourceFingerprint !== sourceFingerprint || manifest.maintenanceEpoch !== maintenanceEpoch ||
    manifest.converterVersion !== versions.converterVersion || manifest.storageSchemaVersion !== versions.storageSchemaVersion ||
    manifest.canonicalSchemaVersion !== versions.canonicalSchemaVersion || manifest.identityVersion !== versions.identityVersion) {
    throw new Error('Existing migration generation does not match source, versions, or maintenance epoch');
  }
}

function maybeInterrupt(actual: MigrationInterruptPoint | undefined, point: MigrationInterruptPoint): void {
  if (actual === point) throw new MigrationInterruptedError(point);
}

function stableText(value: unknown): string {
  return `${stableJson(value)}\n`;
}

function assertValidatedGeneration(manifest: MigrationManifest, report: MigrationReport, encoded: string): void {
  if (manifest.lifecycle !== 'VALIDATED' || !report.ok) throw new Error('Migration generation is not validated');
  const snapshot = decodeCanonicalSnapshot(encoded);
  const cardinalities = canonicalCardinalities(snapshot);
  const identities = canonicalIdentities(snapshot);
  const semanticDigest = canonicalSemanticDigest(snapshot);
  if (encodeCanonicalSnapshot(snapshot) !== encoded ||
    semanticDigest !== manifest.semanticDigest || semanticDigest !== report.semanticDigest ||
    stableJson(cardinalities) !== stableJson(manifest.expectedCardinalities) || stableJson(cardinalities) !== stableJson(report.cardinalities) ||
    stableJson(identities) !== stableJson(manifest.expectedIdentities) ||
    stableJson(report.recordFingerprints) !== stableJson(manifest.recordFingerprints) ||
    report.sourceFingerprint !== manifest.sourceFingerprint || report.generationId !== manifest.generationId) {
    throw new Error('Validated migration generation failed manifest/report/snapshot reconciliation');
  }
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, file);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function legacyAttachments(data: AppData) {
  return [
    ...data.materials.flatMap((material) => material.images ?? []),
    ...data.scenes.flatMap((scene) => scene.subscenes.flatMap((subscene) => subscene.versions.flatMap((version) => version.attachments ?? []))),
    ...data.requirements.flatMap((requirement) => requirement.versions.flatMap((version) => version.attachments ?? [])),
  ];
}

async function checkAttachmentReachability(data: AppData, report: MigrationReport, exists?: CommonMigrationOptions['attachmentExists']): Promise<void> {
  if (!exists) return;
  for (const attachment of legacyAttachments(data)) {
    if (!attachment.storageKey) continue;
    if (!await exists(attachment.storageKey)) report.issues.push({ code: 'INVALID_LEGACY_DATA', owner: `attachment:${attachment.id}`, path: 'storageKey', message: `managed attachment bytes are not reachable: ${attachment.storageKey}` });
  }
  report.issues.sort((left, right) => stableJson(left) < stableJson(right) ? -1 : stableJson(left) > stableJson(right) ? 1 : 0);
  report.ok = report.issues.length === 0;
}

export async function readLegacyDirectory(legacyDir: string): Promise<AppData> {
  const files = {
    metadata: 'metadata.json', customers: 'customers.json', materials: 'materials.json', robotModels: 'robot-models.json',
    scenes: 'scenes.json', requirements: 'requirements.json', globalFields: 'global-fields.json', materialStateRules: 'material-state-rules.json',
  } as const;
  const entries = await Promise.all(Object.entries(files).map(async ([key, file]) => [key, JSON.parse(await readFile(path.join(legacyDir, file), 'utf8'))]));
  return decodeLegacyAppData(Object.fromEntries(entries));
}

export async function migrateLegacyFiles(options: CommonMigrationOptions & { legacyDir: string; canonicalRoot: string; attachmentRoot?: string }): Promise<MigrationRunResult> {
  const data = await readLegacyDirectory(options.legacyDir);
  const sourceFingerprint = fingerprintSource(data);
  const versions = resolvedVersions(options.versions);
  const id = migrationGenerationId(sourceFingerprint, versions);
  const root = path.join(path.resolve(options.canonicalRoot), 'migration-generations', id);
  const manifestFile = path.join(root, 'manifest.json');
  const snapshotFile = path.join(root, 'snapshot.json');
  const reportFile = path.join(root, 'report.json');
  const maintenanceEpoch = options.maintenanceEpoch ?? 1;
  const existing = await readJson<MigrationManifest>(manifestFile);
  if (existing) {
    assertCompatibleManifest(existing, sourceFingerprint, versions, maintenanceEpoch);
    if (existing.lifecycle === 'VALIDATED') {
      const report = await readJson<MigrationReport>(reportFile);
      const encoded = await readFile(snapshotFile, 'utf8');
      if (!report) throw new Error('Validated migration generation is missing its report');
      assertValidatedGeneration(existing, report, encoded);
      return { generationId: id, manifest: existing, report, noOp: true };
    }
  }
  const conversion = convertLegacyToV1alpha1(data, sourceFingerprint);
  conversion.report.generationId = id;
  const attachmentRoot = path.resolve(options.attachmentRoot ?? path.join(path.dirname(path.resolve(options.legacyDir)), 'uploads'));
  await checkAttachmentReachability(data, conversion.report, options.attachmentExists ?? (async (storageKey) => {
    const file = path.resolve(attachmentRoot, storageKey);
    if (file !== attachmentRoot && !file.startsWith(`${attachmentRoot}${path.sep}`)) return false;
    try { await access(file); return true; } catch { return false; }
  }));
  const now = (options.clock?.() ?? new Date(0)).toISOString();
  let manifest = existing ?? buildManifest(data, conversion.report, versions, now, maintenanceEpoch);
  manifest = { ...manifest, expectedCardinalities: conversion.report.cardinalities, expectedIdentities: canonicalIdentities(conversion.snapshot), recordFingerprints: conversion.report.recordFingerprints, semanticDigest: conversion.report.semanticDigest };
  await atomicWrite(manifestFile, stableText(manifest));
  maybeInterrupt(options.interruptAt, 'after-building-manifest');
  let encoded: string;
  try { encoded = encodeCanonicalSnapshot(conversion.snapshot); }
  catch (error) {
    conversion.report.issues.push({ code: 'INVALID_CANONICAL_DATA', owner: '$', message: error instanceof Error ? error.message : String(error) });
    conversion.report.ok = false;
    await atomicWrite(reportFile, stableText(conversion.report));
    throw new MigrationValidationError(conversion.report);
  }
  await atomicWrite(snapshotFile, encoded);
  manifest.checkpoints[1] = { ...manifest.checkpoints[1], completed: true };
  await atomicWrite(manifestFile, stableText(manifest));
  maybeInterrupt(options.interruptAt, 'after-snapshot');
  await atomicWrite(reportFile, stableText(conversion.report));
  maybeInterrupt(options.interruptAt, 'after-report');
  if (!conversion.report.ok) throw new MigrationValidationError(conversion.report);
  const decoded = decodeCanonicalSnapshot(await readFile(snapshotFile, 'utf8'));
  if (fingerprintSource(canonicalIdentities(decoded)) !== fingerprintSource(manifest.expectedIdentities)) throw new Error('Canonical identity reconciliation failed');
  manifest = { ...manifest, lifecycle: 'VALIDATED', validatedAt: now, checkpoints: manifest.checkpoints.map((checkpoint) => ({ ...checkpoint, completed: true })) };
  await atomicWrite(manifestFile, stableText(manifest));
  assertValidatedGeneration(manifest, conversion.report, encoded);
  return { generationId: id, manifest, report: conversion.report, noOp: false };
}

export type MigrationD1DatabaseLike = D1DatabaseLike & {
  batch?<T = unknown>(statements: D1PreparedStatementLike[]): Promise<T[]>;
};

type MigrationD1Row = { generation_id: string; lifecycle: string; source_fingerprint: string; maintenance_epoch: number; manifest_json: string; snapshot_json: string | null; report_json: string | null };

async function ensureMigrationTables(db: MigrationD1DatabaseLike): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS canonical_migration_generations (
    generation_id TEXT PRIMARY KEY,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('BUILDING', 'VALIDATED')),
    source_fingerprint TEXT NOT NULL,
    converter_version TEXT NOT NULL,
    storage_schema_version TEXT NOT NULL,
    canonical_schema_version TEXT NOT NULL,
    identity_version TEXT NOT NULL,
    maintenance_epoch INTEGER NOT NULL,
    manifest_json TEXT NOT NULL,
    snapshot_json TEXT,
    report_json TEXT,
    created_at TEXT NOT NULL,
    validated_at TEXT
  )`).run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS canonical_migration_source_versions ON canonical_migration_generations(source_fingerprint, converter_version, storage_schema_version, canonical_schema_version, identity_version)').run();
}

export async function migrateLegacyD1(db: MigrationD1DatabaseLike, input: unknown, options: CommonMigrationOptions = {}): Promise<MigrationRunResult> {
  await ensureMigrationTables(db);
  const data = decodeLegacyAppData(input); const sourceFingerprint = fingerprintSource(data); const versions = resolvedVersions(options.versions);
  const id = migrationGenerationId(sourceFingerprint, versions); const maintenanceEpoch = options.maintenanceEpoch ?? 1;
  const existing = await db.prepare('SELECT generation_id, lifecycle, source_fingerprint, maintenance_epoch, manifest_json, snapshot_json, report_json FROM canonical_migration_generations WHERE generation_id = ?').bind(id).first<MigrationD1Row>();
  if (existing) {
    const manifest = JSON.parse(existing.manifest_json) as MigrationManifest; assertCompatibleManifest(manifest, sourceFingerprint, versions, maintenanceEpoch);
    if (existing.lifecycle === 'VALIDATED' && existing.snapshot_json && existing.report_json) {
      const report = JSON.parse(existing.report_json) as MigrationReport;
      assertValidatedGeneration(manifest, report, existing.snapshot_json);
      return { generationId: id, manifest, report, noOp: true };
    }
  }
  const conversion = convertLegacyToV1alpha1(data, sourceFingerprint); const now = (options.clock?.() ?? new Date(0)).toISOString();
  conversion.report.generationId = id;
  await checkAttachmentReachability(data, conversion.report, options.attachmentExists);
  let manifest = existing ? JSON.parse(existing.manifest_json) as MigrationManifest : buildManifest(data, conversion.report, versions, now, maintenanceEpoch);
  manifest = { ...manifest, expectedIdentities: canonicalIdentities(conversion.snapshot) };
  await db.prepare(`INSERT INTO canonical_migration_generations (generation_id, lifecycle, source_fingerprint, converter_version, storage_schema_version, canonical_schema_version, identity_version, maintenance_epoch, manifest_json, created_at)
    VALUES (?, 'BUILDING', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(generation_id) DO UPDATE SET manifest_json = excluded.manifest_json
    WHERE canonical_migration_generations.lifecycle = 'BUILDING' AND canonical_migration_generations.maintenance_epoch = excluded.maintenance_epoch`)
    .bind(id, sourceFingerprint, versions.converterVersion, versions.storageSchemaVersion, versions.canonicalSchemaVersion, versions.identityVersion, maintenanceEpoch, stableJson(manifest), now).run();
  maybeInterrupt(options.interruptAt, 'after-building-manifest');
  let encoded: string;
  try { encoded = encodeCanonicalSnapshot(conversion.snapshot); }
  catch (error) { conversion.report.issues.push({ code: 'INVALID_CANONICAL_DATA', owner: '$', message: error instanceof Error ? error.message : String(error) }); conversion.report.ok = false; encoded = ''; }
  if (!conversion.report.ok) {
    await db.prepare("UPDATE canonical_migration_generations SET report_json = ? WHERE generation_id = ? AND lifecycle = 'BUILDING' AND maintenance_epoch = ?").bind(stableJson(conversion.report), id, maintenanceEpoch).run();
    throw new MigrationValidationError(conversion.report);
  }
  await db.prepare("UPDATE canonical_migration_generations SET snapshot_json = ? WHERE generation_id = ? AND lifecycle = 'BUILDING' AND maintenance_epoch = ?")
    .bind(encoded, id, maintenanceEpoch).run();
  maybeInterrupt(options.interruptAt, 'after-snapshot');
  await db.prepare("UPDATE canonical_migration_generations SET report_json = ? WHERE generation_id = ? AND lifecycle = 'BUILDING' AND maintenance_epoch = ?")
    .bind(stableJson(conversion.report), id, maintenanceEpoch).run();
  maybeInterrupt(options.interruptAt, 'after-report');
  manifest = { ...manifest, lifecycle: 'VALIDATED', validatedAt: now, checkpoints: manifest.checkpoints.map((checkpoint) => ({ ...checkpoint, completed: true })) };
  const statement = db.prepare(`UPDATE canonical_migration_generations SET lifecycle = 'VALIDATED', manifest_json = ?, snapshot_json = ?, report_json = ?, validated_at = ?
    WHERE generation_id = ? AND lifecycle = 'BUILDING' AND maintenance_epoch = ?`)
    .bind(stableJson(manifest), encoded, stableJson(conversion.report), now, id, maintenanceEpoch);
  if (db.batch) await db.batch([statement]); else await statement.run();
  const validated = await db.prepare('SELECT generation_id, lifecycle, source_fingerprint, maintenance_epoch, manifest_json, snapshot_json, report_json FROM canonical_migration_generations WHERE generation_id = ?').bind(id).first<MigrationD1Row>();
  if (!validated || validated.lifecycle !== 'VALIDATED' || !validated.snapshot_json) throw new Error('D1 migration validation publish was rejected by lifecycle/epoch fence');
  assertValidatedGeneration(manifest, conversion.report, validated.snapshot_json);
  return { generationId: id, manifest, report: conversion.report, noOp: false };
}

export async function discardBuildingFileGeneration(canonicalRoot: string, id: string): Promise<void> {
  await rm(path.join(path.resolve(canonicalRoot), 'migration-generations', id), { recursive: true, force: true });
}
