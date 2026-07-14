import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const generatedRoot = path.join(root, 'gen');

async function snapshot(directory, prefix = '') {
  const result = new Map();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of await snapshot(absolute, relative)) result.set(name, content);
    } else if (entry.isFile()) {
      result.set(relative, await readFile(absolute, 'utf8'));
    }
  }
  return result;
}

function differences(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].sort().filter((name) => before.get(name) !== after.get(name));
}

const before = await snapshot(generatedRoot);
const generated = spawnSync('buf', ['generate', '--clean'], { cwd: root, stdio: 'inherit' });
if (generated.status !== 0) process.exit(generated.status ?? 1);
const after = await snapshot(generatedRoot);
const changed = differences(before, after);

if (changed.length > 0) {
  console.error(`Generated Proto output was stale: ${changed.join(', ')}`);
  process.exit(1);
}
