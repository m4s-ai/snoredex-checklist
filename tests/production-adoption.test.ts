import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('production adoption validates the reviewed target migration without requiring the fixture as a source', async () => {
  const scriptPath = resolve(root, 'scripts/check-production-adoption.mjs');
  const script = await readFile(scriptPath, 'utf8');
  assert.doesNotMatch(script, /collector-catalogue\.fixture/u);
  assert.match(script, /candidate\.toFingerprint === targetFingerprint/u);

  const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
