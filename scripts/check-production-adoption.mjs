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
const pageUrl = 'https://m4s-ai.github.io/snoredex-checklist/';
const deploymentMode = process.env.SNOREDEX_DEPLOYMENT_MODE ?? 'adopt';
const currentDeploymentPath = process.env.SNOREDEX_CURRENT_DEPLOYMENT_PATH;
const currentProvenancePath = process.env.SNOREDEX_CURRENT_PROVENANCE_PATH;
const currentModuleManifestPath = process.env.SNOREDEX_CURRENT_MODULE_MANIFEST_PATH;
const legacyCurrentFingerprint = process.env.SNOREDEX_CURRENT_CATALOGUE_FINGERPRINT;
const bootstrapAuthorization = process.env.SNOREDEX_BOOTSTRAP_AUTHORIZED;
const hasCurrentDeployment = currentDeploymentPath !== undefined && currentDeploymentPath !== '';
const hasCurrentProvenance = currentProvenancePath !== undefined && currentProvenancePath !== '';
const hasCurrentModuleManifest = currentModuleManifestPath !== undefined && currentModuleManifestPath !== '';
let currentDeployment;
let currentProvenance;
let currentModuleManifest;
if (hasCurrentDeployment) {
  try {
    currentDeployment = JSON.parse(await readFile(currentDeploymentPath, 'utf8'));
  } catch {
    throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT');
  }
}
if (hasCurrentProvenance) {
  try {
    currentProvenance = JSON.parse(await readFile(currentProvenancePath, 'utf8'));
  } catch {
    throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT');
  }
}
if (hasCurrentModuleManifest) {
  try {
    currentModuleManifest = JSON.parse(await readFile(currentModuleManifestPath, 'utf8'));
  } catch {
    throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT');
  }
}
const currentFingerprint = currentDeployment?.catalogueFingerprint ?? legacyCurrentFingerprint;
const hasCurrentFingerprint = currentFingerprint !== undefined && currentFingerprint !== '';
const isCommit = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
const isDigest = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
const isByteLength = (value) => Number.isSafeInteger(value) && value > 0;
const isPublishedAt = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value);
const isSourceHistory = (value) =>
  value === undefined ||
  (Array.isArray(value) && value.every((entry) => isDigest(entry)) && new Set(value).size === value.length);
const publicationFormat = 'provenance-history-v1';
const isPublicationFormat = (value) => value === undefined || value === publicationFormat;
const isPublishedModuleManifest = (value) =>
  value?.schema === 'snoredex-site-module-manifest' &&
  value?.schemaVersion === '2.0.0' &&
  isCommit(value?.appRevision) &&
  isPublicationFormat(value?.publicationFormat);
const isPublishedDeployment = (value) =>
  value?.schema === 'snoredex-checklist-deployment' &&
  value?.schemaVersion === '1.0.0' &&
  value?.pageUrl === pageUrl &&
  isPublishedAt(value?.publishedAt) &&
  isCommit(value?.appRevision) &&
  isCommit(value?.producerRevision) &&
  value?.contractVersion === '1.0.0' &&
  isDigest(value?.catalogueFingerprint) &&
  isDigest(value?.catalogueByteSha256) &&
  isByteLength(value?.catalogueByteLength) &&
  isDigest(value?.migrationByteSha256) &&
  isByteLength(value?.migrationByteLength) &&
  isPublicationFormat(value?.publicationFormat) &&
  isSourceHistory(value?.sourceFingerprints);
const isPublishedProvenance = (value) => {
  const catalogue = value?.catalogue;
  const lock = catalogue?.lock;
  return (
    value?.schema === 'snoredex-site-provenance' &&
    value?.schemaVersion === '1.0.0' &&
    isCommit(value?.appRevision) &&
    catalogue?.mode === 'pinned-snapshot' &&
    isCommit(catalogue?.sourceCommit) &&
    catalogue?.sourceRepository === 'https://github.com/m4s-ai/snoredex-data' &&
    catalogue?.contractVersion === '1.0.0' &&
    isDigest(catalogue?.catalogueFingerprint) &&
    isDigest(catalogue?.catalogueByteSha256) &&
    isByteLength(catalogue?.catalogueByteLength) &&
    isDigest(catalogue?.migrationByteSha256) &&
    isByteLength(catalogue?.migrationByteLength) &&
    isSourceHistory(value?.sourceFingerprints) &&
    lock?.producerRevision === catalogue.sourceCommit &&
    lock?.sourceRepository === catalogue.sourceRepository &&
    lock?.contractVersion === catalogue.contractVersion &&
    lock?.catalogueFingerprint === catalogue.catalogueFingerprint &&
    lock?.catalogueByteSha256 === catalogue.catalogueByteSha256 &&
    lock?.catalogueByteLength === catalogue.catalogueByteLength &&
    lock?.migrationByteSha256 === catalogue.migrationByteSha256 &&
    lock?.migrationByteLength === catalogue.migrationByteLength
  );
};
const matchesPublishedProvenance = (deployment, provenance) => {
  const catalogue = provenance?.catalogue;
  // Releases created before provenance carried source history still have the
  // canonical history in deployment.json. During the first upgrade, derive it
  // from that validated manifest and require the two published records to agree.
  const publishedSourceFingerprints =
    provenance?.sourceFingerprints === undefined &&
    deployment?.publicationFormat === undefined &&
    currentModuleManifest?.publicationFormat === undefined
      ? deployment?.sourceFingerprints
      : provenance?.sourceFingerprints;
  return (
    deployment?.appRevision === provenance?.appRevision &&
    (currentModuleManifest?.publicationFormat !== publicationFormat ||
      currentModuleManifest?.appRevision === deployment?.appRevision) &&
    deployment?.producerRevision === catalogue?.sourceCommit &&
    deployment?.contractVersion === catalogue?.contractVersion &&
    deployment?.catalogueFingerprint === catalogue?.catalogueFingerprint &&
    deployment?.catalogueByteSha256 === catalogue?.catalogueByteSha256 &&
    deployment?.catalogueByteLength === catalogue?.catalogueByteLength &&
    deployment?.migrationByteSha256 === catalogue?.migrationByteSha256 &&
    deployment?.migrationByteLength === catalogue?.migrationByteLength &&
    Array.isArray(publishedSourceFingerprints) &&
    isSourceHistory(publishedSourceFingerprints) &&
    JSON.stringify(deployment?.sourceFingerprints ?? []) === JSON.stringify(publishedSourceFingerprints)
  );
};
if (
  bootstrapAuthorization !== undefined &&
  bootstrapAuthorization !== '' &&
  !['true', 'false'].includes(bootstrapAuthorization)
) {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_BOOTSTRAP_AUTHORIZATION');
}
if (deploymentMode !== 'adopt' && deploymentMode !== 'rollback') {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_DEPLOYMENT_MODE');
}
if (hasCurrentFingerprint && !/^sha256:[0-9a-f]{64}$/u.test(currentFingerprint)) {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_FINGERPRINT');
}
if (
  (hasCurrentDeployment &&
    (!hasCurrentFingerprint ||
      !isPublishedDeployment(currentDeployment) ||
      !hasCurrentProvenance ||
      !hasCurrentModuleManifest ||
      !isPublishedProvenance(currentProvenance) ||
      !isPublishedModuleManifest(currentModuleManifest) ||
      !matchesPublishedProvenance(currentDeployment, currentProvenance))) ||
  (hasCurrentProvenance && !hasCurrentDeployment)
) {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT');
}
if (deploymentMode === 'rollback') {
  if (!hasCurrentDeployment) {
    throw new Error('PRODUCTION_ADOPTION_BLOCKED_ROLLBACK_REQUIRES_PUBLISHED_DEPLOYMENT');
  }
  if (bootstrapAuthorization === 'true') {
    throw new Error('PRODUCTION_ADOPTION_BLOCKED_BOOTSTRAP_REQUIRES_MISSING_DEPLOYMENT');
  }
  console.log('production rollback target accepted');
  process.exit(0);
}
if (bootstrapAuthorization === 'true' && (hasCurrentDeployment || hasCurrentFingerprint)) {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_BOOTSTRAP_REQUIRES_MISSING_DEPLOYMENT');
}
if (!hasCurrentDeployment && !hasCurrentFingerprint && bootstrapAuthorization !== 'true') {
  throw new Error('PRODUCTION_ADOPTION_BLOCKED_BOOTSTRAP_REQUIRES_AUTHORIZATION');
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
