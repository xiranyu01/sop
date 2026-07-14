#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(process.argv[2] ?? process.cwd());
const productionEntries = process.argv[2]
  ? ['.']
  : ['functions', 'migrations', 'server', 'src', 'shared', 'schema.sql'];
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sql']);
const ignoredSegments = new Set(['node_modules', 'dist', 'coverage', 'gen', '.git']);
const forbidden = [
  ['CanonicalSnapshot', /\bCanonicalSnapshot\b/g],
  ['snapshot_json', /\bsnapshot_json\b/g],
  ['canonical_namespaces', /\bcanonical_namespaces\b/g],
  ['canonical-data endpoint', /\/api\/canonical-data\b/g],
  ['app_data authority', /\bapp_data\b/g],
  ['global generation', /\b(?:global|canonical)[_-]?generation\b/gi],
];

async function files(path) {
  let info;
  try { info = await stat(path); } catch { return []; }
  if (info.isFile()) return extensions.has(extname(path)) ? [path] : [];
  if (!info.isDirectory()) return [];
  if (ignoredSegments.has(path.split('/').at(-1))) return [];
  const children = await readdir(path);
  return (await Promise.all(children.map((name) => files(join(path, name))))).flat();
}

const candidates = (await Promise.all(productionEntries.map((entry) => files(resolve(root, entry))))).flat();
const failures = [];
for (const file of candidates.sort()) {
  const source = await readFile(file, 'utf8');
  for (const [label, pattern] of forbidden) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      failures.push(`${relative(root, file)}:${line}: forbidden ${label}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`No global snapshot authority found in ${candidates.length} production files.`);

