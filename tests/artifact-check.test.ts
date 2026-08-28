import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checker = resolve(root, 'scripts/check-artifact.mjs');
const csp =
  "default-src 'none'; base-uri 'none'; form-action 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; worker-src 'none'; frame-src 'none'; font-src 'none'; media-src 'none'; manifest-src 'none'";

test('rejects a renamed private-state JSON export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-test-'));
  try {
    await mkdir(join(directory, 'collection'), { recursive: true });
    await Promise.all([
      writeFile(
        join(directory, 'index.html'),
        `<meta http-equiv="Content-Security-Policy" content="${csp}"><script src="theme.js"></script>`,
      ),
      writeFile(
        join(directory, 'collection/index.html'),
        `<meta http-equiv="Content-Security-Policy" content="${csp}"><script src="../theme.js"></script>`,
      ),
      writeFile(join(directory, 'theme.js'), ''),
      writeFile(join(directory, 'collection/theme.js'), ''),
      writeFile(join(directory, 'styles.css'), ''),
      writeFile(join(directory, 'llms.txt'), ''),
      writeFile(join(directory, 'LICENSE.md'), ''),
      writeFile(join(directory, 'THIRD_PARTY_NOTICES.md'), ''),
      writeFile(
        join(directory, 'provenance.json'),
        JSON.stringify({
          schema: 'snoredex-site-provenance',
          schemaVersion: '1.0.0',
          appRevision: '0'.repeat(40),
          catalogue: {
            mode: 'synthetic-fixture',
            sourceCommit: 'synthetic-fixture',
            sourceRepository: 'https://github.com/m4s-ai/snoredex-data',
            contractVersion: '1.0.0',
            catalogueFingerprint: `sha256:${'0'.repeat(64)}`,
            lock: null,
          },
        }),
      ),
      writeFile(
        join(directory, 'leak.json'),
        JSON.stringify({
          schema: 'snoredex-collection-state',
          schemaVersion: '1.0.0',
          datasetId: 'private-dataset',
          catalogueFingerprint: `sha256:${'0'.repeat(64)}`,
          items: [],
        }),
      ),
    ]);
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_PRIVATE_STATE_SCHEMA_PRESENT: leak\.json/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
