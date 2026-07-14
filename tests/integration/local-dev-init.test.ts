import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  initializeLocalRepository,
  localRepositoryStatus,
  parseLocalDevOptions,
  prepareLocalBootstrapData,
  runLocalDevCli,
  withLocalD1,
} from '../../server/bootstrap/localDev';
import { createD1ResourceRepository } from '../../server/repositories/d1ResourceRepository';

const temporaryDirectories: string[] = [];

async function temporaryState(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sop-local-dev-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('local development repository initialization', () => {
  it('reports an uninitialized persistence root as unavailable', async () => {
    const state = await temporaryState();
    const output: string[] = [];

    await expect(runLocalDevCli(
      parseLocalDevOptions(['status', '--persist-to', state]),
      (value) => output.push(value),
    )).rejects.toThrow('Local repository is not ready: repository is unavailable');
    expect(JSON.parse(output[0])).toEqual({
      persistTo: state,
      readiness: { ready: false, reason: 'repository is unavailable' },
    });
  }, 30_000);

  it('migrates, bootstraps, survives reopen, and preserves edits when rerun', async () => {
    const state = await temporaryState();
    const init = parseLocalDevOptions(['init', '--persist-to', state]);
    const status = parseLocalDevOptions(['status', '--persist-to', state]);
    const output: string[] = [];

    await runLocalDevCli(init, (value) => output.push(value));
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      persistTo: state,
      result: { state: 'COMPLETE', idempotent: false, recovered: false },
      readiness: { ready: true },
    });

    await runLocalDevCli(status, (value) => output.push(value));
    expect(JSON.parse(output.at(-1)!)).toEqual({
      persistTo: state,
      readiness: { ready: true },
    });

    const prepared = await prepareLocalBootstrapData('data');
    const target = prepared.currents[0]!;
    await withLocalD1(state, async (database) => {
      const repository = createD1ResourceRepository(database);
      const current = (await repository.getCurrent(target.name))!;
      const proto = JSON.parse(current.protoJson) as Record<string, unknown>;
      proto.displayName = `${String(proto.displayName)}（本地修改）`;
      await repository.updateCurrent(current.name, current.etag, {
        protoSchema: current.protoSchema,
        protoJson: JSON.stringify(proto),
      });
    });

    await runLocalDevCli(init, (value) => output.push(value));
    expect(JSON.parse(output.at(-1)!)).toMatchObject({
      result: { state: 'COMPLETE', idempotent: true, recovered: false },
      readiness: { ready: true },
    });
    await withLocalD1(state, async (database) => {
      const current = await createD1ResourceRepository(database).getCurrent(target.name);
      expect(JSON.parse(current!.protoJson)).toMatchObject({
        displayName: expect.stringContaining('（本地修改）'),
      });
    });
  }, 60_000);

  it('fails clearly when migrations have not created the resource schema', async () => {
    const state = await temporaryState();

    await expect(initializeLocalRepository(state, 'data'))
      .rejects.toThrow('Local D1 schema is unavailable; run the local migration step before bootstrap');
    await expect(localRepositoryStatus(state)).resolves.toEqual({
      ready: false,
      reason: 'repository is unavailable',
    });
  }, 30_000);

  it('does not treat a ready marker as sufficient when a baseline identity is missing', async () => {
    const state = await temporaryState();
    const init = parseLocalDevOptions(['init', '--persist-to', state]);
    await runLocalDevCli(init, () => undefined);
    const prepared = await prepareLocalBootstrapData('data');
    const missing = prepared.catalogs[0]!;

    await withLocalD1(state, async (database) => {
      await database.prepare('DELETE FROM SOP_CATALOG_RESOURCES WHERE name = ?')
        .bind(missing.name)
        .run();
    });

    await expect(runLocalDevCli(init, () => undefined))
      .rejects.toThrow(`Bootstrap baseline identity is missing: ${missing.name}`);
    await withLocalD1(state, async (database) => {
      await expect(createD1ResourceRepository(database).getCatalog(missing.name))
        .resolves.toBeUndefined();
    });
  }, 60_000);
});
