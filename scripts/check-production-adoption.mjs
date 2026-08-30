import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function readJson(path) {
  try {
    return JSON.parse(await readFile(resolve(root, path), 'utf8'));
  } catch {
    throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_AUTHORITY');
  }
}

const fixture = await readJson('tests/fixtures/collector-catalogue.fixture.json');
const lock = await readJson('catalogue.lock.json');
const migrations = await readJson('vendor/snoredex-data/collector_migrations.json');
const fixtureFingerprint = fixture?.catalogue?.meta?.catalogueFingerprint;
const targetFingerprint = lock?.catalogueFingerprint;
const route = migrations?.catalogueTransitions?.find(
  (candidate) => candidate.fromFingerprint === fixtureFingerprint && candidate.toFingerprint === targetFingerprint,
);
const fixtureItemIds = fixture?.catalogue?.items?.map((item) => item.itemId);
const routeItemIds = route?.transitions?.flatMap((transition) => transition.fromItemIds ?? [transition.fromItemId]);
const coveredItemIds = new Set(routeItemIds);

if (
  typeof fixtureFingerprint !== 'string' ||
  typeof targetFingerprint !== 'string' ||
  !route ||
  !Array.isArray(fixtureItemIds) ||
  fixtureItemIds.some((itemId) => typeof itemId !== 'string' || !coveredItemIds.has(itemId))
) {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_MISSING_REVIEWED_TRANSITION');
}

console.log('production adoption migration coverage ok');
