import { describe, expect, it, vi } from 'vitest';
import { repositoryReleaseManifest } from '../../server/bootstrap/releaseManifest';
import {
  parseRepositoryBootstrapMarker,
  repositoryBootstrapMarkerValue,
  repositoryBootstrapMetaKey,
  repositoryReadiness,
} from '../../server/bootstrap/status';
import type { ResourceRepository } from '../../server/domain/repository';

function repositoryWithMarker(value?: string, audit: () => Promise<void> = async () => undefined): ResourceRepository {
  return {
    getMeta: async (key) => key === repositoryBootstrapMetaKey && value
      ? { key, value, updatedAt: '2026-07-14T00:00:00.000Z' }
      : undefined,
    auditProjectionParity: audit,
  } as ResourceRepository;
}

describe('release bootstrap readiness', () => {
  it('uses a canonical fixed release marker without fixture imports', async () => {
    const value = repositoryBootstrapMarkerValue('COMPLETE', repositoryReleaseManifest);
    expect(parseRepositoryBootstrapMarker(value)).toEqual({
      state: 'COMPLETE',
      schemaVersion: repositoryReleaseManifest.schemaVersion,
      bootstrapVersion: repositoryReleaseManifest.bootstrapVersion,
      datasetDigest: repositoryReleaseManifest.datasetDigest,
      expectedCounts: repositoryReleaseManifest.expectedCounts,
    });
    expect(await repositoryReadiness(repositoryWithMarker(value), repositoryReleaseManifest)).toEqual({ ready: true });
  });

  it.each([
    [undefined, 'bootstrap marker is missing'],
    ['not-json', 'bootstrap marker is malformed'],
    [repositoryBootstrapMarkerValue('IN_PROGRESS', repositoryReleaseManifest), 'bootstrap is incomplete'],
    [repositoryBootstrapMarkerValue('COMPLETE', { ...repositoryReleaseManifest, datasetDigest: 'f'.repeat(64) }), 'bootstrap marker version or digest does not match this release'],
  ])('fails closed for a non-ready marker', async (value, reason) => {
    expect(await repositoryReadiness(repositoryWithMarker(value), repositoryReleaseManifest)).toEqual({ ready: false, reason });
  });

  it('fails readiness when the repository projection audit fails', async () => {
    const audit = vi.fn(async () => { throw new Error('corrupt projected field'); });
    const value = repositoryBootstrapMarkerValue('COMPLETE', repositoryReleaseManifest);
    expect(await repositoryReadiness(repositoryWithMarker(value, audit), repositoryReleaseManifest)).toEqual({
      ready: false,
      reason: 'repository integrity audit failed',
    });
    expect(audit).toHaveBeenCalledOnce();
  });

  it('turns a missing schema or unavailable D1 into a blocking readiness state', async () => {
    const repository = {
      getMeta: async () => { throw new Error('no such table: SOP_META'); },
    } as unknown as ResourceRepository;
    expect(await repositoryReadiness(repository, repositoryReleaseManifest)).toEqual({
      ready: false,
      reason: 'repository is unavailable',
    });
  });
});
