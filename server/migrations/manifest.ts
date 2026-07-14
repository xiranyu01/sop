export const migrationFormatVersion = 'coscene.sop.migration-manifest/v1';
export const converterVersion = 'legacy-to-v1alpha1/v1';
export const storageSchemaVersion = 'canonical-generations/v1';

export type MigrationLifecycle = 'BUILDING' | 'VALIDATED';

export type MigrationCheckpoint = {
  name: string;
  completed: boolean;
  recordCount: number;
  digest: string;
};

export type MigrationManifest = {
  formatVersion: typeof migrationFormatVersion;
  generationId: string;
  lifecycle: MigrationLifecycle;
  sourceFingerprint: string;
  sourceWatermark: string;
  converterVersion: string;
  storageSchemaVersion: string;
  canonicalSchemaVersion: string;
  identityVersion: string;
  expectedCardinalities: Record<string, number>;
  expectedIdentities: Record<string, string[]>;
  recordFingerprints: Record<string, string>;
  semanticDigest: string;
  checkpoints: MigrationCheckpoint[];
  maintenanceEpoch: number;
  createdAt: string;
  validatedAt?: string;
};

export type MigrationVersions = Pick<MigrationManifest,
  'converterVersion' | 'storageSchemaVersion' | 'canonicalSchemaVersion' | 'identityVersion'>;
