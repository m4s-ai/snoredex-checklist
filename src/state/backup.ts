import {
  PRIVATE_DATASET_ID,
  PRIVATE_STATE_SCHEMA,
  PRIVATE_STATE_VERSION,
  serializePrivateState,
  serializePortableState,
  validatePrivateState,
  validatePortableState,
  type PrivateState,
  type PortablePrivateState,
  type StateErrorCode,
} from './domain.ts';
import { readStateAuthorityParts, type AuthorityReadResult, type StateAuthorityParts } from './authority.ts';
import {
  PRIVATE_STATE_RECOVERY_RECORDS_QUARANTINE_STORAGE_KEY,
  PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY,
  PRIVATE_STATE_RECOVERY_STORAGE_KEY,
  PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY,
  PRIVATE_STATE_STORAGE_KEY,
  type StorageLike,
} from './storage.ts';
import {
  reconcilePrivateState,
  type ReconciliationContext,
  type ReconciliationReport,
  type ReconciliationSuccess,
} from './reconciliation.ts';
import {
  mergeRecoveryRecords,
  readRecoveryRecords,
  PRIVATE_STATE_RECOVERY_RECORDS_SCHEMA,
  PRIVATE_STATE_RECOVERY_RECORDS_VERSION,
  recoveryRecordsFromResult,
  serializeRecoveryRecords,
  type DurableRecoveryRecord,
  updateRecoveryRecords,
} from './recovery-records.ts';

export const MAX_PORTABLE_BYTES = 16 * 1024 * 1024;
export const PRIVATE_BACKUP_SUFFIX = ['.snoredex-', 'private.json'].join('');
export const SUGGESTED_BACKUP_FILENAME = `snoredex-checklist-backup${PRIVATE_BACKUP_SUFFIX}`;
export const SUGGESTED_RECOVERY_RECORDS_FILENAME = `snoredex-checklist-recovery-records${PRIVATE_BACKUP_SUFFIX}`;
const RECOVERY_RECORDS_QUARANTINE_SCHEMA = 'snoredex-private-state-recovery-records-quarantine' as const;
const RECOVERY_RECORDS_QUARANTINE_VERSION = 1 as const;

export const BACKUP_ERROR_CODES = [
  'IMPORT_FILE_TOO_LARGE',
  'IMPORT_FILE_READ_FAILED',
  'IMPORT_INVALID_ENCODING',
  'IMPORT_INVALID_JSON',
  'IMPORT_UNSUPPORTED_STATE_SCHEMA',
  'IMPORT_UNSUPPORTED_STATE_VERSION',
  'IMPORT_UNKNOWN_FIELD',
  'IMPORT_INVALID_STATE_DATA',
  'IMPORT_DUPLICATE_ITEM_ID',
  'STATE_FINGERPRINT_UNSUPPORTED',
  'STATE_RECONCILIATION_BLOCKED',
  'STATE_PORTABLE_LIMIT_EXCEEDED',
  'STATE_CHANGED_DURING_OPERATION',
  'EXPORT_FAILED',
  'STORAGE_UNAVAILABLE',
  'STORAGE_QUOTA_EXCEEDED',
  'STORAGE_WRITE_FAILED',
  'STORAGE_COMMIT_UNCERTAIN',
  'LOCAL_STATE_UNSUPPORTED',
  'LOCAL_STATE_UNREADABLE',
] as const;
export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number];

export type BackupResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BackupErrorCode };

export interface ExportedBackup {
  readonly filename: string;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly state: PrivateState;
  readonly recoveryRecords: readonly DurableRecoveryRecord[];
  readonly recoveryRecordsBackup: RecoveryRecordsBackup | undefined;
}

export interface RecoveryRecordsBackup {
  readonly filename: string;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly records: readonly DurableRecoveryRecord[];
}

export interface BackupExportOptions {
  readonly appRevision: unknown;
  readonly exportedAt?: unknown;
  readonly filename?: string;
  readonly recoveryRecords?: readonly DurableRecoveryRecord[];
}

export interface RecoveryRecordsBackupOptions {
  readonly filename?: string;
}

export interface ImportPreview {
  readonly mode: 'create' | 'replace' | 'recovery-records';
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly schemaVersion: string;
  readonly explicitRecordCount: number;
  readonly statusCounts: Readonly<Record<'need' | 'ordered' | 'have' | 'skip', number>>;
  readonly quantityOwned: number;
  readonly quantityOrdered: number;
  readonly noteCount: number;
  readonly recordsToReplace: number;
  readonly reconciliation?: ReconciliationReport['accounting'];
}

export interface ImportPlan {
  readonly candidate: PrivateState;
  readonly preview: ImportPreview;
  readonly expectedRaw: AuthorityRawSnapshot;
  readonly reconciliation?: ReconciliationSuccess;
  /** In-memory source and gate inputs used to repeat reconciliation at commit time. */
  readonly reconciliationSource?: PrivateState;
  readonly reconciliationTargetFingerprint?: string;
  readonly reconciliationKnownItemIds?: ReadonlySet<string>;
  /** Private orphan records that must remain recoverable after an import. */
  readonly reconciliationRecovery?: PrivateState;
  /** Durable records produced by the source-to-target reconciliation. */
  readonly reconciliationRecoveryRecords?: readonly DurableRecoveryRecord[];
  /** Durable records carried by the portable source backup. */
  readonly importedRecoveryRecords?: readonly DurableRecoveryRecord[];
  /** True when the portable input carries only the durable recovery ledger. */
  readonly recoveryRecordsOnly?: boolean;
}

interface AuthorityRawSnapshot {
  readonly active: string | null;
  readonly recovery: string | null;
  readonly recoveryRecords: string | null;
}

export interface LifecycleSuccess {
  readonly active: PrivateState | undefined;
  readonly recovery: PrivateState | undefined;
  readonly recoveryRecords: readonly DurableRecoveryRecord[];
  readonly changed: boolean;
}

export type LifecycleResult = BackupResult<LifecycleSuccess>;

function ok<T>(value: T): BackupResult<T> {
  return { ok: true, value };
}

function fail<T>(error: BackupErrorCode): BackupResult<T> {
  return { ok: false, error };
}

function mapStateError(error: StateErrorCode): BackupErrorCode {
  switch (error) {
    case 'IMPORT_UNSUPPORTED_STATE_SCHEMA':
    case 'IMPORT_UNSUPPORTED_STATE_VERSION':
    case 'IMPORT_UNKNOWN_FIELD':
    case 'IMPORT_INVALID_STATE_DATA':
    case 'IMPORT_DUPLICATE_ITEM_ID':
      return error;
    default:
      return 'IMPORT_INVALID_STATE_DATA';
  }
}

function isQuotaError(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('name' in value)) return false;
  const name = (value as { name?: unknown }).name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRecoveryRecordsFilename(filename: string | undefined): string {
  if (filename === undefined || !filename.endsWith(PRIVATE_BACKUP_SUFFIX)) {
    return SUGGESTED_RECOVERY_RECORDS_FILENAME;
  }
  const basename = filename.replace(/[\\/\u0000-\u001f\u007f]/g, '_');
  return basename.endsWith(PRIVATE_BACKUP_SUFFIX) ? basename : SUGGESTED_RECOVERY_RECORDS_FILENAME;
}

export function createRecoveryRecordsBackup(
  records: readonly DurableRecoveryRecord[],
  options: RecoveryRecordsBackupOptions = {},
): BackupResult<RecoveryRecordsBackup> {
  const serialized = serializeRecoveryRecords(records);
  if (!serialized.ok || serialized.value === null) return fail('EXPORT_FAILED');
  const canonical = readRecoveryRecords(serialized.value);
  if (!canonical.ok) return fail('EXPORT_FAILED');
  const bytes = new TextEncoder().encode(serialized.value);
  if (bytes.byteLength > MAX_PORTABLE_BYTES) return fail('STATE_PORTABLE_LIMIT_EXCEEDED');
  return ok({
    filename: normalizeRecoveryRecordsFilename(options.filename),
    text: serialized.value,
    bytes,
    byteLength: bytes.byteLength,
    records: canonical.value,
  });
}

export function parseRecoveryRecordsBackup(input: Uint8Array): BackupResult<{
  readonly records: readonly DurableRecoveryRecord[];
  readonly text: string;
  readonly byteLength: number;
}> {
  if (!(input instanceof Uint8Array)) return fail('IMPORT_FILE_READ_FAILED');
  if (input.byteLength > MAX_PORTABLE_BYTES) return fail('IMPORT_FILE_TOO_LARGE');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    return fail('IMPORT_INVALID_ENCODING');
  }
  const records = readRecoveryRecords(text);
  if (!records.ok) return fail('IMPORT_INVALID_STATE_DATA');
  if (records.value.length === 0) return fail('IMPORT_INVALID_STATE_DATA');
  return ok({ records: records.value, text, byteLength: input.byteLength });
}

function serializePortableBackup(
  state: PrivateState,
  options: BackupExportOptions,
): BackupResult<{
  readonly text: string;
  readonly recoveryRecords: readonly DurableRecoveryRecord[];
  readonly recoveryRecordsBackup: RecoveryRecordsBackup | undefined;
}> {
  const serialized = serializePortableState(state, {
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    appRevision: options.appRevision,
  });
  if (!serialized.ok) return fail('EXPORT_FAILED');
  const records = serializeRecoveryRecords(options.recoveryRecords ?? []);
  if (!records.ok) return fail('EXPORT_FAILED');
  if (records.value === null)
    return ok({ text: serialized.value, recoveryRecords: [], recoveryRecordsBackup: undefined });
  const recoveryRecordsBackup = createRecoveryRecordsBackup(options.recoveryRecords ?? []);
  if (!recoveryRecordsBackup.ok) return recoveryRecordsBackup;
  return ok({
    text: serialized.value,
    recoveryRecords: recoveryRecordsBackup.value.records,
    recoveryRecordsBackup: recoveryRecordsBackup.value,
  });
}

function normalizeFilename(filename: string | undefined): string {
  if (filename === undefined || !filename.endsWith(PRIVATE_BACKUP_SUFFIX)) {
    return SUGGESTED_BACKUP_FILENAME;
  }
  // A caller may provide a product-controlled localized label, but never a
  // user value. Keep path separators and control characters out of downloads.
  const basename = filename.replace(/[\\/\u0000-\u001f\u007f]/g, '_');
  return basename.endsWith(PRIVATE_BACKUP_SUFFIX) ? basename : SUGGESTED_BACKUP_FILENAME;
}

export function createPortableBackup(input: unknown, options: BackupExportOptions): BackupResult<ExportedBackup> {
  const state = validatePrivateState(input);
  if (!state.ok) return fail('EXPORT_FAILED');
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const serialized = serializePortableBackup(state.value, { ...options, exportedAt });
  if (!serialized.ok) return serialized;
  const bytes = new TextEncoder().encode(serialized.value.text);
  if (bytes.byteLength > MAX_PORTABLE_BYTES) return fail('STATE_PORTABLE_LIMIT_EXCEEDED');
  return ok({
    filename: normalizeFilename(options.filename),
    text: serialized.value.text,
    bytes,
    byteLength: bytes.byteLength,
    state: state.value,
    recoveryRecords: serialized.value.recoveryRecords,
    recoveryRecordsBackup: serialized.value.recoveryRecordsBackup,
  });
}

export function parsePortableBackup(
  input: Uint8Array,
  knownItemIds?: ReadonlySet<string>,
): BackupResult<{
  readonly state: PortablePrivateState;
  readonly text: string;
  readonly byteLength: number;
  readonly recoveryRecords: readonly DurableRecoveryRecord[];
}> {
  if (!(input instanceof Uint8Array)) return fail('IMPORT_FILE_READ_FAILED');
  if (input.byteLength > MAX_PORTABLE_BYTES) return fail('IMPORT_FILE_TOO_LARGE');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    return fail('IMPORT_INVALID_ENCODING');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(text) as unknown;
  } catch {
    return fail('IMPORT_INVALID_JSON');
  }
  let stateCandidate = candidate;
  let recoveryRecords: readonly DurableRecoveryRecord[] = [];
  if (isObjectRecord(candidate) && Object.prototype.hasOwnProperty.call(candidate, 'recoveryRecords')) {
    if (!Array.isArray(candidate.recoveryRecords)) return fail('IMPORT_INVALID_STATE_DATA');
    const parsedRecords = readRecoveryRecords(
      JSON.stringify({
        schema: PRIVATE_STATE_RECOVERY_RECORDS_SCHEMA,
        schemaVersion: PRIVATE_STATE_RECOVERY_RECORDS_VERSION,
        records: candidate.recoveryRecords,
      }),
    );
    if (!parsedRecords.ok) return fail('IMPORT_INVALID_STATE_DATA');
    const { recoveryRecords: _ignored, ...portableState } = candidate;
    stateCandidate = portableState;
    recoveryRecords = parsedRecords.value;
  }
  const state = validatePortableState(stateCandidate, knownItemIds);
  if (!state.ok) return fail(mapStateError(state.error));
  return ok({ state: state.value, text, byteLength: input.byteLength, recoveryRecords });
}

export async function parsePortableBackupFrom(
  read: () => Promise<Uint8Array>,
  knownItemIds?: ReadonlySet<string>,
): Promise<
  BackupResult<{
    readonly state: PortablePrivateState;
    readonly text: string;
    readonly byteLength: number;
    readonly recoveryRecords: readonly DurableRecoveryRecord[];
  }>
> {
  let bytes: Uint8Array;
  try {
    bytes = await read();
  } catch {
    return fail('IMPORT_FILE_READ_FAILED');
  }
  return parsePortableBackup(bytes, knownItemIds);
}

function aggregate(
  state: PrivateState,
): Omit<ImportPreview, 'mode' | 'sourceFingerprint' | 'targetFingerprint' | 'schemaVersion' | 'recordsToReplace'> {
  const statusCounts = { need: 0, ordered: 0, have: 0, skip: 0 };
  let quantityOwned = 0;
  let quantityOrdered = 0;
  let noteCount = 0;
  for (const item of state.items) {
    statusCounts[item.status] += 1;
    quantityOwned += item.quantityOwned;
    quantityOrdered += item.quantityOrdered;
    if (item.note !== undefined) noteCount += 1;
  }
  return {
    explicitRecordCount: state.items.length,
    statusCounts,
    quantityOwned,
    quantityOrdered,
    noteCount,
  };
}

export function buildImportPreview(
  state: PrivateState,
  current: PrivateState | undefined,
  targetFingerprint: string | undefined,
  reconciliation?: ReconciliationReport,
  currentPresent = current !== undefined,
): BackupResult<ImportPreview> {
  if (typeof targetFingerprint !== 'string' || state.catalogueFingerprint !== targetFingerprint) {
    return fail('STATE_FINGERPRINT_UNSUPPORTED');
  }
  const totals = aggregate(state);
  return ok({
    mode: !currentPresent || (current !== undefined && current.items.length === 0) ? 'create' : 'replace',
    sourceFingerprint: reconciliation?.sourceFingerprint ?? state.catalogueFingerprint,
    targetFingerprint,
    schemaVersion: state.schemaVersion,
    ...totals,
    recordsToReplace: current?.items.length ?? 0,
    ...(reconciliation === undefined ? {} : { reconciliation: reconciliation.accounting }),
  });
}

function readRaw(storage: StorageLike, key: string): BackupResult<string | null> {
  try {
    return ok(storage.getItem(key));
  } catch {
    return fail('STORAGE_UNAVAILABLE');
  }
}

type ReadAuthority = Extract<AuthorityReadResult, { ok: true }> & {
  readonly recoveryRecords: readonly DurableRecoveryRecord[];
};

interface ReadAuthorityParts extends StateAuthorityParts {
  readonly recoveryRecords: readonly DurableRecoveryRecord[];
  readonly recoveryRecordsError?: 'LOCAL_STATE_UNSUPPORTED' | 'LOCAL_STATE_UNREADABLE';
}

interface AuthorityReadSnapshot {
  readonly raw: AuthorityRawSnapshot;
  readonly authority: ReadAuthorityParts;
}

interface CorruptionQuarantine {
  readonly schema: 'snoredex-private-state-authority-quarantine';
  readonly schemaVersion: 2;
  readonly active: readonly string[];
  readonly recovery: readonly string[];
}

const AUTHORITY_QUARANTINE_SCHEMA = 'snoredex-private-state-authority-quarantine' as const;
const AUTHORITY_QUARANTINE_VERSION = 2 as const;
const AUTHORITY_QUARANTINE_LEGACY_VERSION = 1 as const;
const AUTHORITY_QUARANTINE_MAX_ENTRIES = 8;

function readAuthorityPartsWithoutRecoveryRecords(storage: StorageLike): BackupResult<{
  readonly raw: AuthorityRawSnapshot;
  readonly authority: StateAuthorityParts;
}> {
  const active = readRaw(storage, PRIVATE_STATE_STORAGE_KEY);
  if (!active.ok) return active;
  const recovery = readRaw(storage, PRIVATE_STATE_RECOVERY_STORAGE_KEY);
  if (!recovery.ok) return recovery;
  const recoveryRecords = readRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY);
  if (!recoveryRecords.ok) return recoveryRecords;
  return ok({
    raw: { active: active.value, recovery: recovery.value, recoveryRecords: recoveryRecords.value },
    authority: readStateAuthorityParts(active.value, recovery.value),
  });
}

function readAuthorityParts(storage: StorageLike): BackupResult<AuthorityReadSnapshot> {
  const withoutRecords = readAuthorityPartsWithoutRecoveryRecords(storage);
  if (!withoutRecords.ok) return withoutRecords;
  const parsedRecoveryRecords = readRecoveryRecords(withoutRecords.value.raw.recoveryRecords);
  let recoveryRecordsError: 'LOCAL_STATE_UNSUPPORTED' | 'LOCAL_STATE_UNREADABLE' | undefined;
  if (!parsedRecoveryRecords.ok) {
    let parsed: unknown;
    try {
      parsed =
        withoutRecords.value.raw.recoveryRecords === null
          ? undefined
          : (JSON.parse(withoutRecords.value.raw.recoveryRecords) as unknown);
    } catch {
      parsed = undefined;
    }
    const hasSchema = isObjectRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'schema');
    const hasVersion = isObjectRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'schemaVersion');
    const unsupportedEnvelope =
      isObjectRecord(parsed) &&
      ((hasSchema && typeof parsed.schema === 'string' && parsed.schema !== PRIVATE_STATE_RECOVERY_RECORDS_SCHEMA) ||
        (hasVersion &&
          typeof parsed.schemaVersion === 'number' &&
          parsed.schemaVersion !== PRIVATE_STATE_RECOVERY_RECORDS_VERSION));
    recoveryRecordsError = unsupportedEnvelope ? 'LOCAL_STATE_UNSUPPORTED' : 'LOCAL_STATE_UNREADABLE';
  }
  return ok({
    raw: withoutRecords.value.raw,
    authority: {
      ...withoutRecords.value.authority,
      recoveryRecords: parsedRecoveryRecords.ok ? parsedRecoveryRecords.value : [],
      ...(recoveryRecordsError === undefined ? {} : { recoveryRecordsError }),
    },
  });
}

function readAuthority(storage: StorageLike): BackupResult<{
  readonly raw: AuthorityRawSnapshot;
  readonly authority: ReadAuthority;
}> {
  const parts = readAuthorityParts(storage);
  if (!parts.ok) return parts;
  if (parts.value.authority.activeError !== undefined) return fail(parts.value.authority.activeError);
  if (parts.value.authority.recoveryError !== undefined) return fail(parts.value.authority.recoveryError);
  if (parts.value.authority.recoveryRecordsError !== undefined) return fail(parts.value.authority.recoveryRecordsError);
  return ok({
    raw: parts.value.raw,
    authority: {
      ok: true,
      active: parts.value.authority.active,
      recovery: parts.value.authority.recovery,
      enveloped: parts.value.authority.enveloped,
      recoveryRecords: parts.value.authority.recoveryRecords,
    },
  });
}

function unsupportedAuthorityError(authority: ReadAuthorityParts): BackupErrorCode | undefined {
  if (authority.activeError === 'LOCAL_STATE_UNSUPPORTED') return 'LOCAL_STATE_UNSUPPORTED';
  if (authority.recoveryError === 'LOCAL_STATE_UNSUPPORTED') return 'LOCAL_STATE_UNSUPPORTED';
  if (authority.recoveryRecordsError === 'LOCAL_STATE_UNSUPPORTED') return 'LOCAL_STATE_UNSUPPORTED';
  return undefined;
}

function restoreRaw(storage: StorageLike, key: string, raw: string | null): boolean {
  try {
    if (raw === null) {
      if (storage.removeItem === undefined) return false;
      storage.removeItem(key);
    } else {
      storage.setItem(key, raw);
    }
    return storage.getItem(key) === raw;
  } catch {
    return false;
  }
}

function writeRaw(storage: StorageLike, key: string, raw: string | null): void {
  if (raw === null) {
    if (storage.removeItem === undefined) throw new Error('Storage removal is unavailable');
    storage.removeItem(key);
  } else {
    storage.setItem(key, raw);
  }
}

function preservedRecovery(source: PrivateState, reconciliation: ReconciliationSuccess): PrivateState | undefined {
  const items = [...reconciliation.orphans, ...reconciliation.conflicts];
  return items.length === 0 ? undefined : { ...source, items };
}

function readRecoveryRecordsQuarantine(raw: string | null): BackupResult<readonly string[]> {
  if (raw === null) return ok([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return ok([raw]);
  }
  if (
    !isObjectRecord(parsed) ||
    parsed.schema !== RECOVERY_RECORDS_QUARANTINE_SCHEMA ||
    parsed.schemaVersion !== RECOVERY_RECORDS_QUARANTINE_VERSION
  ) {
    return ok([raw]);
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.some((entry) => typeof entry !== 'string')) {
    return fail('LOCAL_STATE_UNREADABLE');
  }
  return ok(parsed.entries);
}

function serializeRecoveryRecordsQuarantine(entries: readonly string[]): string {
  return `${JSON.stringify(
    { schema: RECOVERY_RECORDS_QUARANTINE_SCHEMA, schemaVersion: RECOVERY_RECORDS_QUARANTINE_VERSION, entries },
    null,
    2,
  )}\n`;
}

function preserveUnreadableRecoveryRecords(storage: StorageLike, raw: string | null): BackupResult<void> {
  if (raw === null) return ok(undefined);
  const existing = readRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_QUARANTINE_STORAGE_KEY);
  if (!existing.ok) return existing;
  const entries = readRecoveryRecordsQuarantine(existing.value);
  if (!entries.ok) return entries;
  if (entries.value.includes(raw)) return ok(undefined);
  const next = serializeRecoveryRecordsQuarantine([...entries.value, raw]);
  try {
    storage.setItem(PRIVATE_STATE_RECOVERY_RECORDS_QUARANTINE_STORAGE_KEY, next);
  } catch (cause) {
    const verified = readRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_QUARANTINE_STORAGE_KEY);
    if (verified.ok && verified.value === next) return ok(undefined);
    return fail(isQuotaError(cause) ? 'STORAGE_QUOTA_EXCEEDED' : 'STORAGE_WRITE_FAILED');
  }
  const verified = readRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_QUARANTINE_STORAGE_KEY);
  return verified.ok && verified.value === next ? ok(undefined) : fail('STORAGE_COMMIT_UNCERTAIN');
}

function readAuthorityQuarantine(raw: string | null): BackupResult<CorruptionQuarantine> {
  if (raw === null) {
    return ok({
      schema: AUTHORITY_QUARANTINE_SCHEMA,
      schemaVersion: AUTHORITY_QUARANTINE_VERSION,
      active: [],
      recovery: [],
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return fail('LOCAL_STATE_UNREADABLE');
  }
  if (!isObjectRecord(parsed) || parsed.schema !== AUTHORITY_QUARANTINE_SCHEMA) {
    return fail('LOCAL_STATE_UNREADABLE');
  }
  if (parsed.schemaVersion === AUTHORITY_QUARANTINE_LEGACY_VERSION) {
    if (
      (parsed.active !== null && typeof parsed.active !== 'string') ||
      (parsed.recovery !== null && typeof parsed.recovery !== 'string')
    ) {
      return fail('LOCAL_STATE_UNREADABLE');
    }
    return ok({
      schema: AUTHORITY_QUARANTINE_SCHEMA,
      schemaVersion: AUTHORITY_QUARANTINE_VERSION,
      active: parsed.active === null ? [] : [parsed.active],
      recovery: parsed.recovery === null ? [] : [parsed.recovery],
    });
  }
  if (
    parsed.schemaVersion !== AUTHORITY_QUARANTINE_VERSION ||
    !Array.isArray(parsed.active) ||
    !Array.isArray(parsed.recovery) ||
    parsed.active.some((entry) => typeof entry !== 'string') ||
    parsed.recovery.some((entry) => typeof entry !== 'string') ||
    parsed.active.length > AUTHORITY_QUARANTINE_MAX_ENTRIES ||
    parsed.recovery.length > AUTHORITY_QUARANTINE_MAX_ENTRIES
  ) {
    return fail('LOCAL_STATE_UNREADABLE');
  }
  return ok({
    schema: AUTHORITY_QUARANTINE_SCHEMA,
    schemaVersion: AUTHORITY_QUARANTINE_VERSION,
    active: parsed.active as string[],
    recovery: parsed.recovery as string[],
  });
}

function serializeAuthorityQuarantine(value: CorruptionQuarantine): string {
  return `${JSON.stringify(value)}\n`;
}

function unreadableAuthorityRaw(snapshot: AuthorityReadSnapshot, component: 'active' | 'recovery'): string | null {
  if (component === 'active' && snapshot.authority.activeError !== undefined) {
    return snapshot.raw.active;
  }
  if (component === 'recovery' && snapshot.authority.recoveryError !== undefined) {
    // In an authority envelope both components live in the active key. The
    // sidecar, when present, is not the bytes that failed validation.
    return snapshot.authority.enveloped ? snapshot.raw.active : snapshot.raw.recovery;
  }
  return null;
}

/** Preserve malformed authority bytes without allowing a later repair to overwrite a different copy. */
function preserveUnreadableAuthority(
  storage: StorageLike,
  activeRaw: string | null,
  recoveryRaw: string | null,
): BackupResult<void> {
  if (activeRaw === null && recoveryRaw === null) return ok(undefined);
  const existing = readRaw(storage, PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY);
  if (!existing.ok) return existing;
  const parsed = readAuthorityQuarantine(existing.value);
  if (!parsed.ok) return parsed;
  const append = (entries: readonly string[], rawValue: string | null): BackupResult<readonly string[]> => {
    if (rawValue === null || entries.includes(rawValue)) return ok(entries);
    if (entries.length >= AUTHORITY_QUARANTINE_MAX_ENTRIES) return fail('STORAGE_WRITE_FAILED');
    return ok([...entries, rawValue]);
  };
  const active = append(parsed.value.active, activeRaw);
  if (!active.ok) return active;
  const recovery = append(parsed.value.recovery, recoveryRaw);
  if (!recovery.ok) return recovery;
  const next: CorruptionQuarantine = {
    schema: AUTHORITY_QUARANTINE_SCHEMA,
    schemaVersion: AUTHORITY_QUARANTINE_VERSION,
    active: active.value,
    recovery: recovery.value,
  };
  const serialized = serializeAuthorityQuarantine(next);
  if (existing.value === serialized) return ok(undefined);
  try {
    storage.setItem(PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY, serialized);
  } catch (cause) {
    const verified = readRaw(storage, PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY);
    if (verified.ok && verified.value === serialized) return ok(undefined);
    return fail(isQuotaError(cause) ? 'STORAGE_QUOTA_EXCEEDED' : 'STORAGE_WRITE_FAILED');
  }
  const verified = readRaw(storage, PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY);
  return verified.ok && verified.value === serialized ? ok(undefined) : fail('STORAGE_COMMIT_UNCERTAIN');
}

function writeRecoveryRecordsRepair(
  storage: StorageLike,
  expectedRaw: AuthorityRawSnapshot,
  recoveryRecords: readonly DurableRecoveryRecord[],
): BackupResult<LifecycleSuccess> {
  const current = readAuthorityPartsWithoutRecoveryRecords(storage);
  if (!current.ok) return current;
  if (
    current.value.raw.active !== expectedRaw.active ||
    current.value.raw.recovery !== expectedRaw.recovery ||
    current.value.raw.recoveryRecords !== expectedRaw.recoveryRecords
  ) {
    return fail('STATE_CHANGED_DURING_OPERATION');
  }
  const preserved = preserveUnreadableRecoveryRecords(storage, current.value.raw.recoveryRecords);
  if (!preserved.ok) return preserved;
  const serialized = serializeRecoveryRecords(recoveryRecords);
  if (!serialized.ok || serialized.value === null) return fail('STATE_RECONCILIATION_BLOCKED');
  try {
    storage.setItem(PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, serialized.value);
  } catch (cause) {
    const restored = restoreRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, expectedRaw.recoveryRecords);
    return fail(
      restored ? (isQuotaError(cause) ? 'STORAGE_QUOTA_EXCEEDED' : 'STORAGE_WRITE_FAILED') : 'STORAGE_COMMIT_UNCERTAIN',
    );
  }
  const after = readAuthorityParts(storage);
  if (
    !after.ok ||
    after.value.raw.active !== expectedRaw.active ||
    after.value.raw.recovery !== expectedRaw.recovery ||
    after.value.raw.recoveryRecords !== serialized.value
  ) {
    const restored = restoreRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, expectedRaw.recoveryRecords);
    if (restored) return fail('STORAGE_WRITE_FAILED');
    return fail('STORAGE_COMMIT_UNCERTAIN');
  }
  return ok({
    active: after.value.authority.active,
    recovery: after.value.authority.recovery,
    recoveryRecords: after.value.authority.recoveryRecords,
    changed: true,
  });
}

function writeAuthority(
  storage: StorageLike,
  expectedRaw: AuthorityRawSnapshot,
  active: PrivateState | undefined,
  recovery: PrivateState | undefined,
  recoveryRecords: readonly DurableRecoveryRecord[],
  currentSnapshot?: AuthorityReadSnapshot,
): BackupResult<LifecycleSuccess> {
  let current: AuthorityReadSnapshot;
  if (currentSnapshot !== undefined) {
    current = currentSnapshot;
  } else {
    const read = readAuthorityParts(storage);
    if (!read.ok) return read;
    current = read.value;
  }
  if (
    current.raw.active !== expectedRaw.active ||
    current.raw.recovery !== expectedRaw.recovery ||
    current.raw.recoveryRecords !== expectedRaw.recoveryRecords
  ) {
    return fail('STATE_CHANGED_DURING_OPERATION');
  }
  const serializedActive = active === undefined ? ok<string | null>(null) : serializePrivateState(active);
  if (!serializedActive.ok) return fail('STORAGE_WRITE_FAILED');
  const activeText = serializedActive.value;
  const serializedRecovery = recovery === undefined ? 'null' : serializePrivateState(recovery);
  if (typeof serializedRecovery !== 'string' && !serializedRecovery.ok) return fail('STORAGE_WRITE_FAILED');
  const recoveryText = typeof serializedRecovery === 'string' ? serializedRecovery : serializedRecovery.value;
  const serializedRecoveryRecords = serializeRecoveryRecords(recoveryRecords);
  if (!serializedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
  const recoveryRecordsText = serializedRecoveryRecords.value;
  const activeChanged = current.raw.active !== activeText;
  const recoveryChanged = current.raw.recovery !== recoveryText;
  const recoveryRecordsChanged = current.raw.recoveryRecords !== recoveryRecordsText;
  const matchesExpectedRaw = (raw: AuthorityRawSnapshot): boolean =>
    raw.active === expectedRaw.active &&
    raw.recovery === expectedRaw.recovery &&
    raw.recoveryRecords === expectedRaw.recoveryRecords;
  const restoreRecoveryRecords = (): boolean =>
    restoreRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, expectedRaw.recoveryRecords);
  const restoreSidecars = (): boolean => {
    const restoredRecovery =
      !recoveryChanged || restoreRaw(storage, PRIVATE_STATE_RECOVERY_STORAGE_KEY, expectedRaw.recovery);
    const restoredRecords = !recoveryRecordsChanged || restoreRecoveryRecords();
    return restoredRecovery && restoredRecords;
  };
  const restoreExpected = (): boolean => {
    const restoredSidecars = restoreSidecars();
    const restoredActive = restoreRaw(storage, PRIVATE_STATE_STORAGE_KEY, expectedRaw.active);
    return restoredSidecars && restoredActive;
  };
  try {
    if (recoveryRecordsChanged) {
      writeRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, recoveryRecordsText);
      if (storage.getItem(PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY) !== recoveryRecordsText) {
        restoreRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, expectedRaw.recoveryRecords);
        return fail('STORAGE_COMMIT_UNCERTAIN');
      }
    }
    if (recoveryChanged) {
      storage.setItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY, recoveryText);
      if (storage.getItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY) !== recoveryText) {
        restoreRaw(storage, PRIVATE_STATE_RECOVERY_STORAGE_KEY, expectedRaw.recovery);
        if (recoveryRecordsChanged) restoreRecoveryRecords();
        return fail('STORAGE_COMMIT_UNCERTAIN');
      }
    }
  } catch (cause) {
    if (restoreSidecars()) return fail(isQuotaError(cause) ? 'STORAGE_QUOTA_EXCEEDED' : 'STORAGE_WRITE_FAILED');
    return fail('STORAGE_COMMIT_UNCERTAIN');
  }
  try {
    if (activeChanged) {
      writeRaw(storage, PRIVATE_STATE_STORAGE_KEY, activeText);
      if (storage.getItem(PRIVATE_STATE_STORAGE_KEY) !== activeText) {
        const restoredSidecars = restoreSidecars();
        const restoredActive = restoreRaw(storage, PRIVATE_STATE_STORAGE_KEY, expectedRaw.active);
        const afterFailure = readAuthorityParts(storage);
        if (
          (restoredSidecars && restoredActive) ||
          (restoredSidecars && afterFailure.ok && afterFailure.value.raw.active === expectedRaw.active)
        ) {
          return fail('STORAGE_WRITE_FAILED');
        }
        return fail('STORAGE_COMMIT_UNCERTAIN');
      }
    }
  } catch (cause) {
    const restoredSidecars = restoreSidecars();
    const restoredActive = restoreRaw(storage, PRIVATE_STATE_STORAGE_KEY, expectedRaw.active);
    const afterFailure = readAuthorityParts(storage);
    if (
      (restoredSidecars && restoredActive) ||
      (restoredSidecars && afterFailure.ok && afterFailure.value.raw.active === expectedRaw.active)
    ) {
      return fail(isQuotaError(cause) ? 'STORAGE_QUOTA_EXCEEDED' : 'STORAGE_WRITE_FAILED');
    }
    return fail('STORAGE_COMMIT_UNCERTAIN');
  }
  const after = readAuthority(storage);
  if (
    !after.ok ||
    after.value.raw.active !== activeText ||
    after.value.raw.recovery !== recoveryText ||
    after.value.raw.recoveryRecords !== recoveryRecordsText
  ) {
    if (restoreExpected()) return fail('STORAGE_WRITE_FAILED');
    const afterRestore = readAuthorityParts(storage);
    if (afterRestore.ok && matchesExpectedRaw(afterRestore.value.raw)) return fail('STORAGE_WRITE_FAILED');
    return fail('STORAGE_COMMIT_UNCERTAIN');
  }
  return ok({
    active: after.value.authority.active,
    recovery: after.value.authority.recovery,
    recoveryRecords: after.value.authority.recoveryRecords,
    changed: true,
  });
}

/** Promote an existing recovery snapshot without consuming it before active promotion succeeds. */
function promoteRecovery(
  storage: StorageLike,
  expectedRaw: AuthorityRawSnapshot,
  active: PrivateState,
  recovery: PrivateState | undefined,
  recoveryRecords: readonly DurableRecoveryRecord[],
  currentSnapshot?: AuthorityReadSnapshot,
): BackupResult<LifecycleSuccess> {
  // Recovery promotion is the same three-key transaction as any other
  // authority update. Keeping one commit path makes rollback and restore
  // preserve the durable record ledger under every write failure.
  return writeAuthority(storage, expectedRaw, active, recovery, recoveryRecords, currentSnapshot);
}

async function exclusive<T>(storage: StorageLike, callback: () => T): Promise<T> {
  if (storage.withLock === undefined) return callback();
  return storage.withLock(async () => callback());
}

/**
 * Import, clear and recovery operations sharing the logical local authority.
 * The active payload stays in the legacy-readable state key; the single
 * recovery slot is kept in its private sidecar so older builds can roll back
 * and still read the active collection.
 * All mutating methods require an explicit confirmation flag and re-check the
 * raw value captured by preview, so a stale preview cannot replace newer data.
 */
export class PrivateStateLifecycle {
  private readonly storage: StorageLike;
  private readonly appRevision: string;
  private readonly now: () => string;
  private readonly reconciliation?: ReconciliationContext;

  public constructor(
    storage: StorageLike,
    options: {
      readonly appRevision: string;
      readonly now?: () => string;
      readonly reconciliation?: ReconciliationContext;
    },
  ) {
    this.storage = storage;
    this.appRevision = options.appRevision;
    this.now = options.now ?? (() => new Date().toISOString());
    this.reconciliation = options.reconciliation;
  }

  public read(): BackupResult<{
    readonly active: PrivateState | undefined;
    readonly recovery: PrivateState | undefined;
    readonly recoveryRecords: readonly DurableRecoveryRecord[];
    readonly activeError?: 'LOCAL_STATE_UNSUPPORTED' | 'LOCAL_STATE_UNREADABLE';
    readonly recoveryError?: 'LOCAL_STATE_UNSUPPORTED' | 'LOCAL_STATE_UNREADABLE';
    readonly recoveryRecordsError?: 'LOCAL_STATE_UNSUPPORTED' | 'LOCAL_STATE_UNREADABLE';
  }> {
    const result = readAuthorityParts(this.storage);
    if (!result.ok) return result;
    return ok({
      active: result.value.authority.active,
      recovery: result.value.authority.recovery,
      recoveryRecords: result.value.authority.recoveryRecords,
      ...(result.value.authority.activeError === undefined ? {} : { activeError: result.value.authority.activeError }),
      ...(result.value.authority.recoveryError === undefined
        ? {}
        : { recoveryError: result.value.authority.recoveryError }),
      ...(result.value.authority.recoveryRecordsError === undefined
        ? {}
        : { recoveryRecordsError: result.value.authority.recoveryRecordsError }),
    });
  }

  public exportActive(): BackupResult<ExportedBackup> {
    const current = this.read();
    if (!current.ok) return current;
    if (current.value.activeError !== undefined) return fail(current.value.activeError);
    if (current.value.active === undefined || current.value.active.items.length === 0) return fail('EXPORT_FAILED');
    return createPortableBackup(current.value.active, {
      appRevision: this.appRevision,
      exportedAt: this.now(),
      recoveryRecords: current.value.recoveryRecordsError === undefined ? current.value.recoveryRecords : [],
    });
  }

  public exportRecovery(): BackupResult<ExportedBackup> {
    const current = this.read();
    if (!current.ok) return current;
    if (current.value.recoveryError !== undefined) return fail(current.value.recoveryError);
    if (current.value.recovery === undefined) return fail('EXPORT_FAILED');
    return createPortableBackup(current.value.recovery, {
      appRevision: this.appRevision,
      exportedAt: this.now(),
      recoveryRecords: current.value.recoveryRecordsError === undefined ? current.value.recoveryRecords : [],
    });
  }

  public exportRecoveryRecords(): BackupResult<RecoveryRecordsBackup> {
    const current = this.read();
    if (!current.ok) return current;
    if (current.value.recoveryRecordsError !== undefined) return fail(current.value.recoveryRecordsError);
    return createRecoveryRecordsBackup(current.value.recoveryRecords);
  }

  public prepareImport(
    bytes: Uint8Array,
    targetFingerprint: string,
    knownItemIds: ReadonlySet<string>,
  ): BackupResult<ImportPlan> {
    // Parse the source envelope without target membership filtering. Older
    // catalogue IDs must reach the shared reconciliation gate instead of
    // being mistaken for malformed input and silently discarded.
    const parsed = parsePortableBackup(bytes);
    const recordsBackup = parsed.ok ? undefined : parseRecoveryRecordsBackup(bytes);
    const recoveryRecordsPlan = (
      expectedRaw: AuthorityRawSnapshot,
      active: PrivateState | undefined,
      recoveryRecords: readonly DurableRecoveryRecord[],
    ): BackupResult<ImportPlan> => {
      const preview: ImportPreview = {
        mode: 'recovery-records',
        sourceFingerprint: targetFingerprint,
        targetFingerprint,
        schemaVersion: PRIVATE_STATE_VERSION,
        explicitRecordCount: recoveryRecords.length,
        statusCounts: { need: 0, ordered: 0, have: 0, skip: 0 },
        quantityOwned: 0,
        quantityOrdered: 0,
        noteCount: 0,
        recordsToReplace: 0,
      };
      const candidate = active ?? {
        schema: PRIVATE_STATE_SCHEMA,
        schemaVersion: PRIVATE_STATE_VERSION,
        datasetId: PRIVATE_DATASET_ID,
        catalogueFingerprint: targetFingerprint,
        items: [],
      };
      return ok({
        candidate,
        preview,
        expectedRaw,
        importedRecoveryRecords: recoveryRecords,
        recoveryRecordsOnly: true,
      });
    };
    if (!parsed.ok) {
      if (recordsBackup === undefined || !recordsBackup.ok) return parsed;
      const current = readAuthorityParts(this.storage);
      if (!current.ok) return current;
      const unsupported = unsupportedAuthorityError(current.value.authority);
      if (unsupported !== undefined) return fail(unsupported);
      return recoveryRecordsPlan(current.value.raw, current.value.authority.active, recordsBackup.value.records);
    }
    const current = readAuthorityParts(this.storage);
    if (!current.ok) return current;
    const unsupported = unsupportedAuthorityError(current.value.authority);
    if (unsupported !== undefined) return fail(unsupported);
    // Imported diagnostic metadata is intentionally not persisted as local
    // collection state. The next export gets fresh appRevision/exportedAt.
    const candidate: PrivateState = {
      schema: parsed.value.state.schema,
      schemaVersion: parsed.value.state.schemaVersion,
      datasetId: parsed.value.state.datasetId,
      catalogueFingerprint: parsed.value.state.catalogueFingerprint,
      items: parsed.value.state.items,
    };
    let reconciliation: ReconciliationSuccess | undefined;
    let reconciliationRecovery: PrivateState | undefined;
    let reconciliationRecoveryRecords: readonly DurableRecoveryRecord[] | undefined;
    const importedRecoveryRecords = parsed.value.recoveryRecords;
    let reconciledCandidate = candidate;
    if (candidate.catalogueFingerprint === targetFingerprint) {
      const checked = validatePrivateState(candidate, knownItemIds);
      if (!checked.ok) return fail(mapStateError(checked.error));
    } else {
      if (this.reconciliation === undefined) return fail('STATE_FINGERPRINT_UNSUPPORTED');
      const result = reconcilePrivateState(candidate, targetFingerprint, {
        ...this.reconciliation,
        knownTargetItemIds: knownItemIds,
      });
      if (!result.ok) return fail(result.error);
      reconciliation = result.value;
      reconciliationRecovery = preservedRecovery(candidate, result.value);
      const records = recoveryRecordsFromResult(candidate.catalogueFingerprint, result.value);
      if (!records.ok) return fail('STATE_RECONCILIATION_BLOCKED');
      reconciliationRecoveryRecords = records.value;
      reconciledCandidate = result.value.state;
    }
    const preview = buildImportPreview(
      reconciledCandidate,
      current.value.authority.active,
      targetFingerprint,
      reconciliation?.report,
      current.value.raw.active !== null,
    );
    if (!preview.ok) return preview;
    return ok({
      candidate: reconciledCandidate,
      preview: preview.value,
      expectedRaw: current.value.raw,
      ...(reconciliation === undefined ? {} : { reconciliation }),
      reconciliationSource: candidate,
      reconciliationTargetFingerprint: targetFingerprint,
      reconciliationKnownItemIds: new Set(knownItemIds),
      ...(reconciliationRecovery === undefined ? {} : { reconciliationRecovery }),
      ...(reconciliationRecoveryRecords === undefined ? {} : { reconciliationRecoveryRecords }),
      ...(importedRecoveryRecords.length === 0 ? {} : { importedRecoveryRecords }),
    });
  }

  public async commitImport(plan: ImportPlan, confirmed: boolean): Promise<LifecycleResult> {
    if (!confirmed) return ok({ active: undefined, recovery: undefined, recoveryRecords: [], changed: false });
    return exclusive(this.storage, () => {
      const importedRecoveryRecords = plan.importedRecoveryRecords ?? [];
      const validatedImportedRecoveryRecords = serializeRecoveryRecords(importedRecoveryRecords);
      if (!validatedImportedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
      if (plan.recoveryRecordsOnly === true) {
        const current = readAuthorityParts(this.storage);
        if (!current.ok) return current;
        const unsupported = unsupportedAuthorityError(current.value.authority);
        if (unsupported !== undefined) return fail(unsupported);
        if (
          current.value.raw.active !== plan.expectedRaw.active ||
          current.value.raw.recovery !== plan.expectedRaw.recovery ||
          current.value.raw.recoveryRecords !== plan.expectedRaw.recoveryRecords
        ) {
          return fail('STATE_CHANGED_DURING_OPERATION');
        }
        const mergedRecoveryRecords = mergeRecoveryRecords(
          current.value.authority.recoveryRecords,
          importedRecoveryRecords,
        );
        if (!mergedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
        if (
          current.value.authority.activeError === undefined &&
          current.value.authority.recoveryError === undefined &&
          current.value.authority.recoveryRecordsError === undefined
        ) {
          return writeAuthority(
            this.storage,
            plan.expectedRaw,
            current.value.authority.active,
            current.value.authority.recovery,
            mergedRecoveryRecords.value,
            current.value,
          );
        }
        return writeRecoveryRecordsRepair(this.storage, plan.expectedRaw, mergedRecoveryRecords.value);
      }
      const current = readAuthorityParts(this.storage);
      if (!current.ok) return current;
      const unsupported = unsupportedAuthorityError(current.value.authority);
      if (unsupported !== undefined) return fail(unsupported);
      if (
        current.value.raw.active !== plan.expectedRaw.active ||
        current.value.raw.recovery !== plan.expectedRaw.recovery ||
        current.value.raw.recoveryRecords !== plan.expectedRaw.recoveryRecords
      ) {
        return fail('STATE_CHANGED_DURING_OPERATION');
      }
      let candidate = plan.candidate;
      let reconciliationRecovery = plan.reconciliationRecovery;
      let reconciliationRecoveryRecords = plan.reconciliationRecoveryRecords;
      if (
        plan.reconciliationSource !== undefined &&
        plan.reconciliationTargetFingerprint !== undefined &&
        plan.reconciliationKnownItemIds !== undefined
      ) {
        const source = validatePrivateState(plan.reconciliationSource);
        if (!source.ok) return fail(mapStateError(source.error));
        if (source.value.catalogueFingerprint === plan.reconciliationTargetFingerprint) {
          const checked = validatePrivateState(source.value, plan.reconciliationKnownItemIds);
          if (!checked.ok) return fail(mapStateError(checked.error));
          candidate = checked.value;
        } else {
          if (this.reconciliation === undefined) return fail('STATE_FINGERPRINT_UNSUPPORTED');
          const result = reconcilePrivateState(source.value, plan.reconciliationTargetFingerprint, {
            ...this.reconciliation,
            knownTargetItemIds: plan.reconciliationKnownItemIds,
          });
          if (!result.ok) return fail(result.error);
          candidate = result.value.state;
          reconciliationRecovery = preservedRecovery(source.value, result.value);
          const records = recoveryRecordsFromResult(source.value.catalogueFingerprint, result.value);
          if (!records.ok) return fail('STATE_RECONCILIATION_BLOCKED');
          reconciliationRecoveryRecords = records.value;
        }
        const planned = serializePrivateState(plan.candidate);
        const rerun = serializePrivateState(candidate);
        const plannedRecovery =
          plan.reconciliationRecovery === undefined ? 'null' : serializePrivateState(plan.reconciliationRecovery);
        const rerunRecovery =
          reconciliationRecovery === undefined ? 'null' : serializePrivateState(reconciliationRecovery);
        const plannedRecoveryRecords = serializeRecoveryRecords(plan.reconciliationRecoveryRecords ?? []);
        const rerunRecoveryRecords = serializeRecoveryRecords(reconciliationRecoveryRecords ?? []);
        if (
          !planned.ok ||
          !rerun.ok ||
          (typeof plannedRecovery !== 'string' && !plannedRecovery.ok) ||
          (typeof rerunRecovery !== 'string' && !rerunRecovery.ok) ||
          !plannedRecoveryRecords.ok ||
          !rerunRecoveryRecords.ok ||
          planned.value !== rerun.value ||
          (typeof plannedRecovery === 'string' ? plannedRecovery : plannedRecovery.value) !==
            (typeof rerunRecovery === 'string' ? rerunRecovery : rerunRecovery.value) ||
          plannedRecoveryRecords.value !== rerunRecoveryRecords.value
        ) {
          return fail('STATE_RECONCILIATION_BLOCKED');
        }
      }
      const existingRecovery = current.value.authority.active?.items.length
        ? current.value.authority.active
        : current.value.authority.recovery;
      if (reconciliationRecovery !== undefined && existingRecovery !== undefined) {
        return fail('STATE_RECONCILIATION_BLOCKED');
      }
      const recovery = reconciliationRecovery ?? existingRecovery;
      const mergedExternalRecoveryRecords = mergeRecoveryRecords(
        current.value.authority.recoveryRecords,
        importedRecoveryRecords,
      );
      if (!mergedExternalRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
      const mergedRecoveryRecords = updateRecoveryRecords(
        mergedExternalRecoveryRecords.value,
        reconciliationRecoveryRecords ?? [],
        plan.reconciliationSource?.catalogueFingerprint,
      );
      if (!mergedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
      const preservedAuthority = preserveUnreadableAuthority(
        this.storage,
        unreadableAuthorityRaw(current.value, 'active'),
        unreadableAuthorityRaw(current.value, 'recovery'),
      );
      if (!preservedAuthority.ok) return preservedAuthority;
      if (current.value.authority.recoveryRecordsError !== undefined) {
        const preservedRecords = preserveUnreadableRecoveryRecords(this.storage, current.value.raw.recoveryRecords);
        if (!preservedRecords.ok) return preservedRecords;
      }
      return writeAuthority(
        this.storage,
        plan.expectedRaw,
        candidate,
        recovery,
        mergedRecoveryRecords.value,
        current.value,
      );
    });
  }

  public async clear(confirmed: boolean): Promise<LifecycleResult> {
    if (!confirmed) return ok({ active: undefined, recovery: undefined, recoveryRecords: [], changed: false });
    return exclusive(this.storage, () => {
      const current = readAuthority(this.storage);
      if (!current.ok) return current;
      const active = current.value.authority.active;
      if (active === undefined || active.items.length === 0) {
        return ok({
          active,
          recovery: current.value.authority.recovery,
          recoveryRecords: current.value.authority.recoveryRecords,
          changed: false,
        });
      }
      const empty: PrivateState = { ...active, items: [] };
      return writeAuthority(this.storage, current.value.raw, empty, active, current.value.authority.recoveryRecords);
    });
  }

  public async restore(
    confirmed: boolean,
    targetFingerprint: string,
    knownItemIds: ReadonlySet<string>,
  ): Promise<LifecycleResult> {
    if (!confirmed) return ok({ active: undefined, recovery: undefined, recoveryRecords: [], changed: false });
    return exclusive(this.storage, () => {
      const current = readAuthorityParts(this.storage);
      if (!current.ok) return current;
      const unsupported = unsupportedAuthorityError(current.value.authority);
      if (unsupported !== undefined) return fail(unsupported);
      if (current.value.authority.recoveryError !== undefined) return fail(current.value.authority.recoveryError);
      const recovery = current.value.authority.recovery;
      if (recovery === undefined) return fail('EXPORT_FAILED');
      const validatedRecovery = validatePrivateState(recovery);
      if (!validatedRecovery.ok) return fail(mapStateError(validatedRecovery.error));
      const active = current.value.authority.active;
      let candidate = validatedRecovery.value;
      const sourceFingerprint = candidate.catalogueFingerprint;
      let preservedRecovery: PrivateState | undefined;
      let preservedRecoveryRecords: readonly DurableRecoveryRecord[] = [];
      if (candidate.catalogueFingerprint === targetFingerprint) {
        const checked = validatePrivateState(candidate, knownItemIds);
        if (!checked.ok) return fail(mapStateError(checked.error));
        candidate = checked.value;
      } else {
        if (this.reconciliation === undefined) return fail('STATE_FINGERPRINT_UNSUPPORTED');
        const result = reconcilePrivateState(candidate, targetFingerprint, {
          ...this.reconciliation,
          knownTargetItemIds: knownItemIds,
        });
        if (!result.ok) return fail(result.error);
        const records = recoveryRecordsFromResult(candidate.catalogueFingerprint, result.value);
        if (!records.ok) return fail('STATE_RECONCILIATION_BLOCKED');
        preservedRecoveryRecords = records.value;
        const preservedItems = [...result.value.orphans, ...result.value.conflicts];
        preservedRecovery =
          preservedItems.length === 0 ? undefined : { ...validatedRecovery.value, items: preservedItems };
        candidate = result.value.state;
      }
      const preservedAuthority = preserveUnreadableAuthority(
        this.storage,
        unreadableAuthorityRaw(current.value, 'active'),
        null,
      );
      if (!preservedAuthority.ok) return preservedAuthority;
      if (current.value.authority.recoveryRecordsError !== undefined) {
        const preservedRecords = preserveUnreadableRecoveryRecords(this.storage, current.value.raw.recoveryRecords);
        if (!preservedRecords.ok) return preservedRecords;
      }
      if (active === undefined || active.items.length === 0) {
        const mergedRecoveryRecords = mergeRecoveryRecords(current.value.authority.recoveryRecords, []);
        if (!mergedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
        const updatedRecoveryRecords = updateRecoveryRecords(
          mergedRecoveryRecords.value,
          preservedRecoveryRecords,
          sourceFingerprint,
        );
        if (!updatedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
        return promoteRecovery(
          this.storage,
          current.value.raw,
          candidate,
          preservedRecovery,
          updatedRecoveryRecords.value,
          current.value,
        );
      }
      if (preservedRecovery !== undefined) return fail('STATE_RECONCILIATION_BLOCKED');
      const mergedRecoveryRecords = mergeRecoveryRecords(current.value.authority.recoveryRecords, []);
      if (!mergedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
      const updatedRecoveryRecords = updateRecoveryRecords(
        mergedRecoveryRecords.value,
        preservedRecoveryRecords,
        sourceFingerprint,
      );
      if (!updatedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
      return writeAuthority(
        this.storage,
        current.value.raw,
        candidate,
        preservedRecovery ?? active,
        updatedRecoveryRecords.value,
        current.value,
      );
    });
  }
}
