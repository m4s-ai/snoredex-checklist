import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  runtimeTupleFromProvenance,
  validateRuntimeAssetSetDirectory,
  validateRuntimeAssetSetPointer,
} from './runtime-assets.mjs';

const root = resolve(process.cwd(), process.argv[2] ?? 'dist/site');
const pageUrl = process.env.SNOREDEX_PAGE_URL;
if (pageUrl !== 'https://m4s-ai.github.io/snoredex-checklist/') throw new Error('DEPLOYMENT_PAGE_URL_INVALID');

let provenance;
try {
  provenance = JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8'));
} catch {
  throw new Error('DEPLOYMENT_PROVENANCE_INVALID');
}

const catalogue = provenance?.catalogue;
const lock = catalogue?.lock;
if (
  provenance?.schema !== 'snoredex-site-provenance' ||
  provenance?.schemaVersion !== '1.0.0' ||
  !/^[0-9a-f]{40}$/u.test(provenance.appRevision ?? '') ||
  catalogue?.mode !== 'pinned-snapshot' ||
  !/^[0-9a-f]{40}$/u.test(catalogue.sourceCommit ?? '') ||
  catalogue.sourceCommit !== lock?.producerRevision ||
  catalogue.sourceRepository !== 'https://github.com/m4s-ai/snoredex-data' ||
  catalogue.contractVersion !== '1.0.0' ||
  !/^sha256:[0-9a-f]{64}$/u.test(catalogue.catalogueFingerprint ?? '') ||
  catalogue.catalogueFingerprint !== lock?.catalogueFingerprint ||
  catalogue.catalogueByteSha256 !== lock?.catalogueByteSha256 ||
  catalogue.catalogueByteLength !== lock?.catalogueByteLength ||
  catalogue.migrationByteSha256 !== lock?.migrationByteSha256 ||
  catalogue.migrationByteLength !== lock?.migrationByteLength
) {
  throw new Error('DEPLOYMENT_PROVENANCE_INVALID');
}

const isCommit = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
const isDigest = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
const isByteLength = (value) => Number.isSafeInteger(value) && value > 0;

const runtime = runtimeTupleFromProvenance(provenance);
let moduleManifest;
try {
  moduleManifest = JSON.parse(await readFile(join(root, 'assets/module-manifest.json'), 'utf8'));
} catch {
  throw new Error('DEPLOYMENT_RUNTIME_ASSETS_INVALID');
}
if (
  moduleManifest?.schema !== 'snoredex-site-module-manifest' ||
  moduleManifest?.schemaVersion !== '2.0.0' ||
  moduleManifest?.appRevision !== provenance.appRevision ||
  !validateRuntimeAssetSetPointer(moduleManifest.runtimeAssetSet, provenance.appRevision) ||
  !(await validateRuntimeAssetSetDirectory(join(root, 'assets'), moduleManifest.runtimeAssetSet, runtime)) ||
  !Array.isArray(moduleManifest.retainedRuntimeAssetSets) ||
  moduleManifest.retainedRuntimeAssetSets.length > 1
) {
  throw new Error('DEPLOYMENT_RUNTIME_ASSETS_INVALID');
}

function deploymentTuple(value, fallbackRuntime, embedded = false) {
  const migrationByteSha256 = value?.migrationByteSha256 ?? fallbackRuntime?.migrationByteSha256;
  const migrationByteLength = value?.migrationByteLength ?? fallbackRuntime?.migrationByteLength;
  if (
    (!embedded &&
      (value?.schema !== 'snoredex-checklist-deployment' ||
        value?.schemaVersion !== '1.0.0' ||
        value?.pageUrl !== pageUrl ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value?.publishedAt ?? ''))) ||
    !isCommit(value?.appRevision) ||
    !isCommit(value?.producerRevision) ||
    value?.contractVersion !== '1.0.0' ||
    !isDigest(value?.catalogueFingerprint) ||
    !isDigest(value?.catalogueByteSha256) ||
    !isByteLength(value?.catalogueByteLength) ||
    !isDigest(migrationByteSha256) ||
    !isByteLength(migrationByteLength)
  ) {
    throw new Error('DEPLOYMENT_PREVIOUS_INVALID');
  }
  return {
    appRevision: value.appRevision,
    producerRevision: value.producerRevision,
    contractVersion: value.contractVersion,
    catalogueFingerprint: value.catalogueFingerprint,
    catalogueByteSha256: value.catalogueByteSha256,
    catalogueByteLength: value.catalogueByteLength,
    migrationByteSha256,
    migrationByteLength,
  };
}

let previous;
const previousPath = process.env.SNOREDEX_CURRENT_DEPLOYMENT_PATH;
if (previousPath) {
  try {
    previous = JSON.parse(await readFile(previousPath, 'utf8'));
  } catch {
    throw new Error('DEPLOYMENT_PREVIOUS_INVALID');
  }
  deploymentTuple(previous, runtime);
  if (previous.sourceFingerprints !== undefined) {
    if (
      !Array.isArray(previous.sourceFingerprints) ||
      previous.sourceFingerprints.some((value) => !isDigest(value)) ||
      new Set(previous.sourceFingerprints).size !== previous.sourceFingerprints.length
    ) {
      throw new Error('DEPLOYMENT_PREVIOUS_INVALID');
    }
  }
}

const previousSources = previous ? (previous.sourceFingerprints ?? []) : [];
const sourceFingerprints = previous ? [...new Set([...previousSources, previous.catalogueFingerprint])] : [];

const manifest = {
  schema: 'snoredex-checklist-deployment',
  schemaVersion: '1.0.0',
  pageUrl,
  publishedAt: new Date().toISOString(),
  appRevision: provenance.appRevision,
  producerRevision: lock.producerRevision,
  contractVersion: lock.contractVersion,
  catalogueFingerprint: lock.catalogueFingerprint,
  catalogueByteSha256: lock.catalogueByteSha256,
  catalogueByteLength: lock.catalogueByteLength,
  migrationByteSha256: lock.migrationByteSha256,
  migrationByteLength: lock.migrationByteLength,
  runtimeAssetSet: moduleManifest.runtimeAssetSet,
  sourceFingerprints,
};
const rollbackSource = previous?.appRevision === provenance.appRevision ? previous.rollback : previous;
if (rollbackSource && lock.catalogueFingerprint === rollbackSource.catalogueFingerprint) {
  const rollback = deploymentTuple(rollbackSource, runtime, rollbackSource !== previous);
  const retained = moduleManifest.retainedRuntimeAssetSets.find(
    (pointer) => pointer?.appRevision === rollback.appRevision,
  );
  if (!validateRuntimeAssetSetPointer(retained, rollback.appRevision)) {
    throw new Error('DEPLOYMENT_ROLLBACK_RUNTIME_ASSETS_INVALID');
  }
  manifest.rollback = { ...rollback, runtimeAssetSet: retained };
}
await writeFile(join(root, 'deployment.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log('deployment manifest created');
