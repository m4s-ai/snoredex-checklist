import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { semanticFingerprint, validateCatalogue } from './validate.ts';

export const MAX_CATALOGUE_BYTES = 16 * 1024 * 1024;
export const MAX_MIGRATION_BYTES = 16 * 1024 * 1024;
export const PRODUCER_REPOSITORY = 'https://github.com/m4s-ai/snoredex-data';
const LOCK_SCHEMA = 'snoredex-checklist-catalogue-lock';
const LOCK_VERSION = '1.0.0';
const TRANSACTION_VERSION = 2;
const TRANSACTION_LOCK_SCHEMA = 'snoredex-checklist-transaction-lock';
const TRANSACTION_LOCK_MAX_AGE_MS = 60 * 60 * 1000;

export const SYNC_ERROR_CODES = [
  'SYNC_ARGUMENT_INVALID',
  'SYNC_ARTIFACT_TOO_LARGE',
  'SYNC_INVALID_ENCODING',
  'SYNC_INVALID_JSON',
  'SYNC_CATALOGUE_INVALID',
  'SYNC_MIGRATION_INVALID',
  'SYNC_FINGERPRINT_MISMATCH',
  'SYNC_BYTE_DIGEST_MISMATCH',
  'SYNC_PAIR_MISSING',
  'SYNC_PAIR_INVALID',
  'SYNC_TRANSACTION_BUSY',
  'SYNC_TRANSACTION_FAILED',
  'SYNC_TRANSACTION_UNCERTAIN',
] as const;

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

export interface CatalogueLock {
  readonly schema: typeof LOCK_SCHEMA;
  readonly schemaVersion: typeof LOCK_VERSION;
  readonly sourceRepository: typeof PRODUCER_REPOSITORY;
  readonly producerRevision: string;
  readonly artifactUrl: string;
  readonly contractVersion: string;
  readonly catalogueFingerprint: string;
  readonly catalogueByteSha256: string;
  readonly catalogueByteLength: number;
  readonly migrationArtifactUrl: string;
  readonly migrationByteSha256: string;
  readonly migrationByteLength: number;
  readonly issueUrls: readonly string[];
}

export interface CatalogueSyncRequest {
  readonly rootDirectory: string;
  readonly artifactUrl: string;
  readonly artifactCommit: string;
  readonly contractVersion: string;
  readonly expectedFingerprint: string;
  readonly expectedByteSha256: string;
  readonly migrationArtifactUrl: string;
  readonly migrationExpectedByteSha256: string;
  readonly migrationBytes: Uint8Array;
  readonly issueUrls: readonly string[];
  readonly bytes: Uint8Array;
  /** Test-only fault injection; the operator path uses the native rename. */
  readonly renameFile?: (source: string, destination: string) => Promise<void>;
}

export type SyncResult =
  { readonly ok: true; readonly lock: CatalogueLock } | { readonly ok: false; readonly code: SyncErrorCode };

export type CommittedPairResult =
  | { readonly ok: true; readonly lock: CatalogueLock; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: SyncErrorCode };

interface TransactionJournal {
  readonly version: typeof TRANSACTION_VERSION;
  readonly phase: 'prepared' | 'committed';
  readonly rootDirectory: string;
  readonly vendorPath: string;
  readonly migrationPath: string;
  readonly lockPath: string;
  readonly stageDirectory: string;
  readonly stageVendorPath: string;
  readonly stageMigrationPath: string;
  readonly stageLockPath: string;
  readonly backupVendorPath: string;
  readonly backupMigrationPath: string;
  readonly backupLockPath: string;
  readonly hadVendor: boolean;
  readonly hadMigration: boolean;
  readonly hadLock: boolean;
}

interface TransactionLock {
  readonly release: () => Promise<void>;
}

interface TransactionLockOwner {
  readonly schema: typeof TRANSACTION_LOCK_SCHEMA;
  readonly pid: number;
  readonly startedAt: number;
  readonly token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function isProducerArtifactUrl(value: unknown, expectedCommit: unknown, filename: string): value is string {
  if (!isHttpsUrl(value)) {
    return false;
  }
  if (!isCommit(expectedCommit)) {
    return false;
  }
  const url = new URL(value);
  return (
    url.origin === 'https://raw.githubusercontent.com' &&
    url.search === '' &&
    url.hash === '' &&
    url.pathname === `/m4s-ai/snoredex-data/${expectedCommit}/${filename}`
  );
}

function isArtifactUrl(value: unknown, expectedCommit: unknown): value is string {
  return isProducerArtifactUrl(value, expectedCommit, 'collector_catalogue.json');
}

function isMigrationArtifactUrl(value: unknown, expectedCommit: unknown): value is string {
  return isProducerArtifactUrl(value, expectedCommit, 'collector_migrations.json');
}

function isIssueUrl(value: unknown): value is string {
  if (!isHttpsUrl(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    url.origin === 'https://github.com' &&
    /^\/m4s-ai\/snoredex-(?:data|checklist)\/issues\/\d+$/.test(url.pathname) &&
    url.search === '' &&
    url.hash === ''
  );
}

function hasReciprocalIssueUrls(issueUrls: readonly string[]): boolean {
  return (
    issueUrls.some((url) => url.startsWith('https://github.com/m4s-ai/snoredex-checklist/issues/')) &&
    issueUrls.some((url) => url.startsWith('https://github.com/m4s-ai/snoredex-data/issues/'))
  );
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function cataloguePath(rootDirectory: string): string {
  return resolve(rootDirectory, 'vendor', 'snoredex-data', 'collector_catalogue.json');
}

function migrationPath(rootDirectory: string): string {
  return resolve(rootDirectory, 'vendor', 'snoredex-data', 'collector_migrations.json');
}

function lockPath(rootDirectory: string): string {
  return resolve(rootDirectory, 'catalogue.lock.json');
}

function transactionLockPath(rootDirectory: string): string {
  return join(transactionDirectory(rootDirectory), 'transaction.lock');
}

function transactionDirectory(rootDirectory: string): string {
  return resolve(rootDirectory, '.catalogue-sync');
}

function journalPath(rootDirectory: string): string {
  return join(transactionDirectory(rootDirectory), 'journal.json');
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return isRecord(error) && error.code === code;
}

async function pathHasSymlink(rootDirectory: string, targetPath: string): Promise<boolean> {
  const root = resolve(rootDirectory);
  const target = resolve(targetPath);
  const targetRelative = relative(root, target);
  if (targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
    return true;
  }
  const components = targetRelative === '' ? [] : targetRelative.split(sep);
  let current = root;
  for (const component of ['', ...components]) {
    if (component !== '') {
      current = join(current, component);
    }
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return false;
      }
      throw error;
    }
  }
  return false;
}

async function assertSafePaths(rootDirectory: string, paths: readonly string[]): Promise<void> {
  for (const path of [rootDirectory, ...paths]) {
    if (await pathHasSymlink(rootDirectory, path)) {
      throw new Error('unsafe path');
    }
  }
}

function parseTransactionLock(value: unknown): TransactionLockOwner | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.schema !== TRANSACTION_LOCK_SCHEMA ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.startedAt !== 'number' ||
    !Number.isFinite(value.startedAt) ||
    value.startedAt <= 0 ||
    typeof value.token !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(value.token)
  ) {
    return undefined;
  }
  return value as unknown as TransactionLockOwner;
}

async function readTransactionLockOwner(path: string): Promise<TransactionLockOwner | undefined> {
  try {
    return parseTransactionLock(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

async function reclaimStaleTransactionLock(rootDirectory: string, path: string): Promise<boolean> {
  const owner = await readTransactionLockOwner(path);
  if (!owner) {
    return false;
  }
  const age = Date.now() - owner.startedAt;
  if (processIsAlive(owner.pid) && age < TRANSACTION_LOCK_MAX_AGE_MS) {
    return false;
  }
  const quarantinePath = `${path}.stale-${randomUUID()}`;
  try {
    await assertSafePaths(rootDirectory, [path, quarantinePath]);
    await rename(path, quarantinePath);
  } catch {
    return false;
  }
  await rm(quarantinePath, { force: true }).catch(() => undefined);
  return true;
}

async function acquireTransactionLock(
  rootDirectory: string,
): Promise<
  | { readonly ok: true; readonly lock: TransactionLock }
  | { readonly ok: false; readonly code: 'SYNC_TRANSACTION_BUSY' | 'SYNC_TRANSACTION_UNCERTAIN' }
> {
  const directory = transactionDirectory(rootDirectory);
  const lockPathname = transactionLockPath(rootDirectory);
  try {
    await assertSafePaths(rootDirectory, [directory, lockPathname]);
    await mkdir(directory, { recursive: true });
    await assertSafePaths(rootDirectory, [directory, lockPathname]);
  } catch {
    return { ok: false, code: 'SYNC_TRANSACTION_UNCERTAIN' };
  }
  let handle: Awaited<ReturnType<typeof open>>;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPathname, 'wx');
      break;
    } catch (error) {
      if (isNodeError(error, 'EEXIST') && (await reclaimStaleTransactionLock(rootDirectory, lockPathname))) {
        continue;
      }
      if (isNodeError(error, 'EEXIST')) {
        return { ok: false, code: 'SYNC_TRANSACTION_BUSY' };
      }
      return { ok: false, code: 'SYNC_TRANSACTION_UNCERTAIN' };
    }
  }
  if (!handle!) {
    return { ok: false, code: 'SYNC_TRANSACTION_BUSY' };
  }
  const owner: TransactionLockOwner = {
    schema: TRANSACTION_LOCK_SCHEMA,
    pid: process.pid,
    startedAt: Date.now(),
    token: randomUUID(),
  };
  try {
    await writeFile(lockPathname, `${JSON.stringify(owner)}\n`, 'utf8');
  } catch {
    await handle.close().catch(() => undefined);
    await rm(lockPathname, { force: true }).catch(() => undefined);
    return { ok: false, code: 'SYNC_TRANSACTION_UNCERTAIN' };
  }
  let released = false;
  return {
    ok: true,
    lock: {
      release: async () => {
        if (released) return;
        released = true;
        await handle.close();
        const currentOwner = await readTransactionLockOwner(lockPathname);
        if (currentOwner?.token === owner.token) {
          await rm(lockPathname, { force: true });
        }
      },
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeJson(temporaryPath, value);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function lockIsValid(value: unknown): value is CatalogueLock {
  if (!isRecord(value)) {
    return false;
  }
  const byteLength = value.catalogueByteLength;
  const migrationByteLength = value.migrationByteLength;
  return (
    value.schema === LOCK_SCHEMA &&
    value.schemaVersion === LOCK_VERSION &&
    value.sourceRepository === PRODUCER_REPOSITORY &&
    isCommit(value.producerRevision) &&
    isArtifactUrl(value.artifactUrl, value.producerRevision) &&
    typeof value.contractVersion === 'string' &&
    isSha256(value.catalogueFingerprint) &&
    isSha256(value.catalogueByteSha256) &&
    typeof byteLength === 'number' &&
    Number.isSafeInteger(byteLength) &&
    byteLength > 0 &&
    isMigrationArtifactUrl(value.migrationArtifactUrl, value.producerRevision) &&
    isSha256(value.migrationByteSha256) &&
    typeof migrationByteLength === 'number' &&
    Number.isSafeInteger(migrationByteLength) &&
    migrationByteLength > 0 &&
    Array.isArray(value.issueUrls) &&
    value.issueUrls.length > 0 &&
    value.issueUrls.every(isIssueUrl) &&
    hasReciprocalIssueUrls(value.issueUrls)
  );
}

function makeLock(request: CatalogueSyncRequest, byteLength: number): CatalogueLock {
  return {
    schema: LOCK_SCHEMA,
    schemaVersion: LOCK_VERSION,
    sourceRepository: PRODUCER_REPOSITORY,
    producerRevision: request.artifactCommit,
    artifactUrl: request.artifactUrl,
    contractVersion: request.contractVersion,
    catalogueFingerprint: request.expectedFingerprint,
    catalogueByteSha256: request.expectedByteSha256,
    catalogueByteLength: byteLength,
    migrationArtifactUrl: request.migrationArtifactUrl,
    migrationByteSha256: request.migrationExpectedByteSha256,
    migrationByteLength: request.migrationBytes.byteLength,
    issueUrls: [...request.issueUrls].sort(),
  };
}

function parseCatalogueBytes(
  bytes: Uint8Array,
  expectedFingerprint: string,
  expectedByteSha256: string,
  contractVersion: string,
): SyncResult | { readonly ok: true; readonly catalogue: Record<string, unknown> } {
  if (bytes.byteLength > MAX_CATALOGUE_BYTES) {
    return { ok: false, code: 'SYNC_ARTIFACT_TOO_LARGE' };
  }
  if (sha256(bytes) !== expectedByteSha256) {
    return { ok: false, code: 'SYNC_BYTE_DIGEST_MISMATCH' };
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: 'SYNC_INVALID_ENCODING' };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'SYNC_INVALID_JSON' };
  }
  const validation = validateCatalogue(value);
  if (!validation.ok) {
    return { ok: false, code: 'SYNC_CATALOGUE_INVALID' };
  }
  if (!isRecord(value) || !isRecord(value.meta) || value.meta.sourceRepository !== PRODUCER_REPOSITORY) {
    return { ok: false, code: 'SYNC_CATALOGUE_INVALID' };
  }
  if (
    validation.catalogue.meta.schemaVersion !== contractVersion ||
    validation.catalogue.meta.catalogueFingerprint !== expectedFingerprint ||
    semanticFingerprint(value) !== expectedFingerprint
  ) {
    return { ok: false, code: 'SYNC_FINGERPRINT_MISMATCH' };
  }
  return { ok: true, catalogue: value as Record<string, unknown> };
}

function parseMigrationBytes(
  bytes: Uint8Array,
  expectedFingerprint: string,
  expectedByteSha256: string,
): SyncResult | { readonly ok: true } {
  if (bytes.byteLength > MAX_MIGRATION_BYTES) {
    return { ok: false, code: 'SYNC_ARTIFACT_TOO_LARGE' };
  }
  if (sha256(bytes) !== expectedByteSha256) {
    return { ok: false, code: 'SYNC_BYTE_DIGEST_MISMATCH' };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: 'SYNC_INVALID_ENCODING' };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value) ||
      !isRecord(value.meta) ||
      value.meta.schema !== 'snoredex-collector-migrations' ||
      value.meta.schemaVersion !== '1.1.0' ||
      value.meta.toFingerprint !== expectedFingerprint ||
      !Array.isArray(value.catalogueTransitions) ||
      value.catalogueTransitions.length === 0
    ) {
      return { ok: false, code: 'SYNC_MIGRATION_INVALID' };
    }
  } catch {
    return { ok: false, code: 'SYNC_MIGRATION_INVALID' };
  }
  return { ok: true };
}

function isChildPath(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative !== '' && !childRelative.startsWith('..') && !isAbsolute(childRelative);
}

function parseJournal(value: unknown, expectedRootDirectory: string): TransactionJournal | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.version !== TRANSACTION_VERSION ||
    (value.phase !== 'prepared' && value.phase !== 'committed') ||
    typeof value.rootDirectory !== 'string' ||
    typeof value.vendorPath !== 'string' ||
    typeof value.migrationPath !== 'string' ||
    typeof value.lockPath !== 'string' ||
    typeof value.stageDirectory !== 'string' ||
    typeof value.stageVendorPath !== 'string' ||
    typeof value.stageMigrationPath !== 'string' ||
    typeof value.stageLockPath !== 'string' ||
    typeof value.backupVendorPath !== 'string' ||
    typeof value.backupMigrationPath !== 'string' ||
    typeof value.backupLockPath !== 'string' ||
    typeof value.hadVendor !== 'boolean' ||
    typeof value.hadMigration !== 'boolean' ||
    typeof value.hadLock !== 'boolean'
  ) {
    return undefined;
  }
  const rootDirectory = resolve(expectedRootDirectory);
  const expectedVendorPath = cataloguePath(rootDirectory);
  const expectedMigrationPath = migrationPath(rootDirectory);
  const expectedLockPath = lockPath(rootDirectory);
  const stageDirectory = resolve(value.stageDirectory);
  const transactionRoot = transactionDirectory(rootDirectory);
  if (
    value.rootDirectory !== rootDirectory ||
    value.vendorPath !== expectedVendorPath ||
    value.migrationPath !== expectedMigrationPath ||
    value.lockPath !== expectedLockPath ||
    !isChildPath(transactionRoot, stageDirectory) ||
    value.stageDirectory !== stageDirectory ||
    value.stageVendorPath !== join(stageDirectory, 'collector_catalogue.json') ||
    value.stageMigrationPath !== join(stageDirectory, 'collector_migrations.json') ||
    value.stageLockPath !== join(stageDirectory, 'catalogue.lock.json') ||
    dirname(value.backupVendorPath) !== dirname(expectedVendorPath) ||
    dirname(value.backupMigrationPath) !== dirname(expectedMigrationPath) ||
    dirname(value.backupLockPath) !== dirname(expectedLockPath) ||
    !basename(value.backupVendorPath).startsWith(`${basename(expectedVendorPath)}.backup-`) ||
    !basename(value.backupMigrationPath).startsWith(`${basename(expectedMigrationPath)}.backup-`) ||
    !basename(value.backupLockPath).startsWith(`${basename(expectedLockPath)}.backup-`)
  ) {
    return undefined;
  }
  return value as unknown as TransactionJournal;
}

type JournalReadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'valid'; readonly journal: TransactionJournal }
  | { readonly kind: 'invalid' };

async function readJournal(rootDirectory: string): Promise<JournalReadResult> {
  try {
    const raw = await readFile(journalPath(rootDirectory), 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { kind: 'invalid' };
    }
    const journal = parseJournal(value, resolve(rootDirectory));
    return journal ? { kind: 'valid', journal } : { kind: 'invalid' };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      return { kind: 'missing' };
    }
    return { kind: 'invalid' };
  }
}

async function rollback(journal: TransactionJournal): Promise<void> {
  await assertSafePaths(journal.rootDirectory, [
    journal.vendorPath,
    journal.migrationPath,
    journal.lockPath,
    journal.stageDirectory,
    journal.stageVendorPath,
    journal.stageMigrationPath,
    journal.stageLockPath,
    journal.backupVendorPath,
    journal.backupMigrationPath,
    journal.backupLockPath,
  ]);
  if (journal.phase === 'committed') {
    await cleanupCommitted(journal);
    return;
  }

  if (journal.hadVendor && (await exists(journal.backupVendorPath))) {
    await rm(journal.vendorPath, { force: true });
    await rename(journal.backupVendorPath, journal.vendorPath);
  } else if (!journal.hadVendor) {
    await rm(journal.vendorPath, { force: true });
  }
  if (journal.hadMigration && (await exists(journal.backupMigrationPath))) {
    await rm(journal.migrationPath, { force: true });
    await rename(journal.backupMigrationPath, journal.migrationPath);
  } else if (!journal.hadMigration) {
    await rm(journal.migrationPath, { force: true });
  }
  if (journal.hadLock && (await exists(journal.backupLockPath))) {
    await rm(journal.lockPath, { force: true });
    await rename(journal.backupLockPath, journal.lockPath);
  } else if (!journal.hadLock) {
    await rm(journal.lockPath, { force: true });
  }
  await rm(journal.stageDirectory, { recursive: true, force: true });
  await rm(journal.backupVendorPath, { force: true });
  await rm(journal.backupMigrationPath, { force: true });
  await rm(journal.backupLockPath, { force: true });
  await rm(journalPath(journal.rootDirectory), { force: true });
}

async function cleanupCommitted(journal: TransactionJournal): Promise<void> {
  await assertSafePaths(journal.rootDirectory, [
    journal.vendorPath,
    journal.migrationPath,
    journal.lockPath,
    journal.stageDirectory,
    journal.stageVendorPath,
    journal.stageMigrationPath,
    journal.stageLockPath,
    journal.backupVendorPath,
    journal.backupMigrationPath,
    journal.backupLockPath,
  ]);
  await rm(journal.stageDirectory, { recursive: true, force: true });
  await rm(journal.backupVendorPath, { force: true });
  await rm(journal.backupMigrationPath, { force: true });
  await rm(journal.backupLockPath, { force: true });
  await rm(journalPath(journal.rootDirectory), { force: true });
}

type RecoveryResult =
  { readonly ok: true } | { readonly ok: false; readonly code: 'SYNC_TRANSACTION_BUSY' | 'SYNC_TRANSACTION_UNCERTAIN' };

async function recoverCatalogueSyncUnsafe(rootDirectory: string): Promise<RecoveryResult> {
  await assertSafePaths(rootDirectory, [transactionDirectory(rootDirectory), journalPath(rootDirectory)]);
  const journalResult = await readJournal(rootDirectory);
  if (journalResult.kind === 'missing') {
    return { ok: true };
  }
  if (journalResult.kind === 'invalid') {
    return { ok: false, code: 'SYNC_TRANSACTION_UNCERTAIN' };
  }
  try {
    await rollback(journalResult.journal);
    return { ok: true };
  } catch {
    return { ok: false, code: 'SYNC_TRANSACTION_UNCERTAIN' };
  }
}

export async function recoverCatalogueSync(rootDirectory: string): Promise<RecoveryResult> {
  const acquired = await acquireTransactionLock(resolve(rootDirectory));
  if (!acquired.ok) {
    return acquired;
  }
  try {
    return await recoverCatalogueSyncUnsafe(resolve(rootDirectory));
  } catch {
    return { ok: false, code: 'SYNC_TRANSACTION_UNCERTAIN' };
  } finally {
    await acquired.lock.release().catch(() => undefined);
  }
}

async function readCommittedCataloguePairUnsafe(rootDirectory: string): Promise<CommittedPairResult> {
  const recovery = await recoverCatalogueSyncUnsafe(rootDirectory);
  if (!recovery.ok) {
    return recovery;
  }
  const vendor = cataloguePath(rootDirectory);
  const migration = migrationPath(rootDirectory);
  const lock = lockPath(rootDirectory);
  try {
    await assertSafePaths(rootDirectory, [vendor, migration, lock]);
  } catch {
    return { ok: false, code: 'SYNC_PAIR_INVALID' };
  }
  const [hasVendor, hasMigration, hasLock] = await Promise.all([exists(vendor), exists(migration), exists(lock)]);
  if (!hasVendor && !hasMigration && !hasLock) {
    return { ok: false, code: 'SYNC_PAIR_MISSING' };
  }
  if (!hasVendor || !hasMigration || !hasLock) {
    return { ok: false, code: 'SYNC_PAIR_INVALID' };
  }

  try {
    const bytes = await readFile(vendor);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const migrationBytes = await readFile(migration);
    const rawLock: unknown = JSON.parse(await readFile(lock, 'utf8'));
    if (!lockIsValid(rawLock)) {
      return { ok: false, code: 'SYNC_PAIR_INVALID' };
    }
    const validation = validateCatalogue(value);
    const sourceIsProducer =
      isRecord(value) && isRecord(value.meta) && value.meta.sourceRepository === PRODUCER_REPOSITORY;
    if (
      !validation.ok ||
      !sourceIsProducer ||
      bytes.byteLength > MAX_CATALOGUE_BYTES ||
      validation.catalogue.meta.schemaVersion !== rawLock.contractVersion ||
      validation.catalogue.meta.catalogueFingerprint !== rawLock.catalogueFingerprint ||
      semanticFingerprint(value) !== rawLock.catalogueFingerprint ||
      sha256(bytes) !== rawLock.catalogueByteSha256 ||
      bytes.byteLength !== rawLock.catalogueByteLength ||
      sha256(migrationBytes) !== rawLock.migrationByteSha256 ||
      migrationBytes.byteLength !== rawLock.migrationByteLength ||
      !isMigrationArtifactUrl(rawLock.migrationArtifactUrl, rawLock.producerRevision)
    ) {
      return { ok: false, code: 'SYNC_PAIR_INVALID' };
    }
    const migrationValidation = parseMigrationBytes(
      migrationBytes,
      rawLock.catalogueFingerprint,
      rawLock.migrationByteSha256,
    );
    if (!migrationValidation.ok) return { ok: false, code: 'SYNC_PAIR_INVALID' };
    return { ok: true, lock: rawLock, bytes };
  } catch {
    return { ok: false, code: 'SYNC_PAIR_INVALID' };
  }
}

export async function readCommittedCataloguePair(rootDirectory: string): Promise<CommittedPairResult> {
  const acquired = await acquireTransactionLock(resolve(rootDirectory));
  if (!acquired.ok) {
    return acquired;
  }
  try {
    return await readCommittedCataloguePairUnsafe(resolve(rootDirectory));
  } catch {
    return { ok: false, code: 'SYNC_PAIR_INVALID' };
  } finally {
    await acquired.lock.release().catch(() => undefined);
  }
}

export async function syncCataloguePair(request: CatalogueSyncRequest): Promise<SyncResult> {
  const rootDirectory = resolve(request.rootDirectory);
  if (
    !isArtifactUrl(request.artifactUrl, request.artifactCommit) ||
    !isCommit(request.artifactCommit) ||
    typeof request.contractVersion !== 'string' ||
    !isSha256(request.expectedFingerprint) ||
    !isSha256(request.expectedByteSha256) ||
    !isMigrationArtifactUrl(request.migrationArtifactUrl, request.artifactCommit) ||
    !isSha256(request.migrationExpectedByteSha256) ||
    request.expectedFingerprint.length !== 71 ||
    request.expectedByteSha256.length !== 71 ||
    !Array.isArray(request.issueUrls) ||
    request.issueUrls.length === 0 ||
    !request.issueUrls.every(isIssueUrl) ||
    !hasReciprocalIssueUrls(request.issueUrls) ||
    !(request.bytes instanceof Uint8Array) ||
    !(request.migrationBytes instanceof Uint8Array)
  ) {
    return { ok: false, code: 'SYNC_ARGUMENT_INVALID' };
  }

  const acquired = await acquireTransactionLock(rootDirectory);
  if (!acquired.ok) {
    return acquired;
  }

  try {
    const recovery = await recoverCatalogueSyncUnsafe(rootDirectory);
    if (!recovery.ok) {
      return recovery;
    }
    const existing = await readCommittedCataloguePairUnsafe(rootDirectory);
    if (!existing.ok && existing.code !== 'SYNC_PAIR_MISSING') {
      return existing;
    }

    const parsed = parseCatalogueBytes(
      request.bytes,
      request.expectedFingerprint,
      request.expectedByteSha256,
      request.contractVersion,
    );
    if (!parsed.ok) {
      return parsed;
    }
    const parsedMigration = parseMigrationBytes(
      request.migrationBytes,
      request.expectedFingerprint,
      request.migrationExpectedByteSha256,
    );
    if (!parsedMigration.ok) {
      return parsedMigration;
    }

    const vendor = cataloguePath(rootDirectory);
    const migration = migrationPath(rootDirectory);
    const lock = lockPath(rootDirectory);
    const txId = randomUUID();
    const stageDirectory = join(transactionDirectory(rootDirectory), txId);
    const stageVendorPath = join(stageDirectory, 'collector_catalogue.json');
    const stageMigrationPath = join(stageDirectory, 'collector_migrations.json');
    const stageLockPath = join(stageDirectory, 'catalogue.lock.json');
    const journal: TransactionJournal = {
      version: TRANSACTION_VERSION,
      phase: 'prepared',
      rootDirectory,
      vendorPath: vendor,
      migrationPath: migration,
      lockPath: lock,
      stageDirectory,
      stageVendorPath,
      stageMigrationPath,
      stageLockPath,
      backupVendorPath: `${vendor}.backup-${txId}`,
      backupMigrationPath: `${migration}.backup-${txId}`,
      backupLockPath: `${lock}.backup-${txId}`,
      hadVendor: await exists(vendor),
      hadMigration: await exists(migration),
      hadLock: await exists(lock),
    };
    const catalogueLock = makeLock(request, request.bytes.byteLength);
    const move = request.renameFile ?? rename;

    try {
      await mkdir(dirname(vendor), { recursive: true });
      await mkdir(stageDirectory, { recursive: true });
      await assertSafePaths(rootDirectory, [
        vendor,
        migration,
        lock,
        transactionDirectory(rootDirectory),
        journalPath(rootDirectory),
        stageDirectory,
        stageVendorPath,
        stageMigrationPath,
        stageLockPath,
        journal.backupVendorPath,
        journal.backupMigrationPath,
        journal.backupLockPath,
      ]);
      await writeFile(stageVendorPath, request.bytes);
      await writeFile(stageMigrationPath, request.migrationBytes);
      await writeJson(stageLockPath, catalogueLock);
      await writeJsonAtomically(journalPath(rootDirectory), journal);

      if (journal.hadVendor) {
        await move(vendor, journal.backupVendorPath);
      }
      if (journal.hadMigration) {
        await move(migration, journal.backupMigrationPath);
      }
      if (journal.hadLock) {
        await move(lock, journal.backupLockPath);
      }
      await move(stageVendorPath, vendor);
      await move(stageMigrationPath, migration);
      await move(stageLockPath, lock);
      await writeJsonAtomically(journalPath(rootDirectory), { ...journal, phase: 'committed' });
      await cleanupCommitted({ ...journal, phase: 'committed' }).catch(() => undefined);
      return { ok: true, lock: catalogueLock };
    } catch {
      try {
        await rollback(journal);
      } catch {
        return { ok: false, code: 'SYNC_TRANSACTION_UNCERTAIN' };
      }
      return { ok: false, code: 'SYNC_TRANSACTION_FAILED' };
    }
  } catch {
    return { ok: false, code: 'SYNC_TRANSACTION_UNCERTAIN' };
  } finally {
    await acquired.lock.release().catch(() => undefined);
  }
}
