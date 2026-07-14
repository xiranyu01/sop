import type { MetaRecord, ResourceRepository } from '../domain/repository';
import { stableJson } from '../domain/identity';

export const repositoryBootstrapMetaKey = 'repository.bootstrap';

export type RepositoryBootstrapManifest = {
  readonly schemaVersion: string;
  readonly bootstrapVersion: string;
  readonly datasetDigest: string;
  readonly expectedCounts: {
    readonly catalogs: number;
    readonly currents: number;
    readonly revisions: number;
    readonly bundles: number;
  };
};

export type RepositoryBootstrapMarker = RepositoryBootstrapManifest & {
  state: 'IN_PROGRESS' | 'COMPLETE';
};

export function repositoryBootstrapMarkerValue(
  state: RepositoryBootstrapMarker['state'],
  manifest: RepositoryBootstrapManifest,
): string {
  return stableJson({
    state,
    schemaVersion: manifest.schemaVersion,
    bootstrapVersion: manifest.bootstrapVersion,
    datasetDigest: manifest.datasetDigest,
    expectedCounts: manifest.expectedCounts,
  });
}

export function parseRepositoryBootstrapMarker(value: string): RepositoryBootstrapMarker {
  const marker = JSON.parse(value) as Partial<RepositoryBootstrapMarker>;
  if (!marker || !['IN_PROGRESS', 'COMPLETE'].includes(marker.state ?? '') ||
    typeof marker.schemaVersion !== 'string' || typeof marker.bootstrapVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(marker.datasetDigest ?? '') || !marker.expectedCounts ||
    !['catalogs', 'currents', 'revisions', 'bundles'].every((key) =>
      Number.isSafeInteger(marker.expectedCounts?.[key as keyof typeof marker.expectedCounts]) &&
      (marker.expectedCounts?.[key as keyof typeof marker.expectedCounts] ?? -1) >= 0)) {
    throw new TypeError('Malformed repository bootstrap marker');
  }
  return marker as RepositoryBootstrapMarker;
}

export function markerMatches(marker: RepositoryBootstrapMarker, manifest: RepositoryBootstrapManifest): boolean {
  return marker.schemaVersion === manifest.schemaVersion &&
    marker.bootstrapVersion === manifest.bootstrapVersion &&
    marker.datasetDigest === manifest.datasetDigest &&
    marker.expectedCounts.catalogs === manifest.expectedCounts.catalogs &&
    marker.expectedCounts.currents === manifest.expectedCounts.currents &&
    marker.expectedCounts.revisions === manifest.expectedCounts.revisions &&
    marker.expectedCounts.bundles === manifest.expectedCounts.bundles;
}

export async function repositoryReadiness(
  repository: ResourceRepository,
  manifest: RepositoryBootstrapManifest,
): Promise<{ ready: true } | { ready: false; reason: string }> {
  let record: MetaRecord | undefined;
  try {
    record = await repository.getMeta(repositoryBootstrapMetaKey);
  } catch {
    return { ready: false, reason: 'repository is unavailable' };
  }
  if (!record) return { ready: false, reason: 'bootstrap marker is missing' };
  let marker: RepositoryBootstrapMarker;
  try { marker = parseRepositoryBootstrapMarker(record.value); } catch {
    return { ready: false, reason: 'bootstrap marker is malformed' };
  }
  if (!markerMatches(marker, manifest)) return { ready: false, reason: 'bootstrap marker version or digest does not match this release' };
  if (marker.state !== 'COMPLETE') return { ready: false, reason: 'bootstrap is incomplete' };
  if (record.value !== repositoryBootstrapMarkerValue('COMPLETE', manifest)) {
    return { ready: false, reason: 'bootstrap marker is not canonical' };
  }
  try {
    await repository.auditProjectionParity();
  } catch {
    return { ready: false, reason: 'repository integrity audit failed' };
  }
  return { ready: true };
}
