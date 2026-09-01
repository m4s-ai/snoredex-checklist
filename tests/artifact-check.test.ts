import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { validatePagesDeployment } from '../src/site/deployment.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checker = resolve(root, 'scripts/check-artifact.mjs');
const csp =
  "default-src 'none'; base-uri 'none'; form-action 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; worker-src 'none'; frame-src 'none'; font-src 'none'; media-src 'none'; manifest-src 'none'";

test('requires Pages smoke provenance to match the expected workflow tuple', () => {
  const expected = {
    appRevision: 'a'.repeat(40),
    producerRevision: 'b'.repeat(40),
    contractVersion: '1.0.0',
    catalogueFingerprint: `sha256:${'c'.repeat(64)}`,
    catalogueByteSha256: `sha256:${'d'.repeat(64)}`,
    catalogueByteLength: 123,
  };
  const provenance = {
    schema: 'snoredex-site-provenance',
    schemaVersion: '1.0.0',
    appRevision: expected.appRevision,
    catalogue: {
      mode: 'pinned-snapshot',
      sourceCommit: expected.producerRevision,
      contractVersion: expected.contractVersion,
      catalogueFingerprint: expected.catalogueFingerprint,
      catalogueByteSha256: expected.catalogueByteSha256,
      catalogueByteLength: expected.catalogueByteLength,
    },
  };
  const deployment = {
    schema: 'snoredex-checklist-deployment',
    schemaVersion: '1.0.0',
    pageUrl: 'https://m4s-ai.github.io/snoredex-checklist/',
    publishedAt: '2026-08-29T21:00:00.000Z',
    appRevision: expected.appRevision,
    producerRevision: expected.producerRevision,
    contractVersion: expected.contractVersion,
    catalogueFingerprint: expected.catalogueFingerprint,
    catalogueByteSha256: expected.catalogueByteSha256,
    catalogueByteLength: expected.catalogueByteLength,
  };
  assert.equal(
    validatePagesDeployment(deployment, provenance, 'https://m4s-ai.github.io/snoredex-checklist/', expected),
    true,
  );
  assert.equal(
    validatePagesDeployment(
      { ...deployment, appRevision: 'e'.repeat(40) },
      provenance,
      'https://m4s-ai.github.io/snoredex-checklist/',
      expected,
    ),
    false,
  );
});

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

test('parses active scripts at SVG HTML integration points', async () => {
  for (const indexScript of [
    '<svg><title><script src="/outside.js"></script></title></svg>',
    '<svg><desc><script src="/outside.js"></script></desc></svg>',
    '<svg><foreignObject><div><script src="/outside.js"></script></div></foreignObject></svg>',
    '<svg><foreignObject><svg><title><script src="/outside.js"></script></title></svg></foreignObject></svg>',
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-svg-script-test-'));
    try {
      await writeValidArtifact(directory, { indexScript });
      const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_SCRIPT_PRESENT: index\.html/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('ignores inert script text during inline-script checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-inert-script-test-'));
  try {
    await writeValidArtifact(directory, {
      indexScript:
        '<textarea><script>example</script></textarea><!-- <script>comment</script> --><script src="theme.js"></script>',
    });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /artifact ok:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
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
    `<head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><"<meta http-equiv="refresh" content="0;url=https://evil.invalid">`,
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

test('finds meta refresh after extra equals in unquoted attribute values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-unquoted-value-test-'));
  try {
    const indexMeta = `<head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><x a=x=="><meta http-equiv="refresh" content="0;url=https://evil.invalid">`;
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
      indexMeta: `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="styles.css"></head>`,
      css: '@import"/outside.css";',
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
    'import "./catalogue.js"; console.log(\' from "/not-a-module.js"\');\n',
    '/[/*]/.test("*"); import("/outside.js");\n',
    'const x = /*c*/ /[/*]/.test("*"); import("/outside.js");\n',
    'class X extends /[/*]/.constructor {}; import("/outside.js");\n',
    'const x = new /[/*]/.constructor(); import("/outside.js");\n',
    'const obj={new:1}, foo=2; const x=obj.new / foo; import("/outside.js");\n',
    'class X { #new=2; f(foo){ return this.#new / foo; } } import("/outside.js");\n',
    'if (true) {} /[/*]/.test("*"); import("/outside.js");\n',
    'const foo=1; const C = class {} / foo; import("/outside.js");\n',
    'label: {} /[/*]/.test("*"); import("/outside.js");\n',
    'if (true) { label: {} /[/*]/.test("*"); import("/outside.js"); }\n',
    'const foo=1; const f = function(){} / foo; import("/outside.js");\n',
    'const foo=1; const f = function(a=foo()){} / foo; import("/outside.js");\n',
    'const foo=1; const f=function(a=/[(]/){} / foo; import("/outside.js");\n',
    'while(false){continue\n/[/*]/.test("*");} import("/outside.js");\n',
    'while(false){break\n/[/*]/.test("*");} import("/outside.js");\n',
    'while(false){break\u2028/[/*]/.test("*");} import("/outside.js");\n',
    'while(false){continue\u2029/[/*]/.test("*");} import("/outside.js");\n',
    '// comment\u2028import("/outside.js");\n',
    '// comment\u2029import("/outside.js");\n',
    'debugger\n/[/*]/.test("*"); import("/outside.js");\n',
    'const source = "/outside.js"; import(source);\n',
    'if (/[(]/.test("(")) /[/*]/.test("*"); import("/outside.js");\n',
    'class X { x=/}/; } /[/*]/.test("*"); import("/outside.js");\n',
    'class X { x=/\\}/; } /[/*]/.test("*"); import("/outside.js");\n',
    'const x={.../[/*]/}; import("/outside.js");\n',
    'const r=/[/*]/; const x=`${import("/outside.js")}`;\n',
    'if(true){foo()\nlabel:{} /[/*]/.test("*"); import("/outside.js");}\n',
    'const of=4, foo=2; const x=of / foo; const y=`${import("/outside.js")}`;\n',
    'const foo=1; const obj={\nlabel:{} / foo}; import("/outside.js");\n',
    'for (const value of /[/*]/) {} import("/outside.js");\n',
    'for (const [x = ";"] of /[/*]/) {} import("/outside.js");\n',
    'for (const [x = ")"] of /[/*]/) {} import("/outside.js");\n',
    'for (const [x = (()=>{return 1;})()] of /[/*]/) {} import("/outside.js");\n',
    'const foo=1; const obj={x:1,\nlabel:{} / foo}; import("/outside.js");\n',
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

test('accepts AST-recognized module dependencies that stay inside the artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-internal-module-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(join(directory, 'dependency.js'), 'export default true; export const value = true;\n');
    await writeFile(
      join(directory, 'theme.js'),
      [
        'import "./dependency.js";',
        'import value from "./dependency.js";',
        'export * from "./dependency.js";',
        'export { value } from "./dependency.js";',
        'void import(`./dependency.js`);',
        'void import("./\\u0064ependency.js");',
      ].join('\n'),
    );
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /artifact ok:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects computed dynamic-import template targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-computed-module-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(join(directory, 'theme.js'), 'const name = "dependency"; import(`./${name}.js`);\n');
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_MODULE_PRESENT: theme\.js/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects syntactically invalid emitted JavaScript', async () => {
  for (const [name, source] of [
    ['missing-expression', 'const broken = ;\n'],
    ['semicolonless-field-before-generator', 'class C { x=1\n*import() {} }\n'],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `snoredex-artifact-invalid-${name}-test-`));
    try {
      await writeValidArtifact(directory);
      await writeFile(join(directory, 'theme.js'), source);
      const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_JAVASCRIPT_INVALID: theme\.js/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('preserves script-supporting elements after invalid plaintext in select context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-select-plaintext-test-'));
  try {
    await writeValidArtifact(directory, {
      indexScript: '<select><plaintext><script src="/outside.js"></script>',
    });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_SCRIPT_PRESENT: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves script-supporting elements after invalid style in select context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-select-style-test-'));
  try {
    await writeValidArtifact(directory, {
      indexScript: '<select><style><script src="/outside.js"></script>',
    });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_SCRIPT_PRESENT: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves script-supporting elements after invalid xmp in select context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-select-xmp-test-'));
  try {
    await writeValidArtifact(directory, {
      indexScript: '<select><xmp><script src="/outside.js"></script>',
    });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_SCRIPT_PRESENT: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves script-supporting elements after invalid xmp in frameset context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-frameset-xmp-test-'));
  try {
    await writeValidArtifact(directory, {
      indexScript: '<frameset><xmp><script src="/outside.js"></script>',
    });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_SCRIPT_PRESENT: index\.html/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves noframes raw text inside frameset context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-frameset-noframes-test-'));
  try {
    await writeValidArtifact(directory, {
      indexScript: '<frameset><noframes><script>example</script></noframes></frameset>',
    });
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /artifact ok:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ignores from text inside JavaScript regex literals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-module-regex-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(join(directory, 'theme.js'), 'export default /from "\\/outside.js"/;\n');
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /artifact ok:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ignores import text inside JavaScript regex literals during outer scanning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-module-outer-regex-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(join(directory, 'theme.js'), 'const r = /import from "\\/outside.js"/;\n');
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /artifact ok:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ignores dynamic-import text inside JavaScript strings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-module-string-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(join(directory, 'theme.js'), 'const message = \'import("/outside.js")\';\n');
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /artifact ok:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ignores ordinary methods and member calls named import', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-member-import-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(
      join(directory, 'theme.js'),
      'const helper={import(value){return value}}; helper.import("/not-a-module.js");\n',
    );
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /artifact ok:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recognizes regexes after labeled jump statements', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-labeled-jump-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(
      join(directory, 'theme.js'),
      'label: while(false){ break label\n/[/*]/.test("*"); } import("/outside.js");\n',
    );
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_MODULE_PRESENT: theme\.js/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not treat a newline block after dynamic import as a method body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-import-block-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(join(directory, 'theme.js'), 'import("/outside.js")\n{}\n');
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_MODULE_PRESENT: theme\.js/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not extend labeled jumps across a line terminator', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-jump-label-line-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(join(directory, 'theme.js'), 'while(false){break\nfoo\n/bar;} import("/outside.js");\n');
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_MODULE_PRESENT: theme\.js/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps classic await and yield identifiers out of regex context', async () => {
  for (const [name, source] of [
    ['await', 'const await=4, foo=2; const x=await / foo; import("/outside.js");\n'],
    ['yield', 'const yield=4, foo=2; const x=yield / foo; import("/outside.js");\n'],
    ['await-comma', 'const foo=2, await=4; const x=await / foo; import("/outside.js");\n'],
    ['await-destructured', 'const foo=2, {await}=globalThis; const x=await / foo; import("/outside.js");\n'],
    ['yield-destructured', 'const foo=2, {yield}=globalThis; const x=yield / foo; import("/outside.js");\n'],
    ['await-parameter', 'function f(await){const foo=2; const x=await / foo; import("/outside.js")} f(4)\n'],
    ['yield-catch', 'try {} catch (yield) { const foo=2; const x=yield / foo; import("/outside.js") }\n'],
    [
      'await-parameter-regex-default',
      'function f(x=/[)]/, await){const foo=2; const y=await / foo; import("/outside.js")} f()\n',
    ],
    [
      'yield-function-scope',
      'function f(yield){} function* g(){yield /[/*]/; import("/outside.js")} const i=g();i.next();i.next();\n',
    ],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `snoredex-artifact-${name}-identifier-test-`));
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

test('recognizes modified methods after semicolonless class fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-modified-class-method-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(join(directory, 'theme.js'), 'class C { x=1\nstatic import() {} }\n');
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /artifact ok:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recognizes generator methods named import after class fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-generator-class-method-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(join(directory, 'theme.js'), 'class C { x=1;\n*import() {} }\n');
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /artifact ok:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('treats static initialization bodies as statement blocks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-static-block-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(join(directory, 'theme.js'), 'class C { static { import("/outside.js")\n{} } }\n');
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /ARTIFACT_EXTERNAL_MODULE_PRESENT: theme\.js/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recognizes methods after semicolonless class fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snoredex-artifact-class-field-method-test-'));
  try {
    await writeValidArtifact(directory);
    await writeFile(join(directory, 'theme.js'), 'class C { x=1\nimport() {} }\n');
    const result = spawnSync(process.execPath, [checker, directory], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /artifact ok:/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
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
