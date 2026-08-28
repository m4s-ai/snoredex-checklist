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
      join(directory, 'renamed-export.txt'),
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
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_PRIVATE_STATE_SCHEMA_PRESENT: renamed-export\.txt/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects external scripts in single-quoted and unquoted src attributes', async () => {
  for (const source of [
    "'https://evil.invalid/a.js'",
    'https://evil.invalid/a.js',
    '../../outside.js',
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
    `<head><noscript /><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<head><p></p><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<head><meta data-x=\"><meta http-equiv="Content-Security-Policy" content="${csp}">\"></head>`,
    `<head><!-- <!--> <head><meta http-equiv="Content-Security-Policy" content="${csp}"></head> --></head>`,
    `</br><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<body><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head></body>`,
    `<p>x</p><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `text<head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<template><template></template><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head></template>`,
    `<template><xmp></template><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head></xmp>`,
    `<template><script src="x"></template></script><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head></template>`,
    `<template><script src="theme.js"><!--<script src="theme.js"></script></template><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head></script></template>`,
    `<template><script src="theme.js"><!--<script>--></script></template><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head></script></template>`,
    `<template><script src="theme.js"></ script></template><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><script src="theme.js"></script>`,
    `<script src="theme.js"></script><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<meta charset="utf-8">text<meta http-equiv="Content-Security-Policy" content="${csp}"><body>`,
    `<head>text<meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<head></body><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<script src="theme.js"><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head></script>`,
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

test('rejects meta-refresh navigations regardless of CSP ordering', async () => {
  for (const indexMeta of [
    `<head><meta http-equiv="refresh" content="0; url=https://evil.invalid/"><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="refresh" content="0; url=https://evil.invalid/"></head>`,
    `<head><meta http-equiv="re&#102resh" content="0; url=https://evil.invalid/"><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<head><!-- <!-- --> <meta http-equiv="refresh" content="0; url=https://evil.invalid/"><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<head><!-- --!><meta http-equiv="refresh" content="0; url=https://evil.invalid/"><!-- --><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<head><!--><meta http-equiv="refresh" content="0; url=https://evil.invalid/"><!-- --><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<head><!---><meta http-equiv="refresh" content="0; url=https://evil.invalid/"><!-- --><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`,
    `<head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script src="theme.js"><!--</script><meta http-equiv="refresh" content="0;url=https://evil.invalid"><!-- --></body>`,
    `<head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script src="theme.js"><!--<script></script data-x="</script>"><meta http-equiv="refresh" content="0;url=https://evil.invalid"><!-- --></body>`,
    `<head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script src="theme.js"></script data-x=\"> <!--\"><meta http-equiv="refresh" content="0;url=https://evil.invalid"><!-- --></body>`,
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-meta-refresh-test-'));
    try {
      await writeValidArtifact(directory, { indexMeta, indexScript: '' });
      const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_META_REFRESH_PRESENT: index\.html/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('finds meta refresh after quotes in malformed tag names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-malformed-quote-test-'));
  try {
    const indexMeta = `<head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><x"><meta http-equiv="refresh" content="0;url=https://evil.invalid">`;
    await writeValidArtifact(directory, { indexMeta, indexScript: '' });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_META_REFRESH_PRESENT: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('finds meta refresh after equals in malformed tag names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-malformed-equals-test-'));
  try {
    const indexMeta = `<head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><x="><meta http-equiv="refresh" content="0;url=https://evil.invalid">`;
    await writeValidArtifact(directory, { indexMeta, indexScript: '' });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_META_REFRESH_PRESENT: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects CSP-looking attributes on malformed tag names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-malformed-tag-test-'));
  try {
    const indexMeta = `<head><meta? http-equiv="Content-Security-Policy" content="${csp}"></head>`;
    await writeValidArtifact(directory, { indexMeta, indexScript: '' });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_CSP_MISSING: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps stylesheet links and CSS imports inside the artifact', async () => {
  const cases = [
    {
      indexMeta: `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="../../outside.css"></head>`,
      css: '',
      error: /ARTIFACT_EXTERNAL_STYLESHEET_PRESENT: index\.html/u,
    },
    {
      indexMeta: `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="/styles.css"></head>`,
      css: '',
      error: /ARTIFACT_EXTERNAL_STYLESHEET_PRESENT: index\.html/u,
    },
    {
      indexMeta: `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="styles.css"></head>`,
      css: '@import url("../../outside.css");',
      error: /ARTIFACT_EXTERNAL_CSS_IMPORT_PRESENT: styles\.css/u,
    },
    {
      indexMeta: `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="styles.css"></head>`,
      css: '@import "/styles.css";',
      error: /ARTIFACT_EXTERNAL_CSS_IMPORT_PRESENT: styles\.css/u,
    },
    {
      indexMeta: `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="styles.css"></head>`,
      css: '@\\69mport "../../outside.css";',
      error: /ARTIFACT_EXTERNAL_CSS_IMPORT_PRESENT: styles\.css/u,
    },
    {
      indexMeta: `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="styles.css"></head>`,
      css: '@import/**/"../../outside.css";',
      error: /ARTIFACT_EXTERNAL_CSS_IMPORT_PRESENT: styles\.css/u,
    },
    {
      indexMeta: `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><link data-x=">" rel="stylesheet" href="../../outside.css"></head>`,
      css: '',
      error: /ARTIFACT_EXTERNAL_STYLESHEET_PRESENT: index\.html/u,
    },
  ];
  for (const { indexMeta, css, error } of cases) {
    const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-stylesheet-test-'));
    try {
      await writeValidArtifact(directory, { indexMeta, indexScript: '' });
      await writeFile(join(directory, 'styles.css'), css);
      const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, error);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('rejects external JavaScript module dependencies', async () => {
  for (const source of [
    "import('/outside.js');\n",
    'import/**/("/outside.js");\n',
    'import/**/"/outside.js";\n',
    'const expression = `${import/**/("/outside.js")}`;\n',
    'import(`/outside.js`);\n',
    'const expression = `${/}/.test("}") ? import/**/("/outside.js") : ""}`;\n',
    'const expression = `${(() => { return /}/.test("}"); })() || import/**/("/outside.js")}`;\n',
    'const expression = `${(()=>{return /}/.test("x")})() || import/**/("/outside.js")}`;\n',
    'const expression = `${(()=>{if(true) /}/.test("x")})() || import/**/("/outside.js")}`;\n',
    'const expression = `${(()=>{if(("(") ) /}/.test("x")})() || import/**/("/outside.js")}`;\n',
    'const expression = `${(()=>{if((`(`) ) /}/.test("x")})() || import/**/("/outside.js")}`;\n',
    `export {${' '.repeat(201)}} from "/outside.js";\n`,
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-module-test-'));
    try {
      await writeValidArtifact(directory);
      await writeFile(join(directory, 'theme.js'), source);
      const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_MODULE_PRESENT: theme\.js/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('rejects absolute stylesheet URLs before path normalization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-absolute-stylesheet-test-'));
  try {
    await writeValidArtifact(directory, {
      indexMeta: `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="https://m4s-ai.github.io/outside.css"></head>`,
    });
    if (process.platform !== 'win32') {
      await mkdir(join(directory, 'https:'), { recursive: true });
      await mkdir(join(directory, 'https:', 'm4s-ai.github.io'), { recursive: true });
      await writeFile(join(directory, 'https:', 'm4s-ai.github.io', 'outside.css'), '');
    }
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_STYLESHEET_PRESENT: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects named HTML references in stylesheet URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-named-reference-test-'));
  try {
    await writeValidArtifact(directory, {
      indexMeta: `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="&sol;/outside.css"></head>`,
    });
    await mkdir(join(directory, '&sol;'), { recursive: true });
    await writeFile(join(directory, '&sol;', 'outside.css'), '');
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_STYLESHEET_PRESENT: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parses CSP attributes at actual tag boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-csp-attributes-test-'));
  try {
    await writeValidArtifact(directory, {
      indexMeta: `<head><meta data-x=' http-equiv=Content-Security-Policy content="${csp}"'></head>`,
    });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_CSP_MISSING: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
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
