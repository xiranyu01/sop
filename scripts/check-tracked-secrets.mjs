#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import process from 'node:process';

const execFileAsync = promisify(execFile);
const root = resolve(process.argv[2] ?? process.cwd());
const scanAll = process.argv.includes('--all-files');
const secretAssignment = /^\s*(APP_PASSWORD|R2_(?:S3_)?(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY))\s*=\s*(?!\s*$|example\b|changeme\b|<)/im;

async function allFiles(path) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  if (!info.isDirectory() || ['.git', 'node_modules', 'dist'].includes(basename(path))) return [];
  return (await Promise.all((await readdir(path)).map((name) => allFiles(join(path, name))))).flat();
}

let files;
if (scanAll) {
  files = await allFiles(root);
} else {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' });
  files = stdout.toString().split('\0').filter(Boolean).map((name) => join(root, name));
}

const failures = [];
for (const file of files) {
  const path = relative(root, file);
  const name = basename(path);
  const isExample = /(?:\.example|\.sample)$/.test(name);
  if ((name.startsWith('.env') || name.startsWith('.dev.vars')) && !isExample) {
    failures.push(`${path}: tracked local secret file is forbidden`);
    continue;
  }
  let source;
  try { source = await readFile(file, 'utf8'); } catch { continue; }
  if (!isExample && secretAssignment.test(source)) failures.push(`${path}: plaintext application/R2 credential assignment is forbidden`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`No tracked application/R2 secrets found in ${files.length} files.`);

