import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cwd = resolve(import.meta.dirname, '../..');

async function run(script: string, args: string[]) {
  try {
    const result = await execFileAsync(process.execPath, [resolve(cwd, script), ...args], { cwd });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { status: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe('architecture regression guards', () => {
  it('rejects known global authority terms', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'sop-snapshot-'));
    await writeFile(join(fixture, 'authority.ts'), 'export const row = { snapshot_json: "{}" };\n');
    const result = await run('scripts/check-no-global-snapshot.mjs', [fixture]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('snapshot_json');
  });

  it('rejects a whole-site snapshot in the authoritative Proto tree', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'sop-proto-snapshot-'));
    await mkdir(join(fixture, 'proto'), { recursive: true });
    await writeFile(join(fixture, 'proto', 'snapshot.proto'), [
      'syntax = "proto3";',
      'package coscene.sop.v1alpha1;',
      'message CanonicalSnapshot {}',
      '',
    ].join('\n'));

    const result = await run('scripts/check-no-global-snapshot.mjs', [fixture]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CanonicalSnapshot');
    expect(result.stderr).toContain('proto/snapshot.proto');
  });

  it('keeps repository fixtures and bootstrap conversion out of runtime imports', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'sop-runtime-fixture-'));
    await mkdir(join(fixture, 'functions'), { recursive: true });
    await writeFile(join(fixture, 'functions', 'api.ts'), "import data from '../data/customers.json';\nexport default data;\n");
    const fixtureResult = await run('scripts/check-runtime-no-fixtures.mjs', [fixture]);
    expect(fixtureResult.status).toBe(1);
    expect(fixtureResult.stderr).toContain('operator-only fixture/bootstrap module');

    await writeFile(join(fixture, 'functions', 'api.ts'), "import { prepareRepositoryData } from '../server/bootstrap/repositoryData';\nexport default prepareRepositoryData;\n");
    const bootstrapResult = await run('scripts/check-runtime-no-fixtures.mjs', [fixture]);
    expect(bootstrapResult.status).toBe(1);
    expect(bootstrapResult.stderr).toContain('repositoryData');
  });

  it('rejects an aliased whole-site mutation even without forbidden snapshot words', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'sop-contract-'));
    const manifest = {
      version: 1,
      routes: [{ method: 'PUT', path: '/api/universe', scope: 'resource', operation: 'universe.replace' }],
      repositoryMutations: [{ operation: 'universe.replace', scope: 'resource' }],
    };
    const path = join(fixture, 'manifest.json');
    await writeFile(path, JSON.stringify(manifest));
    const result = await run('scripts/check-mutation-contract.mjs', [path]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must name one resource');
  });

  it('accepts the production mutation manifest', async () => {
    const result = await run('scripts/check-mutation-contract.mjs', [resolve(cwd, 'server/http/mutation-contract.json')]);
    expect(result).toMatchObject({ status: 0 });
  });

  it('rejects a production handler mutation that is absent from the manifest', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'sop-handler-mutation-'));
    const handlerPath = join(fixture, 'resourceApi.ts');
    const handler = await readFile(resolve(cwd, 'server/http/resourceApi.ts'), 'utf8');
    await writeFile(
      handlerPath,
      `${handler}\nif (pathname === '/api/resources/:kind/:name/purge' && method === 'DELETE') return new Response(null);\n`,
    );

    const result = await run('scripts/check-mutation-contract.mjs', [
      resolve(cwd, 'server/http/mutation-contract.json'),
      handlerPath,
      resolve(cwd, 'server/domain/repository.ts'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source mutation missing from manifest: DELETE /api/resources/:kind/:name/purge');
  });

  it('rejects an unclassified method added to the production repository contract', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'sop-repository-mutation-'));
    const repositoryPath = join(fixture, 'repository.ts');
    const repository = await readFile(resolve(cwd, 'server/domain/repository.ts'), 'utf8');
    await writeFile(
      repositoryPath,
      repository.replace(
        '  auditProjectionParity(): Promise<void>;\n}',
        '  auditProjectionParity(): Promise<void>;\n  purgeAll(): Promise<void>;\n}',
      ),
    );

    const result = await run('scripts/check-mutation-contract.mjs', [
      resolve(cwd, 'server/http/mutation-contract.json'),
      resolve(cwd, 'server/http/resourceApi.ts'),
      repositoryPath,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unclassified repository method: purgeAll');
  });

  it('rejects secret files and credential assignments while allowing examples', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'sop-secrets-'));
    await mkdir(join(fixture, 'config'));
    await writeFile(join(fixture, '.dev.vars'), 'APP_PASSWORD=real-secret\n');
    await writeFile(join(fixture, 'config', '.dev.vars.example'), 'APP_PASSWORD=<set-locally>\n');
    const result = await run('scripts/check-tracked-secrets.mjs', [fixture, '--all-files']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tracked local secret file');
    expect(result.stderr).not.toContain('.dev.vars.example:');
  });
});
