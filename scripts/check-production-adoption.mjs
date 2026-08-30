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
const currentDeploymentPath = process.env.SNOREDEX_CURRENT_DEPLOYMENT_PATH;
const legacyCurrentFingerprint = process.env.SNOREDEX_CURRENT_CATALOGUE_FINGERPRINT;
const hasCurrentDeployment = currentDeploymentPath !== undefined && currentDeploymentPath !== '';
let currentDeployment;
if (hasCurrentDeployment) {
  try {
    currentDeployment = JSON.parse(await readFile(currentDeploymentPath, 'utf8'));
  } catch {
    throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT');
  }
}
const currentFingerprint = currentDeployment?.catalogueFingerprint ?? legacyCurrentFingerprint;
const hasCurrentFingerprint = currentFingerprint !== undefined && currentFingerprint !== '';
if (deploymentMode !== 'adopt' && deploymentMode !== 'rollback') {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_DEPLOYMENT_MODE');
}
if (hasCurrentFingerprint && !/^sha256:[0-9a-f]{64}$/u.test(currentFingerprint)) {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_FINGERPRINT');
}
if (hasCurrentDeployment && !hasCurrentFingerprint) {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT');
}
if (deploymentMode === 'rollback') {
  if (!hasCurrentDeployment) {
    throw new Error('PRODUCTION_ADOPTION_BLOCKED_ROLLBACK_REQUIRES_PUBLISHED_DEPLOYMENT');
  }
  console.log('production rollback target accepted');
  process.exit(0);
}

const sourceFingerprints = hasCurrentDeployment
  ? (currentDeployment?.sourceFingerprints ?? [])
  : hasCurrentFingerprint
    ? [currentFingerprint]
    : [];
if (
  !Array.isArray(sourceFingerprints) ||
  sourceFingerprints.some((value) => !/^sha256:[0-9a-f]{64}$/u.test(value)) ||
  new Set(sourceFingerprints).size !== sourceFingerprints.length
) {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT');
}

if (typeof targetFingerprint !== 'string') {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_MISSING_REVIEWED_TRANSITION');
}
const migrationSources = hasCurrentDeployment
  ? [...new Set([...sourceFingerprints, currentFingerprint])]
  : sourceFingerprints;
if (!hasCurrentDeployment && !hasCurrentFingerprint) {
  const initialRoute = migrations?.catalogueTransitions?.find(
    (candidate) => candidate?.toFingerprint === targetFingerprint,
  );
  if (!initialRoute || !Array.isArray(initialRoute.transitions) || initialRoute.transitions.length === 0) {
    throw new Error('PRODUCTION_ADOPTION_BLOCKED_MISSING_REVIEWED_TRANSITION');
  }
}
for (const sourceFingerprint of migrationSources) {
  if (sourceFingerprint === targetFingerprint) continue;
  const route = migrations?.catalogueTransitions?.find(
    (candidate) => candidate?.fromFingerprint === sourceFingerprint && candidate?.toFingerprint === targetFingerprint,
  );
  if (!route || !Array.isArray(route.transitions) || route.transitions.length === 0) {
    throw new Error('PRODUCTION_ADOPTION_BLOCKED_MISSING_REVIEWED_TRANSITION');
  }
}

console.log('production adoption migration target ok');
