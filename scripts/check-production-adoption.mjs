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

const lock = await readJson('catalogue.lock.json');
const migrations = await readJson('vendor/snoredex-data/collector_migrations.json');
const targetFingerprint = lock?.catalogueFingerprint;
const route = migrations?.catalogueTransitions?.find((candidate) => candidate.toFingerprint === targetFingerprint);

if (
  typeof targetFingerprint !== 'string' ||
  !route ||
  !Array.isArray(route.transitions) ||
  route.transitions.length === 0
) {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_MISSING_REVIEWED_TRANSITION');
}

console.log('production adoption migration target ok');
