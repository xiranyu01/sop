#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppData } from '../../shared/transport/restDto';
import { bootstrapRepository } from './repository';
import { prepareRepositoryData, type PreparedRepositoryData } from './repositoryData';
import { repositoryReleaseManifest } from './releaseManifest';
import { markerMatches, repositoryReadiness, type RepositoryBootstrapMarker } from './status';
import {
  createD1ResourceRepository,
  type D1AllResultLike,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type D1RunResultLike,
} from '../repositories/d1ResourceRepository';
import { decodeLegacyAppData } from '../migrations/legacyToV1alpha1';

const fixtureFiles = {
  metadata: 'metadata.json',
  customers: 'customers.json',
  materials: 'materials.json',
  robotModels: 'robot-models.json',
  scenes: 'scenes.json',
  requirements: 'requirements.json',
  globalFields: 'global-fields.json',
  materialStateRules: 'material-state-rules.json',
} as const;

type BootstrapCommand = 'bootstrap' | 'status' | 'manifest';

export type BootstrapCliOptions = {
  command: BootstrapCommand;
  fixtureDir: string;
  accountId?: string;
  databaseId?: string;
  apiToken?: string;
  dryRun: boolean;
};

type D1QueryResult = D1RunResultLike & {
  results?: Record<string, unknown>[];
};

type CloudflareResponse = {
  success?: boolean;
  result?: D1QueryResult | D1QueryResult[];
  errors?: Array<{ code?: number; message?: string }>;
};

function requiredOption(value: string | undefined, description: string): string {
  if (!value) throw new TypeError(`${description} is required`);
  return value;
}

function valueAfter(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new TypeError(`Missing value after ${args[index]}`);
  return value;
}

export function parseBootstrapCliOptions(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): BootstrapCliOptions {
  const command = args[0] as BootstrapCommand | undefined;
  if (!command || !['bootstrap', 'status', 'manifest'].includes(command)) {
    throw new TypeError('Usage: bootstrap <bootstrap|status|manifest> [--fixture-dir data] [--database-id ID] [--dry-run]');
  }
  const options: BootstrapCliOptions = {
    command,
    fixtureDir: 'data',
    accountId: environment.CLOUDFLARE_ACCOUNT_ID ?? environment.CF_ACCOUNT_ID,
    databaseId: environment.SOP_D1_DATABASE_ID,
    apiToken: environment.CLOUDFLARE_API_TOKEN ?? environment.CF_API_TOKEN,
    dryRun: false,
  };
  for (let index = 1; index < args.length; index += 1) {
    switch (args[index]) {
      case '--fixture-dir':
        options.fixtureDir = valueAfter(args, index);
        index += 1;
        break;
      case '--database-id':
        options.databaseId = valueAfter(args, index);
        index += 1;
        break;
      case '--account-id':
        options.accountId = valueAfter(args, index);
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        throw new TypeError(`Unknown bootstrap option: ${args[index]}`);
    }
  }
  if (command === 'status' || (command === 'bootstrap' && !options.dryRun)) {
    requiredOption(options.accountId, 'CLOUDFLARE_ACCOUNT_ID/CF_ACCOUNT_ID');
    requiredOption(options.databaseId, '--database-id/SOP_D1_DATABASE_ID');
    requiredOption(options.apiToken, 'CLOUDFLARE_API_TOKEN/CF_API_TOKEN');
  }
  return options;
}

export async function loadRepositoryFixtures(fixtureDir: string): Promise<AppData> {
  const entries = await Promise.all(Object.entries(fixtureFiles).map(async ([key, filename]) => {
    const contents = await readFile(path.join(path.resolve(fixtureDir), filename), 'utf8');
    return [key, JSON.parse(contents)] as const;
  }));
  return decodeLegacyAppData(Object.fromEntries(entries));
}

export function assertPreparedDataMatchesRelease(data: PreparedRepositoryData): void {
  const marker: RepositoryBootstrapMarker = {
    state: 'COMPLETE',
    schemaVersion: data.schemaVersion,
    bootstrapVersion: data.bootstrapVersion,
    datasetDigest: data.datasetDigest,
    expectedCounts: data.expectedCounts,
  };
  if (!markerMatches(marker, repositoryReleaseManifest)) {
    throw new TypeError(
      'Prepared fixture manifest differs from this release; review `manifest` output and update releaseManifest.ts before bootstrap',
    );
  }
}

class CloudflareD1Statement implements D1PreparedStatementLike {
  constructor(
    private readonly database: CloudflareD1Database,
    readonly sql: string,
    readonly parameters: unknown[] = [],
  ) {}

  bind(...values: unknown[]): CloudflareD1Statement {
    return new CloudflareD1Statement(this.database, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const result = await this.database.execute(this.sql, this.parameters);
    return (result.results?.[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1AllResultLike<T>> {
    const result = await this.database.execute(this.sql, this.parameters);
    return { success: result.success, results: (result.results ?? []) as T[] };
  }

  async run(): Promise<D1RunResultLike> {
    return this.database.execute(this.sql, this.parameters);
  }
}

export class CloudflareD1Database implements D1DatabaseLike {
  constructor(
    private readonly accountId: string,
    private readonly databaseId: string,
    private readonly apiToken: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  prepare(sql: string): CloudflareD1Statement {
    return new CloudflareD1Statement(this, sql);
  }

  async batch<T extends D1RunResultLike = D1RunResultLike>(statements: D1PreparedStatementLike[]): Promise<T[]> {
    if (statements.length !== 1) {
      throw new TypeError('The bootstrap REST adapter cannot execute lifecycle transaction batches');
    }
    const statement = statements[0];
    if (!(statement instanceof CloudflareD1Statement)) throw new TypeError('Unexpected D1 statement implementation');
    return [await this.execute(statement.sql, statement.parameters) as T];
  }

  async execute(sql: string, parameters: unknown[]): Promise<D1QueryResult> {
    const response = await this.request(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/d1/database/${encodeURIComponent(this.databaseId)}/query`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sql, params: parameters }),
      },
    );
    const payload = await response.json() as CloudflareResponse;
    const result = Array.isArray(payload.result) ? payload.result[0] : payload.result;
    if (!response.ok || payload.success !== true || !result?.success) {
      const detail = payload.errors?.map((error) => `${error.code ?? 'unknown'}:${error.message ?? 'D1 query failed'}`).join(', ');
      throw new Error(`Cloudflare D1 query failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    return result;
  }
}

function databaseFromOptions(options: BootstrapCliOptions): CloudflareD1Database {
  return new CloudflareD1Database(
    requiredOption(options.accountId, 'Cloudflare account id'),
    requiredOption(options.databaseId, 'D1 database id'),
    requiredOption(options.apiToken, 'Cloudflare API token'),
  );
}

function printableManifest(data: PreparedRepositoryData): string {
  return JSON.stringify({
    schemaVersion: data.schemaVersion,
    bootstrapVersion: data.bootstrapVersion,
    datasetDigest: data.datasetDigest,
    expectedCounts: data.expectedCounts,
  }, null, 2);
}

export async function runBootstrapCli(
  options: BootstrapCliOptions,
  write: (value: string) => void = console.log,
): Promise<void> {
  if (options.command === 'manifest') {
    const data = prepareRepositoryData(await loadRepositoryFixtures(options.fixtureDir));
    write(printableManifest(data));
    return;
  }
  if (options.command === 'status') {
    const repository = createD1ResourceRepository(databaseFromOptions(options));
    const readiness = await repositoryReadiness(repository, repositoryReleaseManifest);
    write(JSON.stringify({ releaseManifest: repositoryReleaseManifest, readiness }, null, 2));
    if (!readiness.ready) throw new Error(`Repository is not ready: ${readiness.reason}`);
    return;
  }

  const data = prepareRepositoryData(await loadRepositoryFixtures(options.fixtureDir));
  assertPreparedDataMatchesRelease(data);
  if (options.dryRun) {
    write(JSON.stringify({ validated: true, releaseManifest: repositoryReleaseManifest }, null, 2));
    return;
  }
  const repository = createD1ResourceRepository(databaseFromOptions(options), {
    onRowSizeWarning: (warning) => write(JSON.stringify({ event: 'bootstrap_row_size_warning', ...warning })),
  });
  const result = await bootstrapRepository(repository, data);
  write(JSON.stringify({ releaseManifest: repositoryReleaseManifest, result }, null, 2));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runBootstrapCli(parseBootstrapCliOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
