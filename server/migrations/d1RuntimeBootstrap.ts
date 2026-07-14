import type { AppData } from '../../src/types';
import type { D1DatabaseLike } from '../d1Store';
import { canonicalSchemaVersion, encodeCanonicalSnapshot } from '../domain/appStore';
import { convertLegacyToV1alpha1 } from './legacyToV1alpha1';
import { identityVersion, stableHash, stableJson } from './identity';
import { converterVersion, migrationFormatVersion, migrationGenerationId, storageSchemaVersion, type MigrationManifest } from './manifest';
import type { MigrationReport } from './report';
import { canonicalCardinalities, canonicalIdentities } from './semanticProjection';
import { reconcileValidatedRuntimeGeneration } from './runtimeGeneration';

type RuntimeGenerationRow = {
  generation_id: string;
  lifecycle: string;
  source_fingerprint: string;
  converter_version: string;
  storage_schema_version: string;
  canonical_schema_version: string;
  identity_version: string;
  manifest_json: string | null;
  snapshot_json: string | null;
  report_json: string | null;
};

async function ensureRuntimeTables(db: D1DatabaseLike): Promise<void> {
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
  await db.prepare(`CREATE TABLE IF NOT EXISTS canonical_store_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`).run();
}

async function runtimeNamespace(db: D1DatabaseLike): Promise<string | undefined> {
  const row = await db.prepare("SELECT value FROM canonical_store_meta WHERE key = 'runtime_namespace'").first<{ value: string }>();
  return row?.value;
}

async function loadValidatedGeneration(db: D1DatabaseLike, generationId: string) {
  const row = await db.prepare(`SELECT generation_id, lifecycle, source_fingerprint, converter_version, storage_schema_version,
      canonical_schema_version, identity_version, manifest_json, snapshot_json, report_json
    FROM canonical_migration_generations WHERE generation_id = ?`).bind(generationId).first<RuntimeGenerationRow>();
  if (!row) throw new Error(`Canonical runtime generation not found: ${generationId}`);
  if (row.lifecycle !== 'VALIDATED') throw new Error(`Canonical runtime generation is not VALIDATED: ${generationId}`);
  if (!row.manifest_json || !row.snapshot_json || !row.report_json) {
    throw new Error(`Canonical runtime generation is incomplete: ${generationId}`);
  }
  let manifest: MigrationManifest;
  let report: MigrationReport;
  try {
    manifest = JSON.parse(row.manifest_json) as MigrationManifest;
    report = JSON.parse(row.report_json) as MigrationReport;
  } catch (error) {
    throw new Error(`Canonical runtime generation metadata is malformed: ${generationId}`, { cause: error });
  }
  return reconcileValidatedRuntimeGeneration({
    generationId,
    lifecycle: row.lifecycle,
    sourceFingerprint: row.source_fingerprint,
    storedVersions: {
      converterVersion: row.converter_version,
      storageSchemaVersion: row.storage_schema_version,
      canonicalSchemaVersion: row.canonical_schema_version,
      identityVersion: row.identity_version,
    },
    manifest,
    report,
    encodedSnapshot: row.snapshot_json,
  });
}

/** Worker-safe inactive-generation installer used by the Pages runtime.
 * It deliberately has no dependency on the file migration runner or Node APIs.
 */
export async function bootstrapValidatedD1Generation(db: D1DatabaseLike, data: AppData) {
  await ensureRuntimeTables(db);
  const anchored = await runtimeNamespace(db);
  if (anchored) return loadValidatedGeneration(db, anchored);

  const conversion = convertLegacyToV1alpha1(data);
  if (!conversion.report.ok) {
    throw new Error(`Canonical D1 bootstrap validation failed: ${conversion.report.issues.map((item) => item.message).join('; ')}`);
  }
  const versions = { converterVersion, storageSchemaVersion, canonicalSchemaVersion, identityVersion };
  const generationId = migrationGenerationId(conversion.report.sourceFingerprint, versions);
  conversion.report.generationId = generationId;
  const now = new Date().toISOString();
  const recordCount = Object.keys(conversion.report.recordFingerprints).length;
  const snapshotCount = Object.values(conversion.report.cardinalities).reduce((sum, count) => sum + count, 0);
  const manifest = {
    formatVersion: migrationFormatVersion,
    generationId,
    lifecycle: 'VALIDATED',
    sourceFingerprint: conversion.report.sourceFingerprint,
    sourceWatermark: data.metadata.appDataSchemaVersion,
    converterVersion,
    storageSchemaVersion,
    canonicalSchemaVersion,
    identityVersion,
    expectedCardinalities: conversion.report.cardinalities,
    expectedIdentities: canonicalIdentities(conversion.snapshot),
    recordFingerprints: conversion.report.recordFingerprints,
    semanticDigest: conversion.report.semanticDigest,
    checkpoints: [
      { name: 'decode-and-convert', completed: true, recordCount, digest: stableHash(stableJson(conversion.report.recordFingerprints)) },
      { name: 'snapshot-published', completed: true, recordCount: snapshotCount, digest: conversion.report.semanticDigest },
      { name: 'semantic-reconciliation', completed: true, recordCount, digest: conversion.report.semanticDigest },
    ],
    maintenanceEpoch: 1,
    createdAt: now,
    validatedAt: now,
  };
  await db.prepare(`INSERT OR IGNORE INTO canonical_migration_generations
    (generation_id, lifecycle, source_fingerprint, converter_version, storage_schema_version, canonical_schema_version,
      identity_version, maintenance_epoch, manifest_json, snapshot_json, report_json, created_at, validated_at)
    VALUES (?, 'VALIDATED', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .bind(
      generationId,
      conversion.report.sourceFingerprint,
      converterVersion,
      storageSchemaVersion,
      canonicalSchemaVersion,
      identityVersion,
      stableJson(manifest),
      encodeCanonicalSnapshot(conversion.snapshot),
      stableJson(conversion.report),
      now,
      now,
    ).run();
  await loadValidatedGeneration(db, generationId);
  await db.prepare("INSERT OR IGNORE INTO canonical_store_meta (key, value) VALUES ('runtime_namespace', ?)")
    .bind(generationId).run();
  const selected = await runtimeNamespace(db);
  if (!selected) throw new Error('Canonical runtime namespace marker was not published');
  return loadValidatedGeneration(db, selected);
}
