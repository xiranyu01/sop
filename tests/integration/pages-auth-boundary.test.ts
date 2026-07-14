import { describe, expect, it } from 'vitest';
import { onRequest } from '../../functions/api/[[path]]';

function inaccessibleDbEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.defineProperty({ ...extra }, 'DB', {
    enumerable: true,
    get(): never {
      throw new Error('DB binding was accessed before authorization');
    },
  });
}

describe('Pages authentication boundary', () => {
  it('keeps only payload-free health public without touching D1', async () => {
    const response = await onRequest({
      request: new Request('https://sop.test/api/health'),
      env: inaccessibleDbEnv(),
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('rejects a protected malformed mutation before body parsing or D1 access', async () => {
    const response = await onRequest({
      request: new Request('https://sop.test/api/resources/materials', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: '{not-json',
      }),
      env: inaccessibleDbEnv({ APP_PASSWORD: 'secret' }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { kind: 'UNAUTHORIZED' } });
  });

  it('protects removed and unknown API routes through the same guard', async () => {
    for (const pathname of ['/api/canonical-data', '/api/unknown']) {
      const response = await onRequest({
        request: new Request(`https://sop.test${pathname}`),
        env: inaccessibleDbEnv({ APP_PASSWORD: 'secret' }),
      });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: { kind: 'UNAUTHORIZED' } });
    }
  });
});
