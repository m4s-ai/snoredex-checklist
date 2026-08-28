import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (mode !== '--check' && mode !== '--write') {
  console.error('format usage: npm run format[:check]');
  process.exit(2);
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : undefined;
}

const candidates = [];
if (process.env.GITHUB_BASE_REF) candidates.push(`origin/${process.env.GITHUB_BASE_REF}`);
candidates.push('origin/main');
let mergeBase;
for (const candidate of candidates) {
  mergeBase = git(['merge-base', 'HEAD', candidate])?.trim();
  if (mergeBase) break;
}
if (!mergeBase) mergeBase = git(['rev-parse', 'HEAD^'])?.trim();
if (!mergeBase) throw new Error('FORMAT_BASE_UNAVAILABLE: fetch the default branch before checking format');

const committedDiff = git(['diff', '--name-only', '-z', '--diff-filter=ACMR', mergeBase, 'HEAD']);
const workingDiff = git(['diff', '--name-only', '-z', '--diff-filter=ACMR']);
const stagedDiff = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']);
if (committedDiff === undefined || workingDiff === undefined || stagedDiff === undefined || untracked === undefined)
  throw new Error('FORMAT_DIFF_FAILED');
const allowed = new Set(['.css', '.html', '.js', '.json', '.mjs', '.md', '.ts', '.yaml', '.yml']);
const files = [
  ...new Set([committedDiff, workingDiff, stagedDiff, untracked].flatMap((diff) => diff.split('\0').filter(Boolean))),
]
  .filter((file) => !file.startsWith('dist/') && !file.startsWith('node_modules/') && !file.startsWith('vendor/'))
  .filter((file) => allowed.has(extname(file).toLowerCase()))
  .filter((file) => existsSync(resolve(root, file)));

if (files.length === 0) {
  console.log(`${mode === '--check' ? 'format:check' : 'format'}: no changed authored files`);
  process.exit(0);
}

const prettierBin = resolve(root, 'node_modules/prettier/bin/prettier.cjs');
const result = spawnSync(process.execPath, [prettierBin, mode, ...files], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`${mode === '--check' ? 'format:check' : 'format'}: ${files.length} changed authored file(s)`);
