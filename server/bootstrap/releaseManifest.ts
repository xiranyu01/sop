import type { RepositoryBootstrapManifest } from './status';

/**
 * Bootstrap identity expected by this release at runtime.
 *
 * This module is deliberately data-only: request handling may import it without
 * importing repository fixtures or the one-time converter. Update it only from
 * the reviewed output of `server/bootstrap/cli.ts manifest`.
 */
export const repositoryReleaseManifest = Object.freeze({
  schemaVersion: 'resource-storage-v1',
  bootstrapVersion: 'repository-fixtures-v1',
  datasetDigest: 'd268d8ce3b3255beb63220ef4bba1e95f3222b2bbf0980017866e8d7fabd7842',
  expectedCounts: Object.freeze({
    catalogs: 113,
    currents: 6,
    revisions: 6,
    bundles: 2,
  }),
}) satisfies RepositoryBootstrapManifest;
