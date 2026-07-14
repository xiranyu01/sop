-- Expand-only canonical runtime tables. Legacy app_data and migration
-- generations remain untouched for compatibility and rollback.
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
