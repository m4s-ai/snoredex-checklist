import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createCatalogueReleaseManifest } from '../scripts/catalogue-release.mjs';
import { semanticFingerprint } from '../src/catalogue/validate.ts';

const catalogueBytes = await readFile('vendor/snoredex-data/collector_catalogue.json');
const migrationBytes = await readFile('vendor/snoredex-data/collector_migrations.json');
const fixtureBytes = await readFile('tests/fixtures/collector-catalogue.fixture.json');
const schemaBytes = Buffer.from(
  JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://m4s-ai.github.io/snoredex-data/collector_catalogue.schema.json',
    type: 'object',
  }),
);
const currentLock = JSON.parse(await readFile('catalogue.lock.json', 'utf8'));
const workflow = await readFile('.github/workflows/catalogue-release.yml', 'utf8');
const issueUrls = [
  'https://github.com/m4s-ai/snoredex-checklist/issues/29',
  'https://github.com/m4s-ai/snoredex-data/issues/332',
];

function input() {
  return {
    producerRevision: currentLock.producerRevision,
    candidateBytes: {
      'collector_catalogue.json': catalogueBytes,
      'collector_catalogue.schema.json': schemaBytes,
      'collector_migrations.json': migrationBytes,
      'collector_catalogue.fixture.json': fixtureBytes,
    },
    currentLock,
    issueUrls,
  };
}

test('detects release changes independently from adoption changes', () => {
  const first = createCatalogueReleaseManifest(input());
  assert.equal(first.changeStatus, 'changed');
  assert.equal(first.adoptionStatus, 'current');
  assert.equal(first.compatibility.status, 'unchecked');

  const repeated = createCatalogueReleaseManifest({ ...input(), previousRelease: first });
  assert.equal(repeated.changeStatus, 'unchanged');
  assert.equal(repeated.adoptionStatus, 'current');
});

test('rejects catalogue bytes whose semantic fingerprint is not sealed', () => {
  const catalogue = JSON.parse(catalogueBytes.toString('utf8'));
  catalogue.meta.dataAsOf = '2099-01-01';
  assert.throws(
    () =>
      createCatalogueReleaseManifest({
        ...input(),
        candidateBytes: {
          ...input().candidateBytes,
          'collector_catalogue.json': Buffer.from(JSON.stringify(catalogue)),
        },
      }),
    /CATALOGUE_RELEASE_CATALOGUE_INVALID/u,
  );
});

test('packages consumer-incompatible producer bytes only as blocked', () => {
  const catalogue = JSON.parse(catalogueBytes.toString('utf8'));
  catalogue.items[0].progressClass = 'unsupported';
  catalogue.meta.catalogueFingerprint = semanticFingerprint(catalogue);
  const migrations = JSON.parse(migrationBytes.toString('utf8'));
  migrations.meta.toFingerprint = catalogue.meta.catalogueFingerprint;
  const incompatibleInput = {
    ...input(),
    candidateBytes: {
      ...input().candidateBytes,
      'collector_catalogue.json': Buffer.from(`${JSON.stringify(catalogue)}\n`),
      'collector_migrations.json': Buffer.from(`${JSON.stringify(migrations)}\n`),
    },
  };

  const blocked = createCatalogueReleaseManifest({
    ...incompatibleInput,
    compatibilityStatus: 'blocked',
    compatibilityCode: 'CATALOGUE_UPDATE_BLOCKED_CONSUMER_CONTRACT',
  });
  assert.equal(blocked.consumerValidation.status, 'blocked');
  assert.ok(blocked.consumerValidation.codes.length > 0);
  assert.throws(
    () =>
      createCatalogueReleaseManifest({
        ...incompatibleInput,
        compatibilityStatus: 'ready',
        compatibilityCode: 'CATALOGUE_UPDATE_READY',
      }),
    /CATALOGUE_RELEASE_COMPATIBILITY_INVALID/u,
  );
});

test('workflow gates exact producer bytes, skips duplicate releases and preserves blocked adoption', () => {
  assert.ok(workflow.includes('select(.head_sha == \\"${producer_revision}\\")'));
  assert.match(workflow, /raw\.githubusercontent\.com\/\$\{PRODUCER_REPOSITORY\}\/\$\{PRODUCER_REVISION\}/u);
  assert.match(workflow, /if: steps\.candidate\.outputs\.change_status == 'changed'/u);
  assert.match(workflow, /git restore -- catalogue\.lock\.json vendor\/snoredex-data\/collector_catalogue\.json/u);
  assert.match(workflow, /release_args\+=\(--prerelease\)/u);
  assert.match(workflow, /steps\.sealed\.outputs\.status == 'ready'/u);
});
