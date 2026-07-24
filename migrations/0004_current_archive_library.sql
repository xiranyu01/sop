CREATE TABLE IF NOT EXISTS SOP_CURRENT_ARCHIVES (
  resource_name TEXT PRIMARY KEY,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('TASK_SOP', 'REQUIREMENT')),
  archived_from_lifecycle TEXT NOT NULL CHECK (archived_from_lifecycle IN ('DRAFT', 'CONFIRMED')),
  candidate_version_sequence INTEGER,
  candidate_version_label TEXT,
  candidate_source_version_id TEXT,
  archived_at TEXT NOT NULL,
  FOREIGN KEY (resource_name) REFERENCES SOP_CURRENT_RESOURCES(name)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (length(trim(resource_name)) > 0),
  CHECK (
    (archived_from_lifecycle = 'DRAFT'
      AND candidate_version_sequence IS NOT NULL
      AND candidate_version_sequence > 0
      AND candidate_version_label IS NOT NULL
      AND length(trim(candidate_version_label)) > 0)
    OR
    (archived_from_lifecycle = 'CONFIRMED'
      AND candidate_version_sequence IS NULL
      AND candidate_version_label IS NULL
      AND candidate_source_version_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS SOP_CURRENT_ARCHIVES_KIND_TIME
  ON SOP_CURRENT_ARCHIVES(resource_kind, archived_at DESC, resource_name ASC);
