import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { semanticFingerprint, validateCatalogue, validateCatalogueFixture } from '../src/catalogue/validate.ts';

const RELEASE_SCHEMA = 'snoredex-checklist-catalogue-release';
const RELEASE_VERSION = '1.0.0';
const PRODUCER_REPOSITORY = 'https://github.com/m4s-ai/snoredex-data';
const MAX_BYTES = 16 * 1024 * 1024;
const FILES = Object.freeze([
  'collector_catalogue.json',
  'collector_catalogue.schema.json',
  'collector_migrations.json',
  'collector_catalogue.fixture.json',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDigest(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeJson(bytes, code) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    throw new Error(code);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(code);
  }
}

function asset(bytes) {
  return { sha256: digest(bytes), byteLength: bytes.byteLength };
}

function validRelease(value) {
  return (
    isRecord(value) &&
    value.schema === RELEASE_SCHEMA &&
    value.schemaVersion === RELEASE_VERSION &&
    isCommit(value.producerRevision) &&
    isDigest(value.catalogueFingerprint) &&
    isRecord(value.assets) &&
    FILES.every((filename) => {
      const entry = value.assets[filename];
      return (
        isRecord(entry) && isDigest(entry.sha256) && Number.isSafeInteger(entry.byteLength) && entry.byteLength > 0
      );
    })
  );
}

function sameAssets(left, right) {
  return FILES.every(
    (filename) =>
      left[filename].sha256 === right[filename].sha256 && left[filename].byteLength === right[filename].byteLength,
  );
}

function isIssueUrl(value) {
  return (
    typeof value === 'string' &&
    /^https:\/\/github\.com\/m4s-ai\/snoredex-(?:checklist|data)\/issues\/\d+$/u.test(value)
  );
}

export function createCatalogueReleaseManifest({
  producerRevision,
  candidateBytes,
  currentLock,
  previousRelease,
  issueUrls,
  compatibilityStatus = 'unchecked',
  compatibilityCode = 'CATALOGUE_UPDATE_NOT_CHECKED',
}) {
  if (!isCommit(producerRevision) || !isRecord(candidateBytes) || !isRecord(currentLock)) {
    throw new Error('CATALOGUE_RELEASE_INPUT_INVALID');
  }
  if (
    !Array.isArray(issueUrls) ||
    issueUrls.length < 2 ||
    !issueUrls.every(isIssueUrl) ||
    !issueUrls.some((url) => url.includes('/snoredex-checklist/')) ||
    !issueUrls.some((url) => url.includes('/snoredex-data/'))
  ) {
    throw new Error('CATALOGUE_RELEASE_ISSUES_INVALID');
  }
  if (!['unchecked', 'ready', 'blocked'].includes(compatibilityStatus)) {
    throw new Error('CATALOGUE_RELEASE_COMPATIBILITY_INVALID');
  }
  if (typeof compatibilityCode !== 'string' || !/^CATALOGUE_[A-Z_]+$/u.test(compatibilityCode)) {
    throw new Error('CATALOGUE_RELEASE_COMPATIBILITY_INVALID');
  }

  const catalogueBytes = candidateBytes['collector_catalogue.json'];
  const schemaBytes = candidateBytes['collector_catalogue.schema.json'];
  const migrationBytes = candidateBytes['collector_migrations.json'];
  const fixtureBytes = candidateBytes['collector_catalogue.fixture.json'];
  const catalogue = decodeJson(catalogueBytes, 'CATALOGUE_RELEASE_CATALOGUE_INVALID');
  const schema = decodeJson(schemaBytes, 'CATALOGUE_RELEASE_SCHEMA_INVALID');
  const migrations = decodeJson(migrationBytes, 'CATALOGUE_RELEASE_MIGRATIONS_INVALID');
  const fixture = decodeJson(fixtureBytes, 'CATALOGUE_RELEASE_FIXTURE_INVALID');
  const validation = validateCatalogue(catalogue);
  const fixtureValidation = validateCatalogueFixture(fixture);
  if (
    !fixtureValidation.ok ||
    catalogue?.meta?.schema !== 'snoredex-collector-catalogue' ||
    catalogue?.meta?.schemaVersion !== '1.0.0' ||
    catalogue?.meta?.sourceRepository !== PRODUCER_REPOSITORY ||
    !Array.isArray(catalogue?.items) ||
    catalogue.meta.catalogueFingerprint !== semanticFingerprint(catalogue)
  ) {
    throw new Error('CATALOGUE_RELEASE_CATALOGUE_INVALID');
  }
  if (compatibilityStatus === 'ready' && !validation.ok) {
    throw new Error('CATALOGUE_RELEASE_COMPATIBILITY_INVALID');
  }
  if (
    schema?.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
    schema?.$id !== 'https://m4s-ai.github.io/snoredex-data/collector_catalogue.schema.json' ||
    schema?.type !== 'object'
  ) {
    throw new Error('CATALOGUE_RELEASE_SCHEMA_INVALID');
  }
  if (
    migrations?.meta?.schema !== 'snoredex-collector-migrations' ||
    migrations.meta.schemaVersion !== '1.1.0' ||
    migrations.meta.toFingerprint !== catalogue.meta.catalogueFingerprint ||
    !Array.isArray(migrations.catalogueTransitions) ||
    migrations.catalogueTransitions.length === 0
  ) {
    throw new Error('CATALOGUE_RELEASE_MIGRATIONS_INVALID');
  }
  if (
    currentLock.sourceRepository !== PRODUCER_REPOSITORY ||
    !isCommit(currentLock.producerRevision) ||
    currentLock.contractVersion !== catalogue.meta.schemaVersion ||
    !isDigest(currentLock.catalogueFingerprint) ||
    !isDigest(currentLock.catalogueByteSha256) ||
    !isDigest(currentLock.migrationByteSha256)
  ) {
    throw new Error('CATALOGUE_RELEASE_LOCK_INVALID');
  }
  if (previousRelease !== undefined && !validRelease(previousRelease)) {
    throw new Error('CATALOGUE_RELEASE_PREVIOUS_INVALID');
  }

  const assets = Object.fromEntries(
    FILES.map((filename) => {
      const bytes = candidateBytes[filename];
      if (!(bytes instanceof Uint8Array)) throw new Error('CATALOGUE_RELEASE_INPUT_INVALID');
      return [filename, asset(bytes)];
    }),
  );
  const changed = previousRelease === undefined || !sameAssets(assets, previousRelease.assets);
  const adoptionNeeded =
    catalogue.meta.catalogueFingerprint !== currentLock.catalogueFingerprint ||
    assets['collector_catalogue.json'].sha256 !== currentLock.catalogueByteSha256 ||
    assets['collector_migrations.json'].sha256 !== currentLock.migrationByteSha256;

  return {
    schema: RELEASE_SCHEMA,
    schemaVersion: RELEASE_VERSION,
    sourceRepository: PRODUCER_REPOSITORY,
    producerRevision,
    contractVersion: catalogue.meta.schemaVersion,
    catalogueFingerprint: catalogue.meta.catalogueFingerprint,
    consumerValidation: {
      status: validation.ok ? 'accepted' : 'blocked',
      codes: validation.ok ? [] : [...new Set(validation.errors)].sort(),
    },
    assets,
    comparedTo: previousRelease
      ? {
          producerRevision: previousRelease.producerRevision,
          catalogueFingerprint: previousRelease.catalogueFingerprint,
        }
      : {
          producerRevision: currentLock.producerRevision,
          catalogueFingerprint: currentLock.catalogueFingerprint,
        },
    changeStatus: changed ? 'changed' : 'unchanged',
    adoptionStatus: adoptionNeeded ? 'needed' : 'current',
    compatibility: {
      status: compatibilityStatus,
      code: compatibilityCode,
    },
    issueUrls: [...new Set(issueUrls)].sort(),
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function argumentsAfter(name) {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]] : [],
  );
}

function required(name) {
  const value = argument(name);
  if (!value) throw new Error('CATALOGUE_RELEASE_INPUT_INVALID');
  return value;
}

async function main() {
  const candidateDirectory = resolve(required('--candidate-dir'));
  const currentLock = decodeJson(
    await readFile(resolve(argument('--current-lock') ?? 'catalogue.lock.json')),
    'CATALOGUE_RELEASE_LOCK_INVALID',
  );
  const previousPath = argument('--previous-release');
  const previousRelease = previousPath
    ? decodeJson(await readFile(resolve(previousPath)), 'CATALOGUE_RELEASE_PREVIOUS_INVALID')
    : undefined;
  const candidateBytes = Object.fromEntries(
    await Promise.all(FILES.map(async (filename) => [filename, await readFile(resolve(candidateDirectory, filename))])),
  );
  const manifest = createCatalogueReleaseManifest({
    producerRevision: required('--producer-revision'),
    candidateBytes,
    currentLock,
    previousRelease,
    issueUrls: argumentsAfter('--issue-url'),
    compatibilityStatus: argument('--compatibility-status') ?? 'unchecked',
    compatibilityCode: argument('--compatibility-code') ?? 'CATALOGUE_UPDATE_NOT_CHECKED',
  });
  await mkdir(candidateDirectory, { recursive: true });
  await writeFile(
    resolve(candidateDirectory, 'catalogue-release.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    await main();
  } catch (error) {
    const code =
      error instanceof Error && /^CATALOGUE_[A-Z_]+$/u.test(error.message) ? error.message : 'CATALOGUE_RELEASE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
