import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertCatalogueReleaseEvidenceMatches,
  createCatalogueReleaseManifest,
} from '../scripts/catalogue-release.mjs';
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
const consumerRevision = '1111111111111111111111111111111111111111';
const workflow = await readFile('.github/workflows/catalogue-release.yml', 'utf8');
const ciWorkflow = await readFile('.github/workflows/ci.yml', 'utf8');
const issueUrls = [
  'https://github.com/m4s-ai/snoredex-checklist/issues/29',
  'https://github.com/m4s-ai/snoredex-data/issues/332',
];

function input() {
  return {
    producerRevision: currentLock.producerRevision,
    consumerRevision,
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
  const first = createCatalogueReleaseManifest({
    ...input(),
    compatibilityStatus: 'ready',
    compatibilityCode: 'CATALOGUE_UPDATE_CURRENT',
  });
  assert.equal(first.changeStatus, 'changed');
  assert.equal(first.publicationStatus, 'changed');
  assert.equal(first.adoptionStatus, 'current');
  assert.equal(first.compatibility.status, 'ready');

  const repeated = createCatalogueReleaseManifest({
    ...input(),
    previousRelease: first,
    compatibilityStatus: 'ready',
    compatibilityCode: 'CATALOGUE_UPDATE_CURRENT',
  });
  assert.equal(repeated.changeStatus, 'unchanged');
  assert.equal(repeated.publicationStatus, 'unchanged');
  assert.equal(repeated.adoptionStatus, 'current');
});

test('publishes changed compatibility evidence for unchanged producer assets', () => {
  const blocked = createCatalogueReleaseManifest({
    ...input(),
    compatibilityStatus: 'blocked',
    compatibilityCode: 'CATALOGUE_UPDATE_BLOCKED_MIGRATION',
  });
  const ready = createCatalogueReleaseManifest({
    ...input(),
    consumerRevision: '2222222222222222222222222222222222222222',
    previousRelease: blocked,
    compatibilityStatus: 'ready',
    compatibilityCode: 'CATALOGUE_UPDATE_READY',
  });
  assert.equal(ready.changeStatus, 'unchanged');
  assert.equal(ready.publicationStatus, 'changed');

  const retried = createCatalogueReleaseManifest({
    ...input(),
    consumerRevision: '2222222222222222222222222222222222222222',
    previousRelease: ready,
    compatibilityStatus: 'ready',
    compatibilityCode: 'CATALOGUE_UPDATE_READY',
  });
  assert.equal(retried.publicationStatus, 'unchanged');

  const newerConsumer = createCatalogueReleaseManifest({
    ...input(),
    consumerRevision: '3333333333333333333333333333333333333333',
    previousRelease: ready,
    compatibilityStatus: 'ready',
    compatibilityCode: 'CATALOGUE_UPDATE_READY',
  });
  assert.equal(newerConsumer.publicationStatus, 'changed');
});

test('reuses only matching immutable publication evidence', () => {
  const published = createCatalogueReleaseManifest({
    ...input(),
    compatibilityStatus: 'ready',
    compatibilityCode: 'CATALOGUE_UPDATE_READY',
  });
  const retried = {
    ...structuredClone(published),
    comparedTo: {
      producerRevision: '2222222222222222222222222222222222222222',
      consumerRevision: '3333333333333333333333333333333333333333',
      catalogueFingerprint: published.catalogueFingerprint,
    },
    publicationStatus: 'changed',
  };
  assert.doesNotThrow(() => assertCatalogueReleaseEvidenceMatches(published, retried));
  assert.throws(
    () =>
      assertCatalogueReleaseEvidenceMatches(published, {
        ...retried,
        consumerRevision: '4444444444444444444444444444444444444444',
      }),
    /CATALOGUE_RELEASE_PUBLISHED_CONFLICT/u,
  );
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
  assert.match(workflow, /if: steps\.sealed\.outputs\.publication_status == 'changed'/u);
  assert.match(workflow, /git restore -- catalogue\.lock\.json vendor\/snoredex-data\/collector_catalogue\.json/u);
  assert.match(workflow, /release_args\+=\(--prerelease\)/u);
  assert.match(workflow, /steps\.sealed\.outputs\.status == 'ready'/u);
  assert.match(workflow, /SNOREDEX_CURRENT_DEPLOYMENT_PATH="\$CURRENT_DEPLOYMENT_PATH"/u);
  assert.match(workflow, /CATALOGUE_UPDATE_BLOCKED_CURRENT_DEPLOYMENT/u);
  assert.doesNotMatch(workflow, /state=missing/u);
  assert.match(workflow, /gh release list --exclude-drafts/u);
  assert.match(workflow, /tag="catalogue-\$\{PRODUCER_REVISION\}-\$\{GITHUB_SHA\}-\$\{COMPATIBILITY_CODE\}"/u);
  assert.match(workflow, /select\(\.tag_name ==/u);
  assert.match(workflow, /assertCatalogueReleaseEvidenceMatches/u);
  assert.match(workflow, /gh api --method DELETE "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{release_id\}"/u);
  assert.match(workflow, /branch="codex\/catalogue-\$\{PRODUCER_REVISION\}-\$\{GITHUB_SHA\}"/u);
  assert.match(workflow, /branch_parent=.*git rev-parse "origin\/\$\{branch\}\^"/u);
  assert.match(workflow, /gh workflow run ci\.yml --ref "\$branch"/u);
  assert.match(workflow, /event=workflow_dispatch/u);
  assert.match(workflow, /existing_pr=.*\n          if git ls-remote/u);
  assert.match(ciWorkflow, /workflow_dispatch:/u);
});
