import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { semanticFingerprint, validateCatalogue } from "./validate.ts";

export const MAX_CATALOGUE_BYTES = 16 * 1024 * 1024;
export const PRODUCER_REPOSITORY = "https://github.com/m4s-ai/snoredex-data";
const LOCK_SCHEMA = "snoredex-checklist-catalogue-lock";
const LOCK_VERSION = "1.0.0";
const TRANSACTION_VERSION = 1;

export const SYNC_ERROR_CODES = [
  "SYNC_ARGUMENT_INVALID",
  "SYNC_ARTIFACT_TOO_LARGE",
  "SYNC_INVALID_ENCODING",
  "SYNC_INVALID_JSON",
  "SYNC_CATALOGUE_INVALID",
  "SYNC_FINGERPRINT_MISMATCH",
  "SYNC_BYTE_DIGEST_MISMATCH",
  "SYNC_PAIR_MISSING",
  "SYNC_PAIR_INVALID",
  "SYNC_TRANSACTION_FAILED",
  "SYNC_TRANSACTION_UNCERTAIN",
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
  readonly issueUrls: readonly string[];
}

export interface CatalogueSyncRequest {
  readonly rootDirectory: string;
  readonly artifactUrl: string;
  readonly artifactCommit: string;
  readonly contractVersion: string;
  readonly expectedFingerprint: string;
  readonly expectedByteSha256: string;
  readonly issueUrls: readonly string[];
  readonly bytes: Uint8Array;
  /** Test-only fault injection; the operator path uses the native rename. */
  readonly renameFile?: (source: string, destination: string) => Promise<void>;
}

export type SyncResult =
  | { readonly ok: true; readonly lock: CatalogueLock }
  | { readonly ok: false; readonly code: SyncErrorCode };

export type CommittedPairResult =
  | { readonly ok: true; readonly lock: CatalogueLock; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: SyncErrorCode };

interface TransactionJournal {
  readonly version: typeof TRANSACTION_VERSION;
  readonly phase: "prepared" | "committed";
  readonly rootDirectory: string;
  readonly vendorPath: string;
  readonly lockPath: string;
  readonly stageDirectory: string;
  readonly stageVendorPath: string;
  readonly stageLockPath: string;
  readonly backupVendorPath: string;
  readonly backupLockPath: string;
  readonly hadVendor: boolean;
  readonly hadLock: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isArtifactUrl(value: unknown): value is string {
  if (!isHttpsUrl(value)) {
    return false;
  }
  const url = new URL(value);
  return url.search === "" && url.hash === "" && url.pathname.endsWith("/collector_catalogue.json");
}

function isIssueUrl(value: unknown): value is string {
  if (!isHttpsUrl(value)) {
    return false;
  }
  const url = new URL(value);
  return /^\/m4s-ai\/snoredex-(?:data|checklist)\/issues\/\d+$/.test(url.pathname) &&
    url.search === "" &&
    url.hash === "";
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function cataloguePath(rootDirectory: string): string {
  return resolve(rootDirectory, "vendor", "snoredex-data", "collector_catalogue.json");
}

function lockPath(rootDirectory: string): string {
  return resolve(rootDirectory, "catalogue.lock.json");
}

function transactionDirectory(rootDirectory: string): string {
  return resolve(rootDirectory, ".catalogue-sync");
}

function journalPath(rootDirectory: string): string {
  return join(transactionDirectory(rootDirectory), "journal.json");
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return isRecord(error) && error.code === code;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  return (
    value.schema === LOCK_SCHEMA &&
    value.schemaVersion === LOCK_VERSION &&
    value.sourceRepository === PRODUCER_REPOSITORY &&
    isCommit(value.producerRevision) &&
    isArtifactUrl(value.artifactUrl) &&
    typeof value.contractVersion === "string" &&
    isSha256(value.catalogueFingerprint) &&
    isSha256(value.catalogueByteSha256) &&
    typeof byteLength === "number" &&
    Number.isSafeInteger(byteLength) &&
    byteLength > 0 &&
    Array.isArray(value.issueUrls) &&
    value.issueUrls.length > 0 &&
    value.issueUrls.every(isIssueUrl)
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
    return { ok: false, code: "SYNC_ARTIFACT_TOO_LARGE" };
  }
  if (sha256(bytes) !== expectedByteSha256) {
    return { ok: false, code: "SYNC_BYTE_DIGEST_MISMATCH" };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: "SYNC_INVALID_ENCODING" };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "SYNC_INVALID_JSON" };
  }
  const validation = validateCatalogue(value);
  if (!validation.ok) {
    return { ok: false, code: "SYNC_CATALOGUE_INVALID" };
  }
  if (!isRecord(value) || !isRecord(value.meta) || value.meta.sourceRepository !== PRODUCER_REPOSITORY) {
    return { ok: false, code: "SYNC_CATALOGUE_INVALID" };
  }
  if (
    validation.catalogue.meta.schemaVersion !== contractVersion ||
    validation.catalogue.meta.catalogueFingerprint !== expectedFingerprint ||
    semanticFingerprint(value) !== expectedFingerprint
  ) {
    return { ok: false, code: "SYNC_FINGERPRINT_MISMATCH" };
  }
  return { ok: true, catalogue: value as Record<string, unknown> };
}

function parseJournal(value: unknown): TransactionJournal | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.version !== TRANSACTION_VERSION ||
    (value.phase !== "prepared" && value.phase !== "committed") ||
    typeof value.rootDirectory !== "string" ||
    typeof value.vendorPath !== "string" ||
    typeof value.lockPath !== "string" ||
    typeof value.stageDirectory !== "string" ||
    typeof value.stageVendorPath !== "string" ||
    typeof value.stageLockPath !== "string" ||
    typeof value.backupVendorPath !== "string" ||
    typeof value.backupLockPath !== "string" ||
    typeof value.hadVendor !== "boolean" ||
    typeof value.hadLock !== "boolean"
  ) {
    return undefined;
  }
  return value as unknown as TransactionJournal;
}

type JournalReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly journal: TransactionJournal }
  | { readonly kind: "invalid" };

async function readJournal(rootDirectory: string): Promise<JournalReadResult> {
  try {
    const raw = await readFile(journalPath(rootDirectory), "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { kind: "invalid" };
    }
    const journal = parseJournal(value);
    return journal ? { kind: "valid", journal } : { kind: "invalid" };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { kind: "missing" };
    }
    return { kind: "invalid" };
  }
}

async function rollback(journal: TransactionJournal): Promise<void> {
  if (journal.phase === "committed") {
    await cleanupCommitted(journal);
    return;
  }

  if (journal.hadVendor && (await exists(journal.backupVendorPath))) {
    await rm(journal.vendorPath, { force: true });
    await rename(journal.backupVendorPath, journal.vendorPath);
  } else if (!journal.hadVendor) {
    await rm(journal.vendorPath, { force: true });
  }
  if (journal.hadLock && (await exists(journal.backupLockPath))) {
    await rm(journal.lockPath, { force: true });
    await rename(journal.backupLockPath, journal.lockPath);
  } else if (!journal.hadLock) {
    await rm(journal.lockPath, { force: true });
  }
  await rm(journal.stageDirectory, { recursive: true, force: true });
  await rm(journal.backupVendorPath, { force: true });
  await rm(journal.backupLockPath, { force: true });
  await rm(journalPath(journal.rootDirectory), { force: true });
}

async function cleanupCommitted(journal: TransactionJournal): Promise<void> {
  await rm(journal.stageDirectory, { recursive: true, force: true });
  await rm(journal.backupVendorPath, { force: true });
  await rm(journal.backupLockPath, { force: true });
  await rm(journalPath(journal.rootDirectory), { force: true });
}

type RecoveryResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "SYNC_TRANSACTION_UNCERTAIN" };

export async function recoverCatalogueSync(rootDirectory: string): Promise<RecoveryResult> {
  const journalResult = await readJournal(rootDirectory);
  if (journalResult.kind === "missing") {
    return { ok: true };
  }
  if (journalResult.kind === "invalid") {
    return { ok: false, code: "SYNC_TRANSACTION_UNCERTAIN" };
  }
  try {
    await rollback(journalResult.journal);
    return { ok: true };
  } catch {
    return { ok: false, code: "SYNC_TRANSACTION_UNCERTAIN" };
  }
}

export async function readCommittedCataloguePair(rootDirectory: string): Promise<CommittedPairResult> {
  const recovery = await recoverCatalogueSync(rootDirectory);
  if (!recovery.ok) {
    return recovery;
  }
  const vendor = cataloguePath(rootDirectory);
  const lock = lockPath(rootDirectory);
  const [hasVendor, hasLock] = await Promise.all([exists(vendor), exists(lock)]);
  if (!hasVendor && !hasLock) {
    return { ok: false, code: "SYNC_PAIR_MISSING" };
  }
  if (!hasVendor || !hasLock) {
    return { ok: false, code: "SYNC_PAIR_INVALID" };
  }

  try {
    const bytes = await readFile(vendor);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const rawLock: unknown = JSON.parse(await readFile(lock, "utf8"));
    if (!lockIsValid(rawLock)) {
      return { ok: false, code: "SYNC_PAIR_INVALID" };
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
      bytes.byteLength !== rawLock.catalogueByteLength
    ) {
      return { ok: false, code: "SYNC_PAIR_INVALID" };
    }
    return { ok: true, lock: rawLock, bytes };
  } catch {
    return { ok: false, code: "SYNC_PAIR_INVALID" };
  }
}

export async function syncCataloguePair(request: CatalogueSyncRequest): Promise<SyncResult> {
  const rootDirectory = resolve(request.rootDirectory);
  if (
    !isArtifactUrl(request.artifactUrl) ||
    !isCommit(request.artifactCommit) ||
    typeof request.contractVersion !== "string" ||
    !isSha256(request.expectedFingerprint) ||
    !isSha256(request.expectedByteSha256) ||
    request.expectedFingerprint.length !== 71 ||
    request.expectedByteSha256.length !== 71 ||
    !Array.isArray(request.issueUrls) ||
    request.issueUrls.length === 0 ||
    !request.issueUrls.every(isIssueUrl) ||
    !(request.bytes instanceof Uint8Array)
  ) {
    return { ok: false, code: "SYNC_ARGUMENT_INVALID" };
  }

  const recovery = await recoverCatalogueSync(rootDirectory);
  if (!recovery.ok) {
    return recovery;
  }
  const existing = await readCommittedCataloguePair(rootDirectory);
  if (!existing.ok && existing.code !== "SYNC_PAIR_MISSING") {
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

  const vendor = cataloguePath(rootDirectory);
  const lock = lockPath(rootDirectory);
  const txId = randomUUID();
  const stageDirectory = join(transactionDirectory(rootDirectory), txId);
  const stageVendorPath = join(stageDirectory, "collector_catalogue.json");
  const stageLockPath = join(stageDirectory, "catalogue.lock.json");
  const journal: TransactionJournal = {
    version: TRANSACTION_VERSION,
    phase: "prepared",
    rootDirectory,
    vendorPath: vendor,
    lockPath: lock,
    stageDirectory,
    stageVendorPath,
    stageLockPath,
    backupVendorPath: `${vendor}.backup-${txId}`,
    backupLockPath: `${lock}.backup-${txId}`,
    hadVendor: await exists(vendor),
    hadLock: await exists(lock),
  };
  const catalogueLock = makeLock(request, request.bytes.byteLength);
  const move = request.renameFile ?? rename;

  try {
    await mkdir(dirname(vendor), { recursive: true });
    await mkdir(stageDirectory, { recursive: true });
    await writeFile(stageVendorPath, request.bytes);
    await writeJson(stageLockPath, catalogueLock);
    await writeJsonAtomically(journalPath(rootDirectory), journal);

    if (journal.hadVendor) {
      await move(vendor, journal.backupVendorPath);
    }
    if (journal.hadLock) {
      await move(lock, journal.backupLockPath);
    }
    await move(stageVendorPath, vendor);
    await move(stageLockPath, lock);
    await writeJsonAtomically(journalPath(rootDirectory), { ...journal, phase: "committed" });
    await cleanupCommitted({ ...journal, phase: "committed" }).catch(() => undefined);
    return { ok: true, lock: catalogueLock };
  } catch {
    try {
      await rollback(journal);
    } catch {
      return { ok: false, code: "SYNC_TRANSACTION_UNCERTAIN" };
    }
    return { ok: false, code: "SYNC_TRANSACTION_FAILED" };
  }
}
