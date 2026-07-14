import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MigrationManifest } from './manifest';
import type { MigrationReport } from './report';
import { migrateLegacyFiles } from './runner';
import { reconcileValidatedRuntimeGeneration } from './runtimeGeneration';

export type FileRuntimeBootstrapOptions = {
  canonicalRoot: string;
  legacyDir: string;
  attachmentRoot?: string;
};

async function readRuntimeNamespace(file: string): Promise<string | undefined> {
  try {
    const namespace = (await readFile(file, 'utf8')).trim();
    if (!namespace) throw new Error('Canonical runtime namespace marker is empty');
    return namespace;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function loadValidatedGeneration(canonicalRoot: string, generationId: string) {
  const root = path.join(canonicalRoot, 'migration-generations', generationId);
  let manifest: MigrationManifest;
  let report: MigrationReport;
  let encodedSnapshot: string;
  try {
    [manifest, report, encodedSnapshot] = await Promise.all([
      readFile(path.join(root, 'manifest.json'), 'utf8').then((value) => JSON.parse(value) as MigrationManifest),
      readFile(path.join(root, 'report.json'), 'utf8').then((value) => JSON.parse(value) as MigrationReport),
      readFile(path.join(root, 'snapshot.json'), 'utf8'),
    ]);
  } catch (error) {
    throw new Error(`Canonical runtime generation is incomplete or malformed: ${generationId}`, { cause: error });
  }
  if (manifest.lifecycle !== 'VALIDATED') {
    throw new Error(`Canonical runtime generation is not VALIDATED: ${generationId}`);
  }
  return reconcileValidatedRuntimeGeneration({
    generationId,
    lifecycle: manifest.lifecycle,
    sourceFingerprint: manifest.sourceFingerprint,
    storedVersions: {
      converterVersion: manifest.converterVersion,
      storageSchemaVersion: manifest.storageSchemaVersion,
      canonicalSchemaVersion: manifest.canonicalSchemaVersion,
      identityVersion: manifest.identityVersion,
    },
    manifest,
    report,
    encodedSnapshot,
  });
}

export async function bootstrapValidatedFileGeneration(options: FileRuntimeBootstrapOptions) {
  const canonicalRoot = path.resolve(options.canonicalRoot);
  const marker = path.join(canonicalRoot, 'runtime-namespace');
  const anchored = await readRuntimeNamespace(marker);
  if (anchored) return loadValidatedGeneration(canonicalRoot, anchored);

  const migration = await migrateLegacyFiles({
    legacyDir: options.legacyDir,
    canonicalRoot,
    attachmentRoot: options.attachmentRoot,
  });
  await loadValidatedGeneration(canonicalRoot, migration.generationId);
  await mkdir(canonicalRoot, { recursive: true });
  try {
    await writeFile(marker, `${migration.generationId}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const selected = await readRuntimeNamespace(marker);
  if (!selected) throw new Error('Canonical runtime namespace marker was not published');
  return loadValidatedGeneration(canonicalRoot, selected);
}
