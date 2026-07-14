import { describe, expect, it } from 'vitest';
import {
  hasConfiguredAppPassword,
  localBindingsFromWranglerConfig,
  localMigrationArgs,
  localOnlyEnvironment,
  localPagesArgs,
  parseLocalDevOptions,
} from '../../server/bootstrap/localDev';

const wranglerConfig = {
  compatibility_date: '2026-06-25',
  d1_databases: [{
    binding: 'DB',
    database_name: 'sop-prod',
    database_id: 'production-id',
    preview_database_id: 'local-id',
  }],
  r2_buckets: [{
    binding: 'ATTACHMENTS',
    bucket_name: 'sop-attachments',
    preview_bucket_name: 'sop-local-attachments',
  }],
};

describe('local development operator', () => {
  it('parses only local-safe commands and keeps paths as individual arguments', () => {
    expect(parseLocalDevOptions(['init'])).toEqual({
      command: 'init',
      fixtureDir: 'data',
      persistTo: '.wrangler/local',
      port: 8788,
    });
    expect(parseLocalDevOptions([
      'serve', '--persist-to', '/tmp/本地 state', '--fixture-dir', 'fixture data', '--port', '9000',
    ])).toEqual({
      command: 'serve',
      fixtureDir: 'fixture data',
      persistTo: '/tmp/本地 state',
      port: 9000,
    });
    expect(() => parseLocalDevOptions(['init', '--remote'])).toThrow('Unknown or invalid local development option');
    expect(() => parseLocalDevOptions(['serve', '--port', '0'])).toThrow('port must be an integer');
  });

  it('uses the top-level Wrangler bindings and prefers their local preview identities', () => {
    expect(localBindingsFromWranglerConfig(wranglerConfig)).toEqual({
      compatibilityDate: '2026-06-25',
      d1Binding: 'DB',
      d1LocalId: 'local-id',
      r2Binding: 'ATTACHMENTS',
      r2LocalId: 'sop-local-attachments',
    });
  });

  it('builds migration and Pages arguments against the same local identity and state root', () => {
    const bindings = localBindingsFromWranglerConfig(wranglerConfig);
    const options = parseLocalDevOptions(['serve', '--persist-to', '/tmp/本地 state', '--port', '9000']);

    expect(localMigrationArgs(bindings, options)).toEqual([
      'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to=/tmp/本地 state',
    ]);
    expect(localPagesArgs(bindings, options)).toEqual([
      'pages', 'dev', 'dist', '--port=9000', '--persist-to=/tmp/本地 state',
      '--d1=DB=local-id', '--r2=ATTACHMENTS=sop-local-attachments',
      '--compatibility-date=2026-06-25',
    ]);
    expect([...localMigrationArgs(bindings, options), ...localPagesArgs(bindings, options)])
      .not.toContain('--remote');
  });

  it('checks for a non-empty APP_PASSWORD without exposing its value', () => {
    expect(hasConfiguredAppPassword('APP_PASSWORD=local-secret\n')).toBe(true);
    expect(hasConfiguredAppPassword('APP_PASSWORD="local secret"\n')).toBe(true);
    expect(hasConfiguredAppPassword('APP_PASSWORD=changeme\n')).toBe(false);
    expect(hasConfiguredAppPassword('APP_PASSWORD=short\n')).toBe(false);
    expect(hasConfiguredAppPassword('# APP_PASSWORD=nope\nAPP_PASSWORD=  \n')).toBe(false);
    expect(hasConfiguredAppPassword('APP_PASSWORD="" # required\n')).toBe(false);
    expect(hasConfiguredAppPassword('R2_PUBLIC_BASE_URL=https://assets.test\n')).toBe(false);
  });

  it('removes Cloudflare operator credentials from local Wrangler children', () => {
    expect(localOnlyEnvironment(true, {
      CLOUDFLARE_API_TOKEN: 'token',
      CF_API_TOKEN: 'token',
      CLOUDFLARE_API_KEY: 'key',
      CF_API_KEY: 'key',
      CLOUDFLARE_EMAIL: 'operator@example.test',
      CF_EMAIL: 'operator@example.test',
      CLOUDFLARE_API_USER_SERVICE_KEY: 'service-key',
      CLOUDFLARE_ACCESS_CLIENT_ID: 'access-id',
      CLOUDFLARE_ACCESS_CLIENT_SECRET: 'access-secret',
      WRANGLER_CF_AUTHORIZATION_TOKEN: 'authorization-token',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CF_ACCOUNT_ID: 'account',
      WRANGLER_R2_SQL_AUTH_TOKEN: 'r2-token',
      cloudflare_api_token: 'mixed-case-token',
      SOP_D1_DATABASE_ID: 'database',
      UNRELATED: 'preserved',
    })).toEqual({ CI: '1', UNRELATED: 'preserved' });
  });
});
