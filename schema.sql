CREATE TABLE IF NOT EXISTS app_data (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Expand-only canonical migration namespace. It is deliberately separate from
-- app_data and does not create or update an active-generation marker.
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

-- Canonical runtime repository. Requests still use CREATE TABLE IF NOT EXISTS
-- defensively, but production must install these tables before deployment.
CREATE TABLE IF NOT EXISTS canonical_store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS canonical_namespaces (
  namespace TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  writable INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
