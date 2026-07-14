import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareD1Database,
  parseBootstrapCliOptions,
} from '../../server/bootstrap/cli';

describe('bootstrap operator CLI', () => {
  it('requires remote credentials only for database operations', () => {
    expect(parseBootstrapCliOptions(['manifest'], {})).toMatchObject({ command: 'manifest', fixtureDir: 'data' });
    expect(parseBootstrapCliOptions(['bootstrap', '--dry-run', '--fixture-dir', 'fixtures'], {})).toMatchObject({
      command: 'bootstrap',
      fixtureDir: 'fixtures',
      dryRun: true,
    });
    expect(() => parseBootstrapCliOptions(['status'], {})).toThrow('CLOUDFLARE_ACCOUNT_ID');
  });

  it('adapts authenticated Cloudflare D1 query responses without exposing the token', async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-token' });
      expect(JSON.parse(String(init?.body))).toEqual({ sql: 'SELECT value FROM SOP_META WHERE key = ?', params: ['repository.bootstrap'] });
      return new Response(JSON.stringify({
        success: true,
        result: [{ success: true, results: [{ value: 'COMPLETE' }], meta: { changes: 0 } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const database = new CloudflareD1Database('account', 'database', 'secret-token', request);
    await expect(database.prepare('SELECT value FROM SOP_META WHERE key = ?')
      .bind('repository.bootstrap').first()).resolves.toEqual({ value: 'COMPLETE' });
    expect(request).toHaveBeenCalledOnce();
  });

  it('reports only Cloudflare error codes/messages on query failure', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      success: false,
      errors: [{ code: 7400, message: 'database unavailable' }],
    }), { status: 503, headers: { 'content-type': 'application/json' } }));
    const database = new CloudflareD1Database('account', 'database', 'secret-token', request);
    await expect(database.prepare('SELECT 1').first()).rejects.toThrow('7400:database unavailable');
  });
});
