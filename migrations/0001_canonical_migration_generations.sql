-- Expand-only: legacy app_data remains untouched for rollback compatibility.
CREATE TABLE IF NOT EXISTS canonical_migration_generations (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_migration_source_versions
  ON canonical_migration_generations(
    source_fingerprint,
    converter_version,
    storage_schema_version,
    canonical_schema_version,
    identity_version
  );
