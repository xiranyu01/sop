import {
  canonicalSchemaVersion,
  decodeCanonicalSnapshot,
  encodeCanonicalSnapshot,
  type CanonicalSnapshot,
} from '../domain/appStore';
import { identityVersion, stableJson } from './identity';
import {
  converterVersion,
  migrationFormatVersion,
  migrationGenerationId,
  storageSchemaVersion,
  type MigrationManifest,
} from './manifest';
import type { MigrationReport } from './report';
import { canonicalCardinalities, canonicalIdentities, canonicalSemanticDigest } from './semanticProjection';

export type StoredRuntimeVersions = {
  converterVersion: string;
  storageSchemaVersion: string;
  canonicalSchemaVersion: string;
  identityVersion: string;
};

export type ValidatedRuntimeGeneration = {
  generationId: string;
  snapshot: CanonicalSnapshot;
  report: MigrationReport;
};

export function reconcileValidatedRuntimeGeneration(input: {
  generationId: string;
  lifecycle: string;
  sourceFingerprint: string;
  storedVersions: StoredRuntimeVersions;
  manifest: MigrationManifest;
  report: MigrationReport;
  encodedSnapshot: string;
}): ValidatedRuntimeGeneration {
  const currentVersions = { converterVersion, storageSchemaVersion, canonicalSchemaVersion, identityVersion };
  const snapshot = decodeCanonicalSnapshot(input.encodedSnapshot);
  const digest = canonicalSemanticDigest(snapshot);
  const reconciled =
    input.lifecycle === 'VALIDATED' &&
    input.manifest.lifecycle === 'VALIDATED' &&
    input.manifest.formatVersion === migrationFormatVersion &&
    input.manifest.generationId === input.generationId &&
    input.report.generationId === input.generationId &&
    input.report.ok &&
    input.generationId === migrationGenerationId(input.sourceFingerprint, currentVersions) &&
    input.sourceFingerprint === input.manifest.sourceFingerprint &&
    input.sourceFingerprint === input.report.sourceFingerprint &&
    stableJson(input.storedVersions) === stableJson(currentVersions) &&
    input.manifest.converterVersion === converterVersion &&
    input.manifest.storageSchemaVersion === storageSchemaVersion &&
    input.manifest.canonicalSchemaVersion === canonicalSchemaVersion &&
    input.manifest.identityVersion === identityVersion &&
    encodeCanonicalSnapshot(snapshot) === input.encodedSnapshot &&
    digest === input.manifest.semanticDigest &&
    digest === input.report.semanticDigest &&
    stableJson(canonicalCardinalities(snapshot)) === stableJson(input.manifest.expectedCardinalities) &&
    stableJson(canonicalCardinalities(snapshot)) === stableJson(input.report.cardinalities) &&
    stableJson(canonicalIdentities(snapshot)) === stableJson(input.manifest.expectedIdentities) &&
    stableJson(input.report.recordFingerprints) === stableJson(input.manifest.recordFingerprints);
  if (!reconciled) throw new Error(`Canonical runtime generation failed reconciliation: ${input.generationId}`);
  return { generationId: input.generationId, snapshot, report: input.report };
}
