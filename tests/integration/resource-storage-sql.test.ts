import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resourceStorageMigrationSql, resourceStorageMigrationsSql } from '../helpers/resourceStorageMigrations';

const sqliteAvailable = spawnSync('sqlite3', ['--version'], {
  encoding: 'utf8',
}).status === 0;

type SqliteResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runSql(sql: string): SqliteResult {
  const result = spawnSync('sqlite3', ['-batch', '-bail', ':memory:'], {
    input: `${resourceStorageMigrationsSql}\n${sql}\n`,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function expectSqlError(sql: string, message: string): void {
  const result = runSql(sql);
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain(message);
}

const draftRoot = /* sql */ `
  INSERT INTO SOP_CURRENT_RESOURCES (
    name, uid, kind, source_id, display_name, lifecycle,
    candidate_version_sequence, candidate_version_label,
    current_revision_name, reviewed_manifest_digest, etag,
    proto_schema, proto_json, archived_at, created_at, updated_at
  ) VALUES (
    'taskSops/task-1', 'task-uid-1', 'TASK_SOP', NULL, 'Task 1', 'DRAFT',
    1, '1.0.0', NULL, 'manifest-v1', 'root-etag-v1',
    'sop.v1.TaskSop', '{}', NULL, '2026-07-14T00:00:00Z', '2026-07-14T00:00:00Z'
  );
`;

const catalogDependency = /* sql */ `
  INSERT INTO SOP_CATALOG_RESOURCES (
    name, uid, kind, source_id, display_name, etag,
    proto_schema, proto_json, archived_at, created_at, updated_at
  ) VALUES (
    'materials/material-1', 'material-uid-1', 'MATERIAL', NULL, 'Material 1',
    'material-etag-v1', 'sop.v1.Material', '{}', NULL,
    '2026-07-14T00:00:00Z', '2026-07-14T00:00:00Z'
  );

  INSERT INTO SOP_REVIEWED_DEPENDENCIES (
    root_name, dependency_role, dependency_name, dependency_uid,
    token_kind, reviewed_token, created_at
  ) VALUES (
    'taskSops/task-1', 'MATERIAL', 'materials/material-1', 'material-uid-1',
    'ETAG', 'material-etag-v1', '2026-07-14T00:00:00Z'
  );
`;

const confirmedRevision = /* sql */ `
  INSERT INTO SOP_REVISIONS (
    name, uid, owner_name, kind, version_sequence, version_label,
    previous_revision_name, revision_origin, lifecycle, export_eligible,
    proto_schema, revision_proto_json, frozen_dependencies_proto_json, created_at
  ) VALUES (
    'taskSops/task-1/revisions/rev-1', 'revision-uid-1', 'taskSops/task-1',
    'TASK_SOP_REVISION', 1, '1.0.0', NULL, 'RUNTIME_CONFIRMED', 'CONFIRMED', 1,
    'sop.v1.TaskSopRevision', '{}', '{}', '2026-07-14T00:01:00Z'
  );
`;

const exportBundle = /* sql */ `
  INSERT INTO SOP_EXPORT_BUNDLES (
    root_revision_name, root_kind, schema_version, renderer_version,
    content_size_bytes, content_sha256, proto_schema, bundle_proto_json, created_at
  ) VALUES (
    'taskSops/task-1/revisions/rev-1', 'TASK_SOP', '1.0.0', 'renderer-1',
    2, '0000000000000000000000000000000000000000000000000000000000000000',
    'sop.v1.ExportBundle', '{}', '2026-07-14T00:01:00Z'
  );
`;

describe.skipIf(!sqliteAvailable)('resource storage SQL contract', () => {
  it('backfills missing material SKUs without changing existing values', () => {
    const result = spawnSync('sqlite3', ['-batch', '-bail', ':memory:'], {
      input: `${resourceStorageMigrationSql.initial}
        INSERT INTO SOP_CATALOG_RESOURCES (
          name, uid, kind, display_name, sku, etag, proto_schema, proto_json, created_at, updated_at
        ) VALUES
          ('materials/existing', 'uid-existing', 'MATERIAL', 'Existing', 'SKU004', 'etag-1', 'Material', '{"sku":"SKU004"}', '2026-01-01', '2026-01-01'),
          ('materials/second', 'uid-second', 'MATERIAL', 'Second', NULL, 'etag-2', 'Material', '{}', '2026-01-03', '2026-01-03'),
          ('materials/first', 'uid-first', 'MATERIAL', 'First', '', 'etag-3', 'Material', '{}', '2026-01-02', '2026-01-02');
        ${resourceStorageMigrationSql.materialSkuBackfill}
        ${resourceStorageMigrationSql.materialSkuBackfill}
        SELECT name || '|' || sku || '|' || json_extract(proto_json, '$.sku')
        FROM SOP_CATALOG_RESOURCES
        WHERE kind = 'MATERIAL'
        ORDER BY created_at;
      `,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      'materials/existing|SKU004|SKU004\nmaterials/first|SKU005|SKU005\nmaterials/second|SKU006|SKU006',
    );
  });

  it('backfills bounded Requirement summary projections when upgrading an existing database', () => {
    const result = spawnSync('sqlite3', ['-batch', '-bail', ':memory:'], {
      input: `${resourceStorageMigrationSql.initial}
        INSERT INTO SOP_CURRENT_RESOURCES (
          name, uid, kind, display_name, lifecycle, candidate_version_sequence, candidate_version_label,
          etag, proto_schema, proto_json, created_at, updated_at
        ) VALUES (
          'requirements/legacy', 'legacy-uid', 'REQUIREMENT', 'Legacy', 'DRAFT', 1, '1.0.0',
          'etag-1', 'coscene.sop.v1alpha1.Requirement',
          '{"spec":{"projectDisplayName":"Legacy Project","deadline":{"year":2026,"month":9,"day":3},"productionItems":[{},{}],"aggregateTarget":{"duration":"5400s"}}}',
          '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z'
        );
        INSERT INTO SOP_CURRENT_RESOURCES (
          name, uid, kind, display_name, lifecycle, candidate_version_sequence, candidate_version_label,
          etag, proto_schema, proto_json, created_at, updated_at
        ) VALUES (
          'requirements/partial', 'partial-uid', 'REQUIREMENT', 'Partial', 'DRAFT', 1, '1.0.0',
          'etag-2', 'coscene.sop.v1alpha1.Requirement',
          '{"spec":{"projectDisplayName":"","deadline":{"month":12,"day":25}}}',
          '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z'
        );
        INSERT INTO SOP_CURRENT_RESOURCES (
          name, uid, kind, display_name, lifecycle, candidate_version_sequence, candidate_version_label,
          etag, proto_schema, proto_json, created_at, updated_at
        ) VALUES (
          'requirements/snake', 'snake-uid', 'REQUIREMENT', 'Snake', 'DRAFT', 1, '1.0.0',
          'etag-3', 'coscene.sop.v1alpha1.Requirement',
          '{"spec":{"project_display_name":"Snake Project","production_items":[{}],"aggregate_target":{"duration":"3600s"}}}',
          '2026-07-15T00:00:00Z', '2026-07-15T00:00:00Z'
        );
        ${resourceStorageMigrationSql.requirementSummaryProjection}
        SELECT project_display_name || '|' || deadline || '|' || production_item_count || '|' || aggregate_duration
        FROM SOP_CURRENT_RESOURCES WHERE name = 'requirements/legacy';
        SELECT COALESCE(project_display_name, 'NULL') || '|' || deadline || '|' || production_item_count
        FROM SOP_CURRENT_RESOURCES WHERE name = 'requirements/partial';
        SELECT project_display_name || '|' || production_item_count || '|' || aggregate_duration
        FROM SOP_CURRENT_RESOURCES WHERE name = 'requirements/snake';
      `,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      'Legacy Project|2026-09-03|2|5400s\nNULL|0000-12-25|0\nSnake Project|1|3600s',
    );
  });

  it('parses the fresh schema and creates the complete physical model', () => {
    const result = runSql(/* sql */ `
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name LIKE 'SOP_%'
      ORDER BY name;
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toEqual([
      'SOP_ATTACHMENT_METADATA',
      'SOP_ATTACHMENT_PART_RESERVATIONS',
      'SOP_ATTACHMENT_UPLOADS',
      'SOP_CATALOG_RESOURCES',
      'SOP_CONFIRMATION_COMMANDS',
      'SOP_CURRENT_ARCHIVES',
      'SOP_CURRENT_RESOURCES',
      'SOP_EXPORT_BUNDLES',
      'SOP_META',
      'SOP_REVIEWED_DEPENDENCIES',
      'SOP_REVISIONS',
    ]);
  });

  it('keeps revisions and export bundles immutable', () => {
    const seed = `${draftRoot}\n${confirmedRevision}\n${exportBundle}`;

    expectSqlError(
      `${seed}\nUPDATE SOP_REVISIONS SET version_label = 'changed' WHERE uid = 'revision-uid-1';`,
      'immutable revision',
    );
    expectSqlError(
      `${seed}\nDELETE FROM SOP_REVISIONS WHERE uid = 'revision-uid-1';`,
      'immutable revision',
    );
    expectSqlError(
      `${seed}\nUPDATE SOP_EXPORT_BUNDLES SET renderer_version = 'changed';`,
      'immutable export bundle',
    );
    expectSqlError(
      `${seed}\nDELETE FROM SOP_EXPORT_BUNDLES;`,
      'immutable export bundle',
    );
  });

  it('rejects confirmation when the root etag is stale', () => {
    expectSqlError(
      `${draftRoot}
       INSERT INTO SOP_CONFIRMATION_COMMANDS (
         command_id, root_name, expected_etag, reviewed_manifest_digest,
         target_revision_name, created_at
       ) VALUES (
         'confirm-stale', 'taskSops/task-1', 'root-etag-stale', 'manifest-v1',
         'taskSops/task-1/revisions/rev-1', '2026-07-14T00:01:00Z'
       );`,
      'confirmation guard: stale root',
    );
  });

  it('rejects confirmation when a reviewed dependency has drifted', () => {
    expectSqlError(
      `${draftRoot}
       ${catalogDependency}
       UPDATE SOP_CATALOG_RESOURCES
       SET etag = 'material-etag-v2', updated_at = '2026-07-14T00:01:00Z'
       WHERE name = 'materials/material-1';
       INSERT INTO SOP_CONFIRMATION_COMMANDS (
         command_id, root_name, expected_etag, reviewed_manifest_digest,
         target_revision_name, created_at
       ) VALUES (
         'confirm-drift', 'taskSops/task-1', 'root-etag-v1', 'manifest-v1',
         'taskSops/task-1/revisions/rev-1', '2026-07-14T00:01:00Z'
       );`,
      'confirmation guard: dependency changed',
    );
  });

  it('allows a valid guarded confirmation transaction', () => {
    const result = runSql(/* sql */ `
      ${draftRoot}
      ${catalogDependency}
      BEGIN IMMEDIATE;
      INSERT INTO SOP_CONFIRMATION_COMMANDS (
        command_id, root_name, expected_etag, reviewed_manifest_digest,
        target_revision_name, created_at
      ) VALUES (
        'confirm-valid', 'taskSops/task-1', 'root-etag-v1', 'manifest-v1',
        'taskSops/task-1/revisions/rev-1', '2026-07-14T00:01:00Z'
      );
      ${confirmedRevision}
      ${exportBundle}
      UPDATE SOP_CURRENT_RESOURCES
      SET lifecycle = 'CONFIRMED',
          candidate_version_sequence = NULL,
          candidate_version_label = NULL,
          current_revision_name = 'taskSops/task-1/revisions/rev-1',
          etag = 'root-etag-v2',
          updated_at = '2026-07-14T00:01:00Z'
      WHERE name = 'taskSops/task-1' AND etag = 'root-etag-v1';
      DELETE FROM SOP_CONFIRMATION_COMMANDS WHERE command_id = 'confirm-valid';
      COMMIT;

      SELECT lifecycle || '|' || current_revision_name || '|'
        || (SELECT count(*) FROM SOP_CONFIRMATION_COMMANDS) || '|'
        || (SELECT count(*) FROM SOP_EXPORT_BUNDLES)
      FROM SOP_CURRENT_RESOURCES
      WHERE name = 'taskSops/task-1';
    `);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(
      'CONFIRMED|taskSops/task-1/revisions/rev-1|0|1',
    );
  });

  it('keeps imported draft checkpoints out of bundles and current pointers', () => {
    const checkpoint = /* sql */ `
      ${draftRoot}
      INSERT INTO SOP_REVISIONS (
        name, uid, owner_name, kind, version_sequence, version_label,
        previous_revision_name, revision_origin, lifecycle, export_eligible,
        proto_schema, revision_proto_json, frozen_dependencies_proto_json, created_at
      ) VALUES (
        'taskSops/task-1/revisions/legacy-draft-1', 'checkpoint-uid-1',
        'taskSops/task-1', 'TASK_SOP_REVISION', 1, 'legacy-draft-1', NULL,
        'IMPORTED_DRAFT_CHECKPOINT', 'DRAFT', 0,
        'sop.v1.TaskSopRevision', '{}', NULL, '2026-07-14T00:01:00Z'
      );
    `;

    expectSqlError(
      `${checkpoint}
       INSERT INTO SOP_EXPORT_BUNDLES (
         root_revision_name, root_kind, schema_version, renderer_version,
         content_size_bytes, content_sha256, proto_schema, bundle_proto_json, created_at
       ) VALUES (
         'taskSops/task-1/revisions/legacy-draft-1', 'TASK_SOP', '1.0.0', 'renderer-1',
         2, '0000000000000000000000000000000000000000000000000000000000000000',
         'sop.v1.ExportBundle', '{}', '2026-07-14T00:01:00Z'
       );`,
      'bundle guard: ineligible root revision',
    );

    expectSqlError(
      `${checkpoint}
       UPDATE SOP_CURRENT_RESOURCES
       SET current_revision_name = 'taskSops/task-1/revisions/legacy-draft-1'
       WHERE name = 'taskSops/task-1';`,
      'current pointer guard: ineligible revision',
    );
  });
});
