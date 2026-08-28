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

async function writeValidArtifact(
  directory: string,
  {
    indexMeta = `<head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    collectionMeta = `<head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    indexScript = '<script src="theme.js"></script>',
    collectionScript = '<script src="../theme.js"></script>',
  } = {},
) {
  await mkdir(join(directory, 'collection'), { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'index.html'), `${indexMeta}${indexScript}`),
    writeFile(join(directory, 'collection/index.html'), `${collectionMeta}${collectionScript}`),
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
  ]);
}

test('rejects a renamed private-state JSON export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(
      join(directory, 'leak.json'),
      JSON.stringify({
        schema: 'snoredex-collection-state',
        schemaVersion: '1.0.0',
        datasetId: 'private-dataset',
        catalogueFingerprint: `sha256:${'0'.repeat(64)}`,
        items: [],
      }),
    );
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_PRIVATE_STATE_SCHEMA_PRESENT: leak\.json/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects external scripts in single-quoted and unquoted src attributes', async () => {
  for (const source of [
    "'https://evil.invalid/a.js'",
    'https://evil.invalid/a.js',
    '"https&#58;//evil.invalid/a.js"',
    '"&#9;https://evil.invalid/a.js"',
    '"ht&#10;tps://evil.invalid/a.js"',
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-script-test-'));
    try {
      await writeValidArtifact(directory, { indexScript: `<script src=${source}></script>` });
      const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_SCRIPT_PRESENT: index\.html/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('rejects a CSP meta declaration hidden inside an HTML comment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-csp-test-'));
  try {
    await writeValidArtifact(directory, {
      indexMeta: `<head><!-- <meta http-equiv="Content-Security-Policy" content="${csp}"> --></head>`,
    });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_CSP_MISSING: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('requires the CSP meta element to be inside the document head', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-csp-location-test-'));
  try {
    await writeValidArtifact(directory, {
      indexMeta: `<head></head><body><meta http-equiv="Content-Security-Policy" content="${csp}"></body>`,
    });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_CSP_MISSING: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('requires an active first-applicable CSP before controlled resources', async () => {
  for (const indexMeta of [
    `<head><template><meta http-equiv="Content-Security-Policy" content="${csp}"></template></head>`,
    `<head><noscript><meta http-equiv="Content-Security-Policy" content="${csp}"></noscript></head>`,
    `<head><script src="theme.js"></script><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-csp-order-test-'));
    try {
      await writeValidArtifact(directory, { indexMeta, indexScript: '' });
      const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_CSP_MISSING: index\.html/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('rejects slash-separated inline event-handler attributes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-handler-test-'));
  try {
    await writeValidArtifact(directory, { indexScript: '<img/onerror=alert(1)>' });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_INLINE_HANDLER_PRESENT: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
