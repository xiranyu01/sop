import { spawnSync } from 'node:child_process';

const target = process.env.BUF_BREAKING_AGAINST ?? 'origin/main';
const tree = spawnSync('git', ['ls-tree', '-r', '--name-only', target, '--', 'proto'], { encoding: 'utf8' });
if (tree.status !== 0) {
  process.stderr.write(tree.stderr || `Unable to inspect ${target}\n`);
  process.exit(tree.status ?? 1);
}

const hasBaseline = tree.stdout.split('\n').some((file) => file.endsWith('.proto'));
if (!hasBaseline) {
  process.stdout.write(`No Proto baseline exists on ${target}; compatibility comparison starts after this baseline merges.\n`);
  process.exit(0);
}

const result = spawnSync(
  'pnpm',
  ['exec', 'buf', 'breaking', '--against', `.git#branch=${target},subdir=proto`],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
