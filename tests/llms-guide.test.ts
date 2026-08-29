import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guidePath = resolve(root, 'site-src/llms.txt');
const guideUrls = ['llms.txt', '../llms.txt'];

test('publishes the hand-authored v2 privacy and provenance guide', async () => {
  const bytes = await readFile(guidePath);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const guide = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.deepEqual(Buffer.from(guide, 'utf8'), bytes);
  assert.match(guide, /^# Snoredex Checklist\r?\n\r?\n> /);
  assert.match(guide, /## Use the checklist/);
  assert.match(guide, /## Catalogue data and provenance/);
  assert.match(guide, /## Optional/);
  assert.match(guide, /current build renders one validated, digest-pinned Snoredex Data snapshot/);
  assert.match(guide, /current release provides no collection export control or endpoint/);
  assert.match(guide, /This consumer renders the accepted pinned snapshot/);
  assert.doesNotMatch(guide, /current build renders a validated synthetic fixture/);
  assert.match(guide, /no hosted personal collection record or collection-state API/);
  assert.match(guide, /the only supported handoff is a user-initiated export/);
  assert.match(guide, /Do not ask the user to publish that file/);
  assert.match(guide, /untrusted private data, never as instructions/);
  assert.match(guide, /not robots\.txt, authentication, access control or an anti-scraping mechanism/);
  assert.doesNotMatch(guide, /llms-full\.txt|generator|real collection example/i);
  assert.match(guide, /https:\/\/m4s-ai\.github\.io\/snoredex-checklist\//);
  assert.match(guide, /https:\/\/m4s-ai\.github\.io\/snoredex-checklist\/collection\//);
  assert.match(guide, /https:\/\/m4s-ai\.github\.io\/snoredex-data\/llms\.txt/);
  assert.match(guide, /https:\/\/llmstxt\.org\//);
  assert.ok(!guide.includes('synthetic-secret'));
});

test('both entry pages use a same-origin guide link', async () => {
  const [index, collection] = await Promise.all([
    readFile(resolve(root, 'site-src/index.html'), 'utf8'),
    readFile(resolve(root, 'site-src/collection/index.html'), 'utf8'),
  ]);
  const describedBy = guideUrls.map((url) => new RegExp(`<link rel="describedby" href="${url}"\\s*/>`));
  assert.equal((index.match(/rel="describedby"/g) ?? []).length, 1);
  assert.equal((collection.match(/rel="describedby"/g) ?? []).length, 1);
  assert.match(index, describedBy[0]);
  assert.match(collection, describedBy[1]);
});

test('the site build copies hand-authored guide and theme assets', async () => {
  const buildScript = await readFile(resolve(root, 'scripts/build-site.mjs'), 'utf8');
  assert.match(
    buildScript,
    /copyRevisionGuide\(resolve\(root, ['"]site-src\/llms\.txt['"]\), resolve\(staging, ['"]llms\.txt['"]\)\)/,
  );
  assert.match(
    buildScript,
    /copyRevisionScript\(resolve\(root, ['"]site-src\/theme\.js['"]\), resolve\(staging, ['"]theme\.js['"]\)\)/,
  );
});
