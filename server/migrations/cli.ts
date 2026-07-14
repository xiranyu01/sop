import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeCanonicalSnapshot } from '../domain/appStore';
import { convertLegacyToV1alpha1 } from './legacyToV1alpha1';
import { readLegacyDirectory, migrateLegacyFiles } from './runner';

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const command = process.argv[2];
const legacyDir = path.resolve(option('--legacy-dir', 'data')!);
const canonicalRoot = path.resolve(option('--canonical-root', '.canonical')!);

if (command === 'preflight') {
  const result = convertLegacyToV1alpha1(await readLegacyDirectory(legacyDir));
  try {
    encodeCanonicalSnapshot(result.snapshot);
  } catch (error) {
    result.report.issues.push({
      code: 'INVALID_CANONICAL_DATA',
      owner: '$',
      message: error instanceof Error ? error.message : String(error),
    });
    result.report.ok = false;
  }
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  if (!result.report.ok) process.exitCode = 1;
} else if (command === 'build' || command === 'resume' || command === 'validate') {
  const result = await migrateLegacyFiles({ legacyDir, canonicalRoot, attachmentRoot: option('--attachment-root') });
  process.stdout.write(`${JSON.stringify({ generationId: result.generationId, lifecycle: result.manifest.lifecycle, noOp: result.noOp, report: result.report }, null, 2)}\n`);
} else if (command === 'report') {
  const generation = option('--generation');
  if (!generation) throw new Error('--generation is required for report');
  const report = await readFile(path.join(canonicalRoot, 'migration-generations', generation, 'report.json'), 'utf8');
  process.stdout.write(report);
} else {
  throw new Error('Usage: pnpm migration <preflight|build|resume|validate|report> [--legacy-dir DIR] [--canonical-root DIR] [--attachment-root DIR] [--generation ID]');
}
