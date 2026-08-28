import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildScript = resolve(root, 'scripts/build-site.mjs');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'snoredex-build-'));
const first = join(temporaryRoot, 'first');
const second = join(temporaryRoot, 'second');

async function runBuild(output) {
  const result = spawnSync(process.execPath, [buildScript, '--out-dir', output], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`BUILD_REPRODUCIBLE_BUILD_FAILED: ${result.status ?? 'unknown'}`);
}

async function filesIn(directory) {
  const output = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`BUILD_REPRODUCIBLE_SYMLINK: ${relative(directory, path)}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(relative(directory, path));
      else throw new Error(`BUILD_REPRODUCIBLE_UNSUPPORTED_ENTRY: ${relative(directory, path)}`);
    }
  }
  await visit(directory);
  return output;
}

try {
  await runBuild(first);
  await runBuild(second);
  const firstFiles = await filesIn(first);
  const secondFiles = await filesIn(second);
  if (JSON.stringify(firstFiles) !== JSON.stringify(secondFiles))
    throw new Error('BUILD_REPRODUCIBLE_FILE_SET_MISMATCH');
  for (const file of firstFiles) {
    const [firstBytes, secondBytes] = await Promise.all([readFile(join(first, file)), readFile(join(second, file))]);
    if (!firstBytes.equals(secondBytes)) throw new Error(`BUILD_REPRODUCIBLE_CONTENT_MISMATCH: ${file}`);
  }
  console.log(`reproducible build ok: ${firstFiles.length} files`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
