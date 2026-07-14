#!/usr/bin/env node

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import type { Unstable_Config } from 'wrangler';
import { bootstrapRepository, verifyPreparedDataPresence } from './repository';
import { prepareRepositoryData, type PreparedRepositoryData } from './repositoryData';
import { repositoryReleaseManifest } from './releaseManifest';
import { repositoryReadiness } from './status';
import { assertPreparedDataMatchesRelease, loadRepositoryFixtures } from './cli';
import {
  createD1ResourceRepository,
  type D1DatabaseLike,
} from '../repositories/d1ResourceRepository';

export type LocalDevCommand = 'init' | 'status' | 'serve';

export type LocalDevOptions = {
  command: LocalDevCommand;
  fixtureDir: string;
  persistTo: string;
  port: number;
};

export type WranglerLocalBindings = {
  compatibilityDate: string;
  d1Binding: string;
  d1LocalId: string;
  r2Binding: string;
  r2LocalId: string;
};

type LocalReadiness = Awaited<ReturnType<typeof repositoryReadiness>>;

const defaultPersistTo = '.wrangler/local';
const defaultFixtureDir = 'data';
const defaultPort = 8788;
const isolatedWranglerEnvFile = path.resolve('.dev.vars.example');
const operatorCredentialKeys = [
  'CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN',
  'CLOUDFLARE_API_KEY', 'CF_API_KEY',
  'CLOUDFLARE_EMAIL', 'CF_EMAIL',
  'CLOUDFLARE_API_USER_SERVICE_KEY',
  'CLOUDFLARE_ACCESS_CLIENT_ID', 'CLOUDFLARE_ACCESS_CLIENT_SECRET',
  'WRANGLER_CF_AUTHORIZATION_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID',
  'WRANGLER_R2_SQL_AUTH_TOKEN', 'SOP_D1_DATABASE_ID',
] as const;
const operatorCredentialKeySet = new Set<string>(operatorCredentialKeys);
const require = createRequire(import.meta.url);
const wranglerCliPath = path.join(
  path.dirname(require.resolve('wrangler/package.json')),
  'bin',
  'wrangler.js',
);

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Local development port must be an integer between 1 and 65535');
  }
  return port;
}

export function parseLocalDevOptions(args: string[]): LocalDevOptions {
  let parsed: {
    values: { 'fixture-dir'?: string; 'persist-to'?: string; port?: string };
    positionals: string[];
  };
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        'fixture-dir': { type: 'string', default: defaultFixtureDir },
        'persist-to': { type: 'string', default: defaultPersistTo },
        port: { type: 'string', default: String(defaultPort) },
      },
    });
  } catch (error) {
    throw new TypeError(`Unknown or invalid local development option: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const command = parsed.positionals[0] as LocalDevCommand | undefined;
  if (!command || parsed.positionals.length !== 1 || !['init', 'status', 'serve'].includes(command)) {
    throw new TypeError('Usage: localDev <init|status|serve> [--fixture-dir data] [--persist-to .wrangler/local] [--port 8788]');
  }
  const options = {
    command,
    fixtureDir: parsed.values['fixture-dir'] ?? defaultFixtureDir,
    persistTo: parsed.values['persist-to'] ?? defaultPersistTo,
    port: parsePort(parsed.values.port ?? String(defaultPort)),
  } satisfies LocalDevOptions;
  if (!options.fixtureDir) throw new TypeError('--fixture-dir must not be empty');
  if (!options.persistTo) throw new TypeError('--persist-to must not be empty');
  return options;
}

type LocalWranglerConfig = Pick<Unstable_Config, 'compatibility_date' | 'd1_databases' | 'r2_buckets'>;

export function localBindingsFromWranglerConfig(config: LocalWranglerConfig): WranglerLocalBindings {
  const compatibilityDate = config.compatibility_date;
  const d1 = config.d1_databases.find((binding) => binding.binding === 'DB');
  const r2 = config.r2_buckets.find((binding) => binding.binding === 'ATTACHMENTS');
  const d1Binding = d1?.binding;
  const d1LocalId = d1?.preview_database_id ?? d1?.database_id ?? d1Binding;
  const r2Binding = r2?.binding;
  const r2LocalId = r2?.preview_bucket_name ?? r2?.bucket_name ?? r2Binding;
  if (!compatibilityDate || !d1Binding || !d1LocalId || !r2Binding || !r2LocalId) {
    throw new TypeError('wrangler.toml local DB/R2 bindings are incomplete');
  }
  return { compatibilityDate, d1Binding, d1LocalId, r2Binding, r2LocalId };
}

export async function readWranglerLocalBindings(
  configPath = path.resolve('wrangler.toml'),
  persistTo = defaultPersistTo,
): Promise<WranglerLocalBindings> {
  return withLocalWranglerEnvironment(persistTo, async () => {
    const { unstable_readConfig } = await import('wrangler');
    return localBindingsFromWranglerConfig(unstable_readConfig(
      { config: configPath },
      { hideWarnings: true },
    ));
  });
}

export async function prepareLocalBootstrapData(fixtureDir: string): Promise<PreparedRepositoryData> {
  const data = prepareRepositoryData(await loadRepositoryFixtures(fixtureDir));
  assertPreparedDataMatchesRelease(data);
  return data;
}

async function bootstrapPreparedLocalRepository(
  persistTo: string,
  data: PreparedRepositoryData,
): Promise<Awaited<ReturnType<typeof bootstrapRepository>>> {
  try {
    return await withLocalD1(persistTo, async (database) => {
      const repository = createD1ResourceRepository(database);
      const readiness = await repositoryReadiness(repository, data);
      if (readiness.ready) {
        await verifyPreparedDataPresence(repository, data);
        return { state: 'COMPLETE', idempotent: true, recovered: false };
      }
      return bootstrapRepository(repository, data);
    });
  } catch (error) {
    if (error instanceof Error && /no such (?:table|column)/i.test(error.message)) {
      throw new TypeError('Local D1 schema is unavailable; run the local migration step before bootstrap', { cause: error });
    }
    if (error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)) {
      throw new TypeError('Local D1 is busy; stop pnpm pages:dev before running pnpm dev:init', { cause: error });
    }
    throw error;
  }
}

export async function initializeLocalRepository(
  persistTo: string,
  fixtureDir: string,
): Promise<Awaited<ReturnType<typeof bootstrapRepository>>> {
  return bootstrapPreparedLocalRepository(persistTo, await prepareLocalBootstrapData(fixtureDir));
}

type EnvironmentOverrides = Record<string, string>;

function localWranglerPaths(persistTo: string) {
  const root = path.resolve(persistTo);
  mkdirSync(root, { recursive: true });
  return {
    platformPersistPath: path.join(root, 'v3'),
    registryPath: path.join(root, 'registry'),
    logPath: path.join(root, 'wrangler.log'),
  };
}

function localWranglerEnvironment(persistTo: string): EnvironmentOverrides {
  const paths = localWranglerPaths(persistTo);
  return {
    WRANGLER_REGISTRY_PATH: paths.registryPath,
    WRANGLER_LOG: 'error',
    WRANGLER_LOG_PATH: paths.logPath,
  };
}

async function withEnvironment<T>(
  overrides: EnvironmentOverrides,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withLocalWranglerEnvironment<T>(
  persistTo: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withEnvironment(localWranglerEnvironment(persistTo), operation);
}

export async function withLocalD1<T>(
  persistTo: string,
  operation: (database: D1DatabaseLike) => Promise<T>,
): Promise<T> {
  const paths = localWranglerPaths(persistTo);
  return withLocalWranglerEnvironment(persistTo, async () => {
    const { getPlatformProxy } = await import('wrangler');
    const platform = await getPlatformProxy<{ DB: D1DatabaseLike }>({
      configPath: path.resolve('wrangler.toml'),
      envFiles: [],
      persist: { path: paths.platformPersistPath },
      remoteBindings: false,
    });
    try {
      return await operation(platform.env.DB);
    } finally {
      await platform.dispose();
    }
  });
}

export async function localRepositoryStatus(persistTo: string): Promise<LocalReadiness> {
  return withLocalD1(persistTo, (database) =>
    repositoryReadiness(createD1ResourceRepository(database), repositoryReleaseManifest));
}

export function localMigrationArgs(bindings: WranglerLocalBindings, options: LocalDevOptions): string[] {
  return [
    'd1', 'migrations', 'apply', bindings.d1Binding,
    '--local', `--persist-to=${options.persistTo}`,
  ];
}

export function localPagesArgs(bindings: WranglerLocalBindings, options: LocalDevOptions): string[] {
  return [
    'pages', 'dev', 'dist',
    `--port=${options.port}`,
    `--persist-to=${options.persistTo}`,
    `--d1=${bindings.d1Binding}=${bindings.d1LocalId}`,
    `--r2=${bindings.r2Binding}=${bindings.r2LocalId}`,
    `--compatibility-date=${bindings.compatibilityDate}`,
  ];
}

export function hasConfiguredAppPassword(source: string): boolean {
  try {
    const password = parseEnv(source).APP_PASSWORD?.trim() ?? '';
    return password.length >= 8 && ![
      'changeme', 'change-me', 'password', 'local-password', 'replace-me',
    ].includes(password.toLowerCase()) && !/^<.*>$/.test(password);
  } catch {
    return false;
  }
}

export function localOnlyEnvironment(
  nonInteractive: boolean,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (operatorCredentialKeySet.has(key.toUpperCase())) delete environment[key];
  }
  if (nonInteractive) environment.CI = '1';
  return environment;
}

type LocalWranglerProcessOptions = {
  nonInteractive?: boolean;
  sourceEnvironment?: NodeJS.ProcessEnv;
};

function localWranglerArgs(args: string[]): string[] {
  const persistTo = args.find((argument) => argument.startsWith('--persist-to='))?.slice('--persist-to='.length);
  if (!persistTo) throw new TypeError('Local Wrangler commands require an explicit --persist-to path');
  return [...args, `--env-file=${isolatedWranglerEnvFile}`];
}

function assertLocalWranglerArgs(args: string[]): void {
  if (args.some((argument) => /^--(?:remote|preview)(?:=|$)/.test(argument))) {
    throw new TypeError('Local development commands cannot target remote or preview Cloudflare resources');
  }
  if (args.some((argument) => /^--env-file(?:=|$)/.test(argument))) {
    throw new TypeError('Local development commands use an isolated Wrangler env file');
  }
}

function localWranglerChildEnvironment(
  args: string[],
  options: LocalWranglerProcessOptions,
): NodeJS.ProcessEnv {
  const persistTo = args.find((argument) => argument.startsWith('--persist-to='))?.slice('--persist-to='.length);
  const environment = localOnlyEnvironment(
    Boolean(options.nonInteractive),
    options.sourceEnvironment ?? process.env,
  );
  if (persistTo) {
    const paths = localWranglerPaths(persistTo);
    environment.WRANGLER_REGISTRY_PATH = paths.registryPath;
    environment.WRANGLER_LOG = 'error';
    environment.WRANGLER_LOG_PATH = paths.logPath;
  }
  return environment;
}

function runWranglerSync(args: string[], options: LocalWranglerProcessOptions = {}): void {
  assertLocalWranglerArgs(args);
  const result = spawnSync(process.execPath, [wranglerCliPath, ...localWranglerArgs(args)], {
    cwd: process.cwd(),
    env: localWranglerChildEnvironment(args, options),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.slice(0, 3).join(' ')} exited with status ${result.status ?? result.signal ?? 'unknown'}`);
  }
}

export function spawnLocalWrangler(
  args: string[],
  options: LocalWranglerProcessOptions = {},
): ChildProcess {
  assertLocalWranglerArgs(args);
  return spawn(process.execPath, [wranglerCliPath, ...localWranglerArgs(args)], {
    cwd: process.cwd(),
    env: localWranglerChildEnvironment(args, options),
    stdio: 'inherit',
  });
}

type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

function childExit(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      child.off('exit', onExit);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      child.off('error', onError);
      resolve({ code, signal });
    };
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function signalLocalWrangler(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
}

export async function stopLocalWrangler(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
  timeoutMs = 5_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = childExit(child);
  signalLocalWrangler(child, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    exit.then(() => false),
    new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut && child.exitCode === null && child.signalCode === null) {
    signalLocalWrangler(child, 'SIGKILL');
    await exit;
  }
}

export async function waitForLocalWrangler(
  child: ChildProcess,
  description: string,
  forwardProcessSignals = false,
): Promise<void> {
  let forwardedSignal: NodeJS.Signals | undefined;
  let shutdownError: unknown;
  let shutdown: Promise<void> | undefined;
  const forward = (signal: NodeJS.Signals) => {
    forwardedSignal ??= signal;
    shutdown ??= stopLocalWrangler(child, signal).catch((error: unknown) => {
      shutdownError = error;
    });
  };
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  if (forwardProcessSignals) {
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
  }
  let result: ChildExit;
  try {
    result = await childExit(child);
    if (shutdown) await shutdown;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
  if (shutdownError) throw shutdownError;
  if (result.code === 0 || forwardedSignal || result.signal === 'SIGINT' || result.signal === 'SIGTERM') return;
  throw new Error(`${description} exited with status ${result.code ?? result.signal ?? 'unknown'}`);
}

async function runWranglerServer(args: string[]): Promise<void> {
  const child = spawnLocalWrangler(args);
  await waitForLocalWrangler(child, `wrangler ${args.slice(0, 3).join(' ')}`, true);
}

async function requireDevPassword(projectRoot: string): Promise<void> {
  const filename = path.join(projectRoot, '.dev.vars');
  let source: string;
  try {
    source = await readFile(filename, 'utf8');
  } catch (error) {
    throw new Error('缺少 .dev.vars；请先运行 `cp .dev.vars.example .dev.vars` 并设置 APP_PASSWORD。', { cause: error });
  }
  let variables: ReturnType<typeof parseEnv>;
  try {
    variables = parseEnv(source);
  } catch (error) {
    throw new Error('.dev.vars 格式无效；修正后重新运行 pnpm dev。', { cause: error });
  }
  const operatorCredential = Object.keys(variables)
    .find((key) => operatorCredentialKeySet.has(key.toUpperCase()));
  if (operatorCredential) {
    throw new Error(`.dev.vars 不得包含 Cloudflare operator 凭据 ${operatorCredential}；请将其移出本地 runtime 配置。`);
  }
  if (!hasConfiguredAppPassword(source)) {
    throw new Error('.dev.vars 中的 APP_PASSWORD 至少需要 8 位，且不能使用 changeme 等示例值；配置后重新运行 pnpm dev。');
  }
}

export async function runLocalDevCli(
  options: LocalDevOptions,
  write: (value: string) => void = console.log,
): Promise<void> {
  const projectRoot = process.cwd();
  const bindings = await readWranglerLocalBindings(
    path.join(projectRoot, 'wrangler.toml'),
    options.persistTo,
  );

  if (options.command === 'init') {
    const prepared = await prepareLocalBootstrapData(options.fixtureDir);
    runWranglerSync(localMigrationArgs(bindings, options), { nonInteractive: true });
    const result = await bootstrapPreparedLocalRepository(options.persistTo, prepared);
    // The initializer either observed a ready repository or completed the
    // canonical marker and full projection audit itself.
    const readiness = { ready: true } as const;
    write(JSON.stringify({
      persistTo: options.persistTo,
      result,
      readiness,
    }, null, 2));
    return;
  }

  const readiness = await localRepositoryStatus(options.persistTo);
  if (options.command === 'status') {
    write(JSON.stringify({ persistTo: options.persistTo, readiness }, null, 2));
    if (!readiness.ready) throw new Error(`Local repository is not ready: ${readiness.reason}`);
    return;
  }

  await requireDevPassword(projectRoot);
  if (!readiness.ready) {
    throw new Error(`本地 D1 尚未就绪（${readiness.reason}）；请先运行 pnpm dev:init。`);
  }
  await runWranglerServer(localPagesArgs(bindings, options));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runLocalDevCli(parseLocalDevOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
