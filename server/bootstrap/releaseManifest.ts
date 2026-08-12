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
  datasetDigest: '8a0781484fe425f9ddaa5e4d65887af8a03b9f5b5e69e3d29d573da220f3c3b2',
  expectedCounts: Object.freeze({
    catalogs: 113,
    currents: 6,
    revisions: 6,
    bundles: 2,
  }),
}) satisfies RepositoryBootstrapManifest;
