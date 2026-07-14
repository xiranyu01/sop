import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../src/api/client';
import { createApiResourceSaveTransport } from '../../src/persistence/apiResourceSaveTransport';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('API resource save transport', () => {
  it('turns a stale write into a conflict carrying the exact latest server value', async () => {
    const requestFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        error: { kind: 'STALE_RESOURCE', message: 'stale', details: { actualEtag: 'e2' } },
      }, 409))
      .mockResolvedValueOnce(jsonResponse({
        kind: 'materials', name: 'materials/cup', uid: 'uid-1', displayName: 'Server cup', etag: 'e2', archived: false,
        resource: { title: 'Server cup' },
      }));
    const client = new ApiClient({ fetch: requestFetch });
    const transport = createApiResourceSaveTransport<{ title: string }>({
      client, kind: 'materials', encode: (value) => value, decode: (value) => value as { title: string },
    });

    await expect(transport.save('materials/cup', { title: 'Local cup' }, 'e1')).rejects.toEqual({
      kind: 'conflict', message: 'stale', serverValue: { title: 'Server cup' }, serverEtag: 'e2',
    });
    expect(requestFetch).toHaveBeenCalledTimes(2);
  });

  it('accepts a row-size warning as success and classifies validation as terminal', async () => {
    const warning = { kind: 'row_size' as const, resourceName: 'materials/cup', measuredBytes: 1_600_000, limitBytes: 1_800_000 };
    const requestFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        resource: {
          kind: 'materials', name: 'materials/cup', uid: 'uid-1', displayName: 'Cup', etag: 'e2', archived: false,
          resource: { title: 'Cup' },
        },
        warning,
      }))
      .mockResolvedValueOnce(jsonResponse({
        error: { kind: 'VALIDATION', message: 'invalid material' },
      }, 400));
    const transport = createApiResourceSaveTransport<{ title: string }>({
      client: new ApiClient({ fetch: requestFetch }),
      kind: 'materials', encode: (value) => value, decode: (value) => value as { title: string },
    });

    await expect(transport.save('materials/cup', { title: 'Cup' }, 'e1')).resolves.toEqual({ etag: 'e2', warning });
    await expect(transport.save('materials/cup', { title: '' }, 'e2')).rejects.toEqual({
      kind: 'terminal', message: 'invalid material', code: 'VALIDATION',
    });
  });

  it('marks an unstructured network failure as unknown outcome', async () => {
    const transport = createApiResourceSaveTransport<{ title: string }>({
      client: new ApiClient({ fetch: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) }),
      kind: 'materials', encode: (value) => value, decode: (value) => value as { title: string },
    });
    await expect(transport.save('materials/cup', { title: 'Cup' }, 'e1')).rejects.toEqual({
      kind: 'retryable', message: 'Failed to fetch', unknownOutcome: true,
    });
  });
});
