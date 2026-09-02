import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { replaceOutput } from '../scripts/site-output.ts';
import { buildValidatedSourceMembershipIndex } from '../scripts/migration-membership.ts';

const root = resolve(import.meta.dirname, '..');

test('validates migration source membership against the target contract', () => {
  const catalogue = {
    meta: { catalogueFingerprint: 'sha256:target' },
    items: [{ itemId: 'item-a' }, { itemId: 'item-b' }, { itemId: 'item-c' }],
  };
  const manifest = {
    catalogueTransitions: [
      {
        fromFingerprint: 'sha256:source',
        toFingerprint: 'sha256:target',
        sourceItemIds: ['item-a', 'item-b'],
        transitions: [
          {
            fromItemId: 'item-a',
            toItemIds: ['item-a'],
            changeKind: 'retained',
            automaticStateAction: 'preserve',
            reconciliation: 'identity-retained',
          },
          {
            fromItemId: 'item-b',
            toItemIds: ['item-b'],
            changeKind: 'retained',
            automaticStateAction: 'preserve',
            reconciliation: 'identity-retained',
          },
        ],
      },
    ],
  };
  const index = buildValidatedSourceMembershipIndex(manifest, catalogue);
  assert.deepEqual([...(index.get('sha256:source') ?? [])], ['item-a', 'item-b']);

  const omitted = structuredClone(manifest);
  omitted.catalogueTransitions[0].transitions.pop();
  assert.throws(
    () => buildValidatedSourceMembershipIndex(omitted, catalogue),
    /BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID/u,
  );

  const unknownTarget = structuredClone(manifest);
  unknownTarget.catalogueTransitions[0].transitions[0].toItemIds = ['item-z'];
  assert.throws(
    () => buildValidatedSourceMembershipIndex(unknownTarget, catalogue),
    /BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID/u,
  );
});

test('stamps the exact app revision into served shells and module', async () => {
  const output = await mkdtemp(`${tmpdir()}/snoredex-build-revision-test-`);
  const revision = 'f'.repeat(40);
  try {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/build-site.mjs'), '--out-dir', output], {
      cwd: root,
      env: { ...process.env, SNOREDEX_APP_REVISION: revision },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const [
      home,
      collection,
      guide,
      stylesheet,
      app,
      collectionApp,
      index,
      directorySnapshot,
      theme,
      collectionTheme,
      moduleManifestText,
      font400,
      font500,
      sourceFont400,
      sourceFont500,
    ] = await Promise.all([
      readFile(resolve(output, 'index.html'), 'utf8'),
      readFile(resolve(output, 'collection/index.html'), 'utf8'),
      readFile(resolve(output, 'llms.txt'), 'utf8'),
      readFile(resolve(output, 'styles.css'), 'utf8'),
      readFile(resolve(output, 'assets/app.js'), 'utf8'),
      readFile(resolve(output, 'assets/collection.js'), 'utf8'),
      readFile(resolve(output, 'assets/index.js'), 'utf8'),
      readFile(resolve(output, 'assets/directory-snapshot.js'), 'utf8'),
      readFile(resolve(output, 'theme.js'), 'utf8'),
      readFile(resolve(output, 'collection/theme.js'), 'utf8'),
      readFile(resolve(output, 'assets/module-manifest.json'), 'utf8'),
      readFile(resolve(output, 'assets/fonts/nunito-sans-latin-400-normal.woff2')),
      readFile(resolve(output, 'assets/fonts/nunito-sans-latin-500-normal.woff2')),
      readFile(resolve(root, 'site-src/assets/fonts/nunito-sans-latin-400-normal.woff2')),
      readFile(resolve(root, 'site-src/assets/fonts/nunito-sans-latin-500-normal.woff2')),
    ]);
    assert.match(home, new RegExp(`name="snoredex-app-revision" content="${revision}"`, 'u'));
    assert.match(collection, new RegExp(`name="snoredex-app-revision" content="${revision}"`, 'u'));
    assert.match(guide, new RegExp(`snoredex-app-revision:${revision}`, 'u'));
    assert.match(stylesheet, new RegExp(`snoredex-app-revision:${revision}`, 'u'));
    assert.match(app, new RegExp(`snoredex-app-revision:${revision}`, 'u'));
    assert.match(collectionApp, new RegExp(`snoredex-app-revision:${revision}`, 'u'));
    assert.match(index, new RegExp(`snoredex-app-revision:${revision}`, 'u'));
    assert.match(directorySnapshot, new RegExp(`snoredex-app-revision:${revision}`, 'u'));
    assert.match(home, /<script type="module" src="assets\/app\.js"><\/script>/u);
    assert.match(collection, /<script type="module" src="\.\.\/assets\/app\.js"><\/script>/u);
    assert.match(app, /import\(['"]\.\/collection\.js['"]\)/u);
    assert.match(app, /import\(['"]\.\/index\.js['"]\)/u);
    assert.doesNotMatch(app, /from ['"]\.\/(?:snapshot|migrations)\.js['"]/u);
    assert.doesNotMatch(index, /from ['"]\.\/(?:snapshot|migrations)\.js['"]/u);
    assert.match(theme, new RegExp(`snoredex-app-revision:${revision}`, 'u'));
    assert.match(collectionTheme, new RegExp(`snoredex-app-revision:${revision}`, 'u'));
    assert.deepEqual(font400, sourceFont400);
    assert.deepEqual(font500, sourceFont500);
    const moduleManifest = JSON.parse(moduleManifestText);
    assert.equal(moduleManifest.schema, 'snoredex-site-module-manifest');
    assert.equal(moduleManifest.appRevision, revision);
    assert.ok(Array.isArray(moduleManifest.modules));
    assert.ok(moduleManifest.modules.includes('app.js'));
    assert.ok(moduleManifest.modules.includes('collection.js'));
    assert.ok(moduleManifest.modules.includes('index.js'));
    assert.ok(moduleManifest.modules.includes('directory-snapshot.js'));
    for (const modulePath of moduleManifest.modules) {
      const module = await readFile(resolve(output, 'assets', modulePath), 'utf8');
      assert.match(module, new RegExp(`snoredex-app-revision:${revision}`, 'u'));
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('reports the recovery path when replacement and restore both fail', async () => {
  const output = '/site';
  const previous = '/site.previous-123';
  const staging = '/site.staging-123';
  const calls: Array<[string, string]> = [];

  await assert.rejects(
    () =>
      replaceOutput({
        output,
        previous,
        staging,
        renamePath: async (source, destination) => {
          calls.push([source, destination]);
          if (source === staging) throw new Error('install failed');
          if (source === previous) throw new Error('restore failed');
        },
        removePath: async () => {
          throw new Error('previous output should not be removed after a failed restore');
        },
      }),
    (error: unknown) => {
      assert.equal(error instanceof AggregateError, true);
      if (!(error instanceof AggregateError)) return false;
      assert.match(error.message, /install failed/);
      assert.match(error.message, /restore failed/);
      assert.match(error.message, /\/site\.previous-123/);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
  assert.deepEqual(calls, [
    [output, previous],
    [staging, output],
    [previous, output],
  ]);
});
