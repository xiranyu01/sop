PRAGMA foreign_keys = ON;

-- Mutable catalog resources. Complex domain content stays in ProtoJSON while
-- the columns below are the query/concurrency projection owned by the server.
CREATE TABLE SOP_CATALOG_RESOURCES (
  name TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'CUSTOMER', 'MATERIAL', 'SCENE', 'GLOBAL_FIELD',
    'MATERIAL_STATE_RULE', 'ATTACHMENT'
  )),
  source_id TEXT,
  display_name TEXT NOT NULL,
  etag TEXT NOT NULL,
  proto_schema TEXT NOT NULL,
  proto_json TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(name)) > 0),
  CHECK (length(trim(uid)) > 0),
  CHECK (length(trim(etag)) > 0),
  CHECK (length(trim(proto_schema)) > 0),
  UNIQUE (kind, uid)
);

CREATE UNIQUE INDEX SOP_CATALOG_KIND_SOURCE_ID
  ON SOP_CATALOG_RESOURCES(kind, source_id)
  WHERE source_id IS NOT NULL AND source_id <> '';
CREATE INDEX SOP_CATALOG_ACTIVE_NAME
  ON SOP_CATALOG_RESOURCES(kind, name)
  WHERE archived_at IS NULL;

-- One mutable row per RobotModel, TaskSop, or Requirement. Revision history is
-- stored independently below and is never encoded as another current row.
CREATE TABLE SOP_CURRENT_RESOURCES (
  name TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ROBOT_MODEL', 'TASK_SOP', 'REQUIREMENT')),
  source_id TEXT,
  display_name TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ACTIVE', 'DRAFT', 'CONFIRMED', 'ARCHIVED')),
  candidate_version_sequence INTEGER,
  candidate_version_label TEXT,
  candidate_source_version_id TEXT,
  current_revision_name TEXT,
  reviewed_manifest_digest TEXT,
  etag TEXT NOT NULL,
  proto_schema TEXT NOT NULL,
  proto_json TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(name)) > 0),
  CHECK (length(trim(uid)) > 0),
  CHECK (length(trim(etag)) > 0),
  CHECK (length(trim(proto_schema)) > 0),
  CHECK (
    (kind = 'ROBOT_MODEL'
      AND lifecycle IN ('ACTIVE', 'ARCHIVED')
      AND candidate_version_sequence IS NULL
      AND candidate_version_label IS NULL
      AND candidate_source_version_id IS NULL)
    OR
    (kind IN ('TASK_SOP', 'REQUIREMENT') AND (
      (lifecycle = 'DRAFT'
        AND candidate_version_sequence IS NOT NULL
        AND candidate_version_sequence > 0
        AND candidate_version_label IS NOT NULL
        AND length(trim(candidate_version_label)) > 0)
      OR
      (lifecycle = 'CONFIRMED'
        AND current_revision_name IS NOT NULL
        AND candidate_version_sequence IS NULL
        AND candidate_version_label IS NULL
        AND candidate_source_version_id IS NULL)
      OR (lifecycle = 'ARCHIVED'
        AND candidate_version_sequence IS NULL
        AND candidate_version_label IS NULL
        AND candidate_source_version_id IS NULL)
    ))
  ),
  UNIQUE (kind, uid),
  FOREIGN KEY (current_revision_name) REFERENCES SOP_REVISIONS(name)
    ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX SOP_CURRENT_KIND_SOURCE_ID
  ON SOP_CURRENT_RESOURCES(kind, source_id)
  WHERE source_id IS NOT NULL AND source_id <> '';
CREATE INDEX SOP_CURRENT_ACTIVE_NAME
  ON SOP_CURRENT_RESOURCES(kind, name)
  WHERE archived_at IS NULL;

-- Immutable confirmed revisions and imported legacy draft checkpoints.
CREATE TABLE SOP_REVISIONS (
  name TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'ROBOT_MODEL_REVISION', 'TASK_SOP_REVISION', 'REQUIREMENT_REVISION'
  )),
  version_sequence INTEGER NOT NULL CHECK (version_sequence > 0),
  version_label TEXT NOT NULL,
  previous_revision_name TEXT,
  revision_origin TEXT NOT NULL CHECK (revision_origin IN (
    'RUNTIME_CONFIRMED', 'IMPORTED_CONFIRMED', 'IMPORTED_DRAFT_CHECKPOINT'
  )),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('DRAFT', 'CONFIRMED')),
  export_eligible INTEGER NOT NULL CHECK (export_eligible IN (0, 1)),
  proto_schema TEXT NOT NULL,
  revision_proto_json TEXT NOT NULL,
  frozen_dependencies_proto_json TEXT,
  created_at TEXT NOT NULL,
  CHECK (length(trim(name)) > 0),
  CHECK (length(trim(uid)) > 0),
  CHECK (length(trim(version_label)) > 0),
  CHECK (previous_revision_name IS NULL OR previous_revision_name <> name),
  CHECK (
    (revision_origin = 'IMPORTED_DRAFT_CHECKPOINT'
      AND kind = 'TASK_SOP_REVISION'
      AND lifecycle = 'DRAFT'
      AND export_eligible = 0)
    OR
    (revision_origin IN ('RUNTIME_CONFIRMED', 'IMPORTED_CONFIRMED')
      AND lifecycle = 'CONFIRMED'
      AND (
        (kind = 'ROBOT_MODEL_REVISION' AND export_eligible = 0)
        OR (kind IN ('TASK_SOP_REVISION', 'REQUIREMENT_REVISION') AND export_eligible = 1)
      ))
  ),
  UNIQUE (kind, uid),
  UNIQUE (owner_name, version_sequence),
  UNIQUE (owner_name, version_label),
  FOREIGN KEY (owner_name) REFERENCES SOP_CURRENT_RESOURCES(name)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (previous_revision_name) REFERENCES SOP_REVISIONS(name)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX SOP_REVISIONS_OWNER_SEQUENCE
  ON SOP_REVISIONS(owner_name, version_sequence);

CREATE TABLE SOP_REVIEWED_DEPENDENCIES (
  root_name TEXT NOT NULL,
  dependency_role TEXT NOT NULL,
  dependency_name TEXT NOT NULL,
  dependency_uid TEXT NOT NULL,
  token_kind TEXT NOT NULL CHECK (token_kind IN ('ETAG', 'REVISION_UID')),
  reviewed_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (root_name, dependency_role, dependency_name),
  CHECK (length(trim(dependency_role)) > 0),
  CHECK (length(trim(dependency_name)) > 0),
  CHECK (length(trim(dependency_uid)) > 0),
  CHECK (length(trim(reviewed_token)) > 0),
  FOREIGN KEY (root_name) REFERENCES SOP_CURRENT_RESOURCES(name)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX SOP_REVIEWED_ROOT_TOKEN
  ON SOP_REVIEWED_DEPENDENCIES(root_name, token_kind, dependency_name);

CREATE TABLE SOP_EXPORT_BUNDLES (
  root_revision_name TEXT PRIMARY KEY,
  root_kind TEXT NOT NULL CHECK (root_kind IN ('TASK_SOP', 'REQUIREMENT')),
  schema_version TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  content_size_bytes INTEGER NOT NULL CHECK (content_size_bytes >= 0),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  proto_schema TEXT NOT NULL,
  bundle_proto_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (root_revision_name) REFERENCES SOP_REVISIONS(name)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE SOP_META (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(key)) > 0)
);

-- This is a transactional guard mechanism, not business state. A successful
-- confirmation inserts the guard first and deletes it in the same D1 batch.
CREATE TABLE SOP_CONFIRMATION_COMMANDS (
  command_id TEXT PRIMARY KEY,
  root_name TEXT NOT NULL UNIQUE,
  expected_etag TEXT NOT NULL,
  reviewed_manifest_digest TEXT NOT NULL,
  target_revision_name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK (length(trim(command_id)) > 0),
  CHECK (length(trim(expected_etag)) > 0),
  CHECK (length(trim(reviewed_manifest_digest)) > 0),
  CHECK (length(trim(target_revision_name)) > 0),
  FOREIGN KEY (root_name) REFERENCES SOP_CURRENT_RESOURCES(name)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TRIGGER SOP_REVISIONS_OWNER_KIND_INSERT
BEFORE INSERT ON SOP_REVISIONS
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM SOP_CURRENT_RESOURCES AS owner
    WHERE owner.name = NEW.owner_name
      AND ((owner.kind = 'ROBOT_MODEL' AND NEW.kind = 'ROBOT_MODEL_REVISION')
        OR (owner.kind = 'TASK_SOP' AND NEW.kind = 'TASK_SOP_REVISION')
        OR (owner.kind = 'REQUIREMENT' AND NEW.kind = 'REQUIREMENT_REVISION'))
  ) THEN RAISE(ABORT, 'revision guard: owner kind mismatch') END;
  SELECT CASE WHEN NEW.previous_revision_name IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM SOP_REVISIONS AS previous
    WHERE previous.name = NEW.previous_revision_name
      AND previous.owner_name = NEW.owner_name
      AND previous.version_sequence < NEW.version_sequence
  ) THEN RAISE(ABORT, 'revision guard: invalid previous revision') END;
END;

CREATE TRIGGER SOP_REVISIONS_IMMUTABLE_UPDATE
BEFORE UPDATE ON SOP_REVISIONS
BEGIN
  SELECT RAISE(ABORT, 'immutable revision');
END;

CREATE TRIGGER SOP_REVISIONS_IMMUTABLE_DELETE
BEFORE DELETE ON SOP_REVISIONS
BEGIN
  SELECT RAISE(ABORT, 'immutable revision');
END;

CREATE TRIGGER SOP_CURRENT_POINTER_INSERT
BEFORE INSERT ON SOP_CURRENT_RESOURCES
WHEN NEW.current_revision_name IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM SOP_REVISIONS AS revision
    WHERE revision.name = NEW.current_revision_name
      AND revision.owner_name = NEW.name
      AND revision.lifecycle = 'CONFIRMED'
      AND revision.revision_origin <> 'IMPORTED_DRAFT_CHECKPOINT'
  ) THEN RAISE(ABORT, 'current pointer guard: ineligible revision') END;
END;

CREATE TRIGGER SOP_CURRENT_POINTER_UPDATE
BEFORE UPDATE OF current_revision_name ON SOP_CURRENT_RESOURCES
WHEN NEW.current_revision_name IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM SOP_REVISIONS AS revision
    WHERE revision.name = NEW.current_revision_name
      AND revision.owner_name = NEW.name
      AND revision.lifecycle = 'CONFIRMED'
      AND revision.revision_origin <> 'IMPORTED_DRAFT_CHECKPOINT'
  ) THEN RAISE(ABORT, 'current pointer guard: ineligible revision') END;
  SELECT CASE WHEN OLD.current_revision_name IS NOT NULL
    AND NEW.current_revision_name <> OLD.current_revision_name
    AND NOT EXISTS (
      SELECT 1
      FROM SOP_REVISIONS AS next_revision
      JOIN SOP_REVISIONS AS previous_revision
        ON previous_revision.name = OLD.current_revision_name
      WHERE next_revision.name = NEW.current_revision_name
        AND next_revision.version_sequence > previous_revision.version_sequence
    ) THEN RAISE(ABORT, 'current pointer guard: revision downgrade') END;
END;

CREATE TRIGGER SOP_CURRENT_CONFIRMED_TO_DRAFT
BEFORE UPDATE OF lifecycle ON SOP_CURRENT_RESOURCES
WHEN OLD.lifecycle = 'CONFIRMED' AND NEW.lifecycle = 'DRAFT'
BEGIN
  SELECT CASE WHEN NEW.kind NOT IN ('TASK_SOP', 'REQUIREMENT')
    OR NEW.current_revision_name IS NOT OLD.current_revision_name
    OR NEW.candidate_version_sequence IS NULL
    OR NEW.candidate_version_label IS NULL
    OR NEW.candidate_version_sequence <= COALESCE((
      SELECT version_sequence FROM SOP_REVISIONS WHERE name = OLD.current_revision_name
    ), 0)
    THEN RAISE(ABORT, 'lifecycle guard: invalid next draft') END;
END;

CREATE TRIGGER SOP_REVIEWED_DEPENDENCY_ROOT_KIND
BEFORE INSERT ON SOP_REVIEWED_DEPENDENCIES
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM SOP_CURRENT_RESOURCES
    WHERE name = NEW.root_name AND kind IN ('TASK_SOP', 'REQUIREMENT')
  ) THEN RAISE(ABORT, 'dependency guard: illegal root') END;
  SELECT CASE WHEN (
    SELECT count(*) FROM SOP_REVIEWED_DEPENDENCIES WHERE root_name = NEW.root_name
  ) >= 500 THEN RAISE(ABORT, 'dependency guard: maximum 500') END;
END;

CREATE TRIGGER SOP_EXPORT_BUNDLE_ELIGIBILITY
BEFORE INSERT ON SOP_EXPORT_BUNDLES
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM SOP_REVISIONS AS revision
    WHERE revision.name = NEW.root_revision_name
      AND revision.lifecycle = 'CONFIRMED'
      AND revision.export_eligible = 1
      AND revision.revision_origin <> 'IMPORTED_DRAFT_CHECKPOINT'
      AND ((NEW.root_kind = 'TASK_SOP' AND revision.kind = 'TASK_SOP_REVISION')
        OR (NEW.root_kind = 'REQUIREMENT' AND revision.kind = 'REQUIREMENT_REVISION'))
  ) THEN RAISE(ABORT, 'bundle guard: ineligible root revision') END;
END;

CREATE TRIGGER SOP_EXPORT_BUNDLES_IMMUTABLE_UPDATE
BEFORE UPDATE ON SOP_EXPORT_BUNDLES
BEGIN
  SELECT RAISE(ABORT, 'immutable export bundle');
END;

CREATE TRIGGER SOP_EXPORT_BUNDLES_IMMUTABLE_DELETE
BEFORE DELETE ON SOP_EXPORT_BUNDLES
BEGIN
  SELECT RAISE(ABORT, 'immutable export bundle');
END;

CREATE TRIGGER SOP_CONFIRMATION_COMMAND_GUARD
BEFORE INSERT ON SOP_CONFIRMATION_COMMANDS
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM SOP_CURRENT_RESOURCES AS root
    WHERE root.name = NEW.root_name
      AND root.kind IN ('TASK_SOP', 'REQUIREMENT')
      AND root.lifecycle = 'DRAFT'
      AND root.etag = NEW.expected_etag
      AND root.reviewed_manifest_digest = NEW.reviewed_manifest_digest
      AND root.archived_at IS NULL
  ) THEN RAISE(ABORT, 'confirmation guard: stale root') END;
  SELECT CASE WHEN substr(NEW.target_revision_name, 1, length(NEW.root_name) + 11)
      <> NEW.root_name || '/revisions/'
    OR EXISTS (
      SELECT 1 FROM SOP_REVISIONS WHERE name = NEW.target_revision_name
    ) THEN RAISE(ABORT, 'confirmation guard: invalid target revision') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM SOP_REVIEWED_DEPENDENCIES AS dependency
    WHERE dependency.root_name = NEW.root_name
      AND (
        (dependency.token_kind = 'ETAG' AND NOT EXISTS (
          SELECT 1 FROM SOP_CATALOG_RESOURCES AS catalog
          WHERE catalog.name = dependency.dependency_name
            AND catalog.uid = dependency.dependency_uid
            AND catalog.etag = dependency.reviewed_token
            AND catalog.archived_at IS NULL
          UNION ALL
          SELECT 1 FROM SOP_CURRENT_RESOURCES AS current_resource
          WHERE current_resource.name = dependency.dependency_name
            AND current_resource.uid = dependency.dependency_uid
            AND current_resource.etag = dependency.reviewed_token
            AND current_resource.archived_at IS NULL
        ))
        OR
        (dependency.token_kind = 'REVISION_UID' AND NOT EXISTS (
          SELECT 1 FROM SOP_REVISIONS AS revision
          WHERE revision.name = dependency.dependency_name
            AND revision.uid = dependency.reviewed_token
            AND revision.uid = dependency.dependency_uid
            AND revision.lifecycle = 'CONFIRMED'
            AND revision.revision_origin <> 'IMPORTED_DRAFT_CHECKPOINT'
        ))
      )
  ) THEN RAISE(ABORT, 'confirmation guard: dependency changed') END;
END;

CREATE TRIGGER SOP_CONFIRMATION_COMMANDS_IMMUTABLE_UPDATE
BEFORE UPDATE ON SOP_CONFIRMATION_COMMANDS
BEGIN
  SELECT RAISE(ABORT, 'confirmation command is immutable');
END;
