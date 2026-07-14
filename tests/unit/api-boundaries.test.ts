import { describe, expect, it, vi } from 'vitest';
import { authorizeApiRequest } from '../../server/http/auth';
import { serializeOperationLog } from '../../server/observability';
import { ApiClient, ApiClientError } from '../../src/api/client';

describe('resource API boundaries', () => {
  it('keeps only health public and uses one protected-route error contract', () => {
    expect(authorizeApiRequest(new Request('https://sop.test/api/health'), undefined)).toEqual({ ok: true, publicRoute: true });
    expect(authorizeApiRequest(new Request('https://sop.test/api/materials'), 'secret')).toMatchObject({
      ok: false, status: 401, body: { error: { kind: 'UNAUTHORIZED' } },
    });
    expect(authorizeApiRequest(new Request('https://sop.test/api/not-found'), undefined)).toMatchObject({
      ok: false, status: 503, body: { error: { kind: 'STORAGE_UNAVAILABLE' } },
    });
  });

  it('emits only allow-listed structured fields', () => {
    const value = serializeOperationLog({
      requestId: 'req-1', operation: 'resource.update', outcome: 'failure', durationMs: 12,
      resourceKind: 'materials', resourceName: 'materials/cup', failureClass: 'D1_UNAVAILABLE',
      // @ts-expect-error regression probe: unknown sensitive input must be dropped.
      authorization: 'Bearer secret', password: 'secret', rawBody: '{"business":"payload"}',
    });
    expect(JSON.parse(value)).toEqual({
      event: 'sop_operation', requestId: 'req-1', operation: 'resource.update', outcome: 'failure', durationMs: 12,
      resourceKind: 'materials', resourceName: 'materials/cup', failureClass: 'D1_UNAVAILABLE',
    });
    expect(value).not.toContain('secret');
    expect(value).not.toContain('payload');
  });

  it('sends resource etags and preserves structured errors', async () => {
    const requestFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { kind: 'STALE_RESOURCE', message: 'stale', details: { actualEtag: 'e2' } },
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const client = new ApiClient({ baseUrl: 'https://sop.test', getPassword: () => 'secret', fetch: requestFetch });
    await expect(client.update('materials', 'materials/cup', { displayName: 'Cup' }, 'e1')).rejects.toMatchObject({
      status: 409, body: { error: { kind: 'STALE_RESOURCE', message: 'stale' } },
    } satisfies Partial<ApiClientError>);
    const [url, init] = requestFetch.mock.calls[0];
    expect(url).toBe('https://sop.test/api/resources/materials/materials%2Fcup');
    expect(init.headers.get('authorization')).toBe('Bearer secret');
    expect(JSON.parse(init.body)).toMatchObject({ expectedEtag: 'e1' });
  });
});
