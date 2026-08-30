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
const deploymentMode = process.env.SNOREDEX_DEPLOYMENT_MODE ?? 'adopt';
const currentFingerprint = process.env.SNOREDEX_CURRENT_CATALOGUE_FINGERPRINT;
const hasCurrentFingerprint = currentFingerprint !== undefined && currentFingerprint !== '';
if (deploymentMode !== 'adopt' && deploymentMode !== 'rollback') {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_DEPLOYMENT_MODE');
}
if (hasCurrentFingerprint && !/^sha256:[0-9a-f]{64}$/u.test(currentFingerprint)) {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_FINGERPRINT');
}
if (deploymentMode === 'rollback') {
  if (!hasCurrentFingerprint) {
    throw new Error('PRODUCTION_ADOPTION_BLOCKED_ROLLBACK_REQUIRES_PUBLISHED_DEPLOYMENT');
  }
  console.log('production rollback target accepted');
  process.exit(0);
}
const route = migrations?.catalogueTransitions?.find((candidate) => candidate.toFingerprint === targetFingerprint);
const currentRoute = hasCurrentFingerprint
  ? migrations?.catalogueTransitions?.find(
      (candidate) => candidate.fromFingerprint === currentFingerprint && candidate.toFingerprint === targetFingerprint,
    )
  : route;
const hasRequiredRoute = hasCurrentFingerprint ? currentFingerprint === targetFingerprint || currentRoute : route;

if (
  typeof targetFingerprint !== 'string' ||
  !hasRequiredRoute ||
  (currentFingerprint !== targetFingerprint &&
    (!Array.isArray(hasRequiredRoute.transitions) || hasRequiredRoute.transitions.length === 0))
) {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_MISSING_REVIEWED_TRANSITION');
}

console.log('production adoption migration target ok');
