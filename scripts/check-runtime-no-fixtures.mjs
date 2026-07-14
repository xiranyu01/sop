#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const root = resolve(process.argv[2] ?? process.cwd());
const fixtureRoot = resolve(root, 'data');
const runtimeEntries = ['functions', 'src', 'server/http', 'server/api.ts', 'server/index.ts'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const ignoredSegments = new Set(['node_modules', 'dist', 'coverage', 'gen', '.git']);
const operatorOnlyModules = [
  /(?:^|\/)bootstrap\/(?:cli|repositoryData)$/u,
  /(?:^|\/)migrations\/(?:legacyToV1alpha1|runner)$/u,
];

async function files(target) {
  let info;
  try { info = await stat(target); } catch { return []; }
  if (info.isFile()) return sourceExtensions.has(extname(target)) ? [target] : [];
  if (!info.isDirectory() || ignoredSegments.has(target.split('/').at(-1))) return [];
  return (await Promise.all((await readdir(target)).map((name) => files(join(target, name))))).flat();
}

const candidates = (await Promise.all(runtimeEntries.map((entry) => files(resolve(root, entry))))).flat().sort();
const failures = [];
for (const file of candidates) {
  const source = await readFile(file, 'utf8');
  const imports = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(imports)) {
    const specifier = match[1].replace(/\.(?:m?[jt]s|json)$/u, '');
    const resolvedSpecifier = specifier.startsWith('.') ? resolve(dirname(file), specifier) : undefined;
    const fixtureImport = resolvedSpecifier === fixtureRoot || resolvedSpecifier?.startsWith(`${fixtureRoot}${sep}`) === true;
    const operatorImport = operatorOnlyModules.some((pattern) => pattern.test(specifier));
    if (!fixtureImport && !operatorImport) continue;
    const line = source.slice(0, match.index).split('\n').length;
    failures.push(`${relative(root, file)}:${line}: runtime imports operator-only fixture/bootstrap module ${match[1]}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Runtime fixture boundary passed in ${candidates.length} source files.`);
