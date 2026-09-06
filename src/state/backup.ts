import {
  serializePrivateState,
  serializePortableState,
  validatePrivateState,
  validatePortableState,
  type PrivateState,
  type PortablePrivateState,
  type StateErrorCode,
} from './domain.ts';
import { readStateAuthority, type AuthorityReadResult } from './authority.ts';
import {
  PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY,
  PRIVATE_STATE_RECOVERY_STORAGE_KEY,
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
} from './recovery-records.ts';

export const MAX_PORTABLE_BYTES = 16 * 1024 * 1024;
export const PRIVATE_BACKUP_SUFFIX = ['.snoredex-', 'private.json'].join('');
export const SUGGESTED_BACKUP_FILENAME = `snoredex-checklist-backup${PRIVATE_BACKUP_SUFFIX}`;

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
}

export interface BackupExportOptions {
  readonly appRevision: unknown;
  readonly exportedAt?: unknown;
  readonly filename?: string;
  readonly recoveryRecords?: readonly DurableRecoveryRecord[];
}

export interface ImportPreview {
  readonly mode: 'create' | 'replace';
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

function serializePortableBackup(
  state: PrivateState,
  options: BackupExportOptions,
): BackupResult<{ readonly text: string; readonly recoveryRecords: readonly DurableRecoveryRecord[] }> {
  const serialized = serializePortableState(state, {
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    appRevision: options.appRevision,
  });
  if (!serialized.ok) return fail('EXPORT_FAILED');
  const records = serializeRecoveryRecords(options.recoveryRecords ?? []);
  if (!records.ok) return fail('EXPORT_FAILED');
  if (records.value === null) return ok({ text: serialized.value, recoveryRecords: [] });
  try {
    const portable = JSON.parse(serialized.value) as Record<string, unknown>;
    const envelope = JSON.parse(records.value) as { readonly records: readonly DurableRecoveryRecord[] };
    portable.recoveryRecords = envelope.records;
    return ok({
      text: `${JSON.stringify(portable, null, 2)}\n`,
      recoveryRecords: envelope.records,
    });
  } catch {
    return fail('EXPORT_FAILED');
  }
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
): BackupResult<ImportPreview> {
  if (typeof targetFingerprint !== 'string' || state.catalogueFingerprint !== targetFingerprint) {
    return fail('STATE_FINGERPRINT_UNSUPPORTED');
  }
  const totals = aggregate(state);
  return ok({
    mode: current === undefined || current.items.length === 0 ? 'create' : 'replace',
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

function readAuthority(storage: StorageLike): BackupResult<{
  readonly raw: AuthorityRawSnapshot;
  readonly authority: ReadAuthority;
}> {
  const active = readRaw(storage, PRIVATE_STATE_STORAGE_KEY);
  if (!active.ok) return active;
  const recovery = readRaw(storage, PRIVATE_STATE_RECOVERY_STORAGE_KEY);
  if (!recovery.ok) return recovery;
  const recoveryRecords = readRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY);
  if (!recoveryRecords.ok) return recoveryRecords;
  const parsedRecoveryRecords = readRecoveryRecords(recoveryRecords.value);
  if (!parsedRecoveryRecords.ok) return fail('LOCAL_STATE_UNREADABLE');
  const authority = readStateAuthority(active.value, recovery.value);
  return authority.ok
    ? ok({
        raw: { active: active.value, recovery: recovery.value, recoveryRecords: recoveryRecords.value },
        authority: { ...authority, recoveryRecords: parsedRecoveryRecords.value },
      })
    : fail(authority.error);
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

function preservedRecovery(source: PrivateState, reconciliation: ReconciliationSuccess): PrivateState | undefined {
  const items = [...reconciliation.orphans, ...reconciliation.conflicts];
  return items.length === 0 ? undefined : { ...source, items };
}

function writeAuthority(
  storage: StorageLike,
  expectedRaw: AuthorityRawSnapshot,
  active: PrivateState | undefined,
  recovery: PrivateState | undefined,
  recoveryRecords: readonly DurableRecoveryRecord[],
): BackupResult<LifecycleSuccess> {
  const current = readAuthority(storage);
  if (!current.ok) return current;
  if (
    current.value.raw.active !== expectedRaw.active ||
    current.value.raw.recovery !== expectedRaw.recovery ||
    current.value.raw.recoveryRecords !== expectedRaw.recoveryRecords
  ) {
    return fail('STATE_CHANGED_DURING_OPERATION');
  }
  const serializedActive = active === undefined ? ok('null') : serializePrivateState(active);
  if (!serializedActive.ok) return fail('STORAGE_WRITE_FAILED');
  const serializedRecovery = recovery === undefined ? 'null' : serializePrivateState(recovery);
  if (typeof serializedRecovery !== 'string' && !serializedRecovery.ok) return fail('STORAGE_WRITE_FAILED');
  const recoveryText = typeof serializedRecovery === 'string' ? serializedRecovery : serializedRecovery.value;
  const serializedRecoveryRecords = serializeRecoveryRecords(recoveryRecords);
  if (!serializedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
  const recoveryRecordsText = serializedRecoveryRecords.value;
  const recoveryChanged = current.value.raw.recovery !== recoveryText;
  const recoveryRecordsChanged = current.value.raw.recoveryRecords !== recoveryRecordsText;
  const restoreRecoveryRecords = (): boolean =>
    restoreRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, expectedRaw.recoveryRecords);
  const restoreSidecars = (): boolean =>
    (!recoveryChanged || restoreRaw(storage, PRIVATE_STATE_RECOVERY_STORAGE_KEY, expectedRaw.recovery)) &&
    (!recoveryRecordsChanged ||
      restoreRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, expectedRaw.recoveryRecords));
  const restoreExpected = (): boolean =>
    restoreSidecars() && restoreRaw(storage, PRIVATE_STATE_STORAGE_KEY, expectedRaw.active);
  try {
    if (recoveryRecordsChanged) {
      if (!restoreRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, recoveryRecordsText)) {
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
    storage.setItem(PRIVATE_STATE_STORAGE_KEY, serializedActive.value);
  } catch (cause) {
    const restoredSidecars = restoreSidecars();
    const restoredActive = restoreRaw(storage, PRIVATE_STATE_STORAGE_KEY, expectedRaw.active);
    const afterFailure = readAuthority(storage);
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
    after.value.raw.active !== serializedActive.value ||
    after.value.raw.recovery !== recoveryText ||
    after.value.raw.recoveryRecords !== recoveryRecordsText
  ) {
    if (restoreExpected()) return fail('STORAGE_WRITE_FAILED');
    const afterRestore = readAuthority(storage);
    if (afterRestore.ok && afterRestore.value.raw.active === expectedRaw.active) return fail('STORAGE_WRITE_FAILED');
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
): BackupResult<LifecycleSuccess> {
  // Recovery promotion is the same three-key transaction as any other
  // authority update. Keeping one commit path makes rollback and restore
  // preserve the durable record ledger under every write failure.
  return writeAuthority(storage, expectedRaw, active, recovery, recoveryRecords);
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
  }> {
    const result = readAuthority(this.storage);
    return result.ok
      ? ok({
          active: result.value.authority.active,
          recovery: result.value.authority.recovery,
          recoveryRecords: result.value.authority.recoveryRecords,
        })
      : result;
  }

  public exportActive(): BackupResult<ExportedBackup> {
    const current = this.read();
    if (!current.ok) return current;
    if (current.value.active === undefined || current.value.active.items.length === 0) return fail('EXPORT_FAILED');
    return createPortableBackup(current.value.active, {
      appRevision: this.appRevision,
      exportedAt: this.now(),
      recoveryRecords: current.value.recoveryRecords,
    });
  }

  public exportRecovery(): BackupResult<ExportedBackup> {
    const current = this.read();
    if (!current.ok) return current;
    if (current.value.recovery === undefined) return fail('EXPORT_FAILED');
    return createPortableBackup(current.value.recovery, {
      appRevision: this.appRevision,
      exportedAt: this.now(),
      recoveryRecords: current.value.recoveryRecords,
    });
  }

  public prepareImport(
    bytes: Uint8Array,
    targetFingerprint: string,
    knownItemIds: ReadonlySet<string>,
  ): BackupResult<ImportPlan> {
    const current = readAuthority(this.storage);
    if (!current.ok) return current;
    // Parse the source envelope without target membership filtering. Older
    // catalogue IDs must reach the shared reconciliation gate instead of
    // being mistaken for malformed input and silently discarded.
    const parsed = parsePortableBackup(bytes);
    if (!parsed.ok) return parsed;
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
      const current = readAuthority(this.storage);
      if (!current.ok) return current;
      let candidate = plan.candidate;
      let reconciliationRecovery = plan.reconciliationRecovery;
      let reconciliationRecoveryRecords = plan.reconciliationRecoveryRecords;
      const importedRecoveryRecords = plan.importedRecoveryRecords ?? [];
      const validatedImportedRecoveryRecords = serializeRecoveryRecords(importedRecoveryRecords);
      if (!validatedImportedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
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
      const mergedRecoveryRecords = mergeRecoveryRecords(current.value.authority.recoveryRecords, [
        ...importedRecoveryRecords,
        ...(reconciliationRecoveryRecords ?? []),
      ]);
      if (!mergedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
      return writeAuthority(this.storage, plan.expectedRaw, candidate, recovery, mergedRecoveryRecords.value);
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
      const current = readAuthority(this.storage);
      if (!current.ok) return current;
      const recovery = current.value.authority.recovery;
      if (recovery === undefined) return fail('EXPORT_FAILED');
      const validatedRecovery = validatePrivateState(recovery);
      if (!validatedRecovery.ok) return fail(mapStateError(validatedRecovery.error));
      const active = current.value.authority.active;
      let candidate = validatedRecovery.value;
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
      if (active === undefined || active.items.length === 0) {
        const mergedRecoveryRecords = mergeRecoveryRecords(
          current.value.authority.recoveryRecords,
          preservedRecoveryRecords,
        );
        if (!mergedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
        return promoteRecovery(
          this.storage,
          current.value.raw,
          candidate,
          preservedRecovery,
          mergedRecoveryRecords.value,
        );
      }
      if (preservedRecovery !== undefined) return fail('STATE_RECONCILIATION_BLOCKED');
      const mergedRecoveryRecords = mergeRecoveryRecords(
        current.value.authority.recoveryRecords,
        preservedRecoveryRecords,
      );
      if (!mergedRecoveryRecords.ok) return fail('STATE_RECONCILIATION_BLOCKED');
      return writeAuthority(
        this.storage,
        current.value.raw,
        candidate,
        preservedRecovery ?? active,
        mergedRecoveryRecords.value,
      );
    });
  }
}
