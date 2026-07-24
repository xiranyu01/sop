import { readFileSync } from 'node:fs';

export const resourceStorageMigrationSql = {
  initial: readFileSync(new URL('../../migrations/0001_resource_storage.sql', import.meta.url), 'utf8'),
  requirementSummaryProjection: readFileSync(
    new URL('../../migrations/0002_requirement_summary_projection.sql', import.meta.url),
    'utf8',
  ),
  materialSkuBackfill: readFileSync(
    new URL('../../migrations/0003_backfill_material_skus.sql', import.meta.url),
    'utf8',
  ),
  currentArchiveLibrary: readFileSync(
    new URL('../../migrations/0004_current_archive_library.sql', import.meta.url),
    'utf8',
  ),
} as const;

export const resourceStorageMigrationsSql = Object.values(resourceStorageMigrationSql).join('\n');
