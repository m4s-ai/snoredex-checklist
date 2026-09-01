import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('complexity AST regression fixtures pass', async () => {
  const { stdout } = await run(process.execPath, ['scripts/complexity-report.mjs', '--self-test']);
  if (stdout.trim() !== 'complexity self-test passed') throw new Error(stdout);
});
