import { readStateAuthority } from './authority.ts';
import { serializePrivateState, validatePrivateState, type PrivateState } from './domain.ts';
import {
  reconcilePrivateState,
  type ReconciliationContext,
  type ReconciliationMigration,
  type ReconciliationSuccess,
} from './reconciliation.ts';
import {
  PRIVATE_STATE_RECOVERY_STORAGE_KEY,
  PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY,
  PRIVATE_STATE_STORAGE_KEY,
  getBrowserStorage,
  type StorageLike,
} from './storage.ts';
import {
  mergeRecoveryRecords,
  readRecoveryRecords,
  recoveryRecordsFromResult,
  serializeRecoveryRecords,
  type DurableRecoveryRecord,
  updateRecoveryRecords,
} from './recovery-records.ts';

export interface BrowserReconciliationResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly error?: string;
}

interface AuthoritySnapshot {
  readonly raw: {
    readonly active: string | null;
    readonly recovery: string | null;
    readonly recoveryRecords: string | null;
  };
  readonly active: PrivateState | undefined;
  readonly recovery: PrivateState | undefined;
  readonly recoveryRecords: readonly DurableRecoveryRecord[];
}

function readAuthority(
  storage: StorageLike,
): { readonly ok: true; readonly value: AuthoritySnapshot } | { readonly ok: false; readonly error: string } {
  try {
    const raw = {
      active: storage.getItem(PRIVATE_STATE_STORAGE_KEY),
      recovery: storage.getItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY),
      recoveryRecords: storage.getItem(PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY),
    };
    const authority = readStateAuthority(raw.active, raw.recovery);
    if (!authority.ok) return authority;
    const recoveryRecords = readRecoveryRecords(raw.recoveryRecords);
    if (!recoveryRecords.ok) return { ok: false, error: 'LOCAL_STATE_UNREADABLE' };
    return {
      ok: true,
      value: { raw, active: authority.active, recovery: authority.recovery, recoveryRecords: recoveryRecords.value },
    };
  } catch {
    return { ok: false, error: 'LOCAL_STATE_UNREADABLE' };
  }
}

function serialized(value: PrivateState | undefined): string | undefined {
  if (value === undefined) return 'null';
  const result = serializePrivateState(value);
  return result.ok ? result.value : undefined;
}

function restoreRaw(storage: StorageLike, key: string, value: string | null): boolean {
  try {
    if (value === null) storage.removeItem?.(key);
    else storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch {
    return false;
  }
}

function preserveRecovery(source: PrivateState, _result: ReconciliationSuccess): PrivateState {
  // Keep the complete source snapshot so a rollback build can restore even
  // records that were successfully retained or rekeyed in the new state.
  return { ...source, items: source.items.map((item) => ({ ...item })) };
}

function migrationEntries(reconciliation: ReconciliationContext): readonly ReconciliationMigration[] {
  const source = reconciliation.migrations as unknown;
  if (Array.isArray(source)) return source as readonly ReconciliationMigration[];
  if (typeof source !== 'object' || source === null) return [];
  const routes = (source as { readonly catalogueTransitions?: unknown }).catalogueTransitions;
  return Array.isArray(routes) ? (routes as readonly ReconciliationMigration[]) : [];
}

function hasMigrationPath(
  reconciliation: ReconciliationContext,
  fromFingerprint: string,
  toFingerprint: string,
): boolean {
  if (fromFingerprint === toFingerprint) return true;
  const nextBySource = new Map<string, string[]>();
  for (const migration of migrationEntries(reconciliation)) {
    if (typeof migration.fromFingerprint !== 'string' || typeof migration.toFingerprint !== 'string') continue;
    const next = nextBySource.get(migration.fromFingerprint) ?? [];
    next.push(migration.toFingerprint);
    nextBySource.set(migration.fromFingerprint, next);
  }
  const queue = [fromFingerprint];
  const seen = new Set(queue);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const next of nextBySource.get(current) ?? []) {
      if (next === toFingerprint) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

function isMissingRecoveryRecords(raw: string | null): boolean {
  return raw === null || raw.trim() === '' || raw.trim() === 'null';
}

function writeAuthority(
  storage: StorageLike,
  expected: AuthoritySnapshot['raw'],
  active: PrivateState,
  recovery: PrivateState | undefined,
  recoveryRecords: readonly DurableRecoveryRecord[],
): BrowserReconciliationResult {
  const current = readAuthority(storage);
  if (!current.ok) return { ok: false, changed: false, error: current.error };
  if (
    current.value.raw.active !== expected.active ||
    current.value.raw.recovery !== expected.recovery ||
    current.value.raw.recoveryRecords !== expected.recoveryRecords
  ) {
    return { ok: false, changed: false, error: 'STATE_CHANGED_DURING_OPERATION' };
  }
  const activeText = serialized(active);
  const recoveryText = serialized(recovery);
  const recoveryRecordsText = serializeRecoveryRecords(recoveryRecords);
  if (activeText === undefined || recoveryText === undefined || !recoveryRecordsText.ok) {
    return { ok: false, changed: false, error: 'STATE_RECONCILIATION_BLOCKED' };
  }
  const recoveryChanged = recoveryText !== expected.recovery;
  const recoveryRecordsChanged = recoveryRecordsText.value !== expected.recoveryRecords;
  const restoreRecoveryRecords = (): boolean =>
    restoreRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, expected.recoveryRecords);
  try {
    if (recoveryRecordsChanged) {
      if (!restoreRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, recoveryRecordsText.value)) {
        restoreRaw(storage, PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, expected.recoveryRecords);
        return { ok: false, changed: false, error: 'STORAGE_COMMIT_UNCERTAIN' };
      }
    }
    if (recoveryChanged) {
      storage.setItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY, recoveryText);
      if (storage.getItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY) !== recoveryText) {
        restoreRaw(storage, PRIVATE_STATE_RECOVERY_STORAGE_KEY, expected.recovery);
        if (recoveryRecordsChanged) restoreRecoveryRecords();
        return { ok: false, changed: false, error: 'STORAGE_COMMIT_UNCERTAIN' };
      }
    }
    storage.setItem(PRIVATE_STATE_STORAGE_KEY, activeText);
  } catch {
    const restoredRecovery =
      !recoveryChanged || restoreRaw(storage, PRIVATE_STATE_RECOVERY_STORAGE_KEY, expected.recovery);
    const restoredRecords = !recoveryRecordsChanged || restoreRecoveryRecords();
    const restoredActive = restoreRaw(storage, PRIVATE_STATE_STORAGE_KEY, expected.active);
    if (restoredRecovery && restoredRecords && restoredActive)
      return { ok: false, changed: false, error: 'STORAGE_WRITE_FAILED' };
    return { ok: false, changed: false, error: 'STORAGE_COMMIT_UNCERTAIN' };
  }
  const after = readAuthority(storage);
  if (
    !after.ok ||
    after.value.raw.active !== activeText ||
    after.value.raw.recovery !== recoveryText ||
    after.value.raw.recoveryRecords !== recoveryRecordsText.value
  ) {
    const restoredRecovery =
      !recoveryChanged || restoreRaw(storage, PRIVATE_STATE_RECOVERY_STORAGE_KEY, expected.recovery);
    const restoredRecords = !recoveryRecordsChanged || restoreRecoveryRecords();
    const restoredActive = restoreRaw(storage, PRIVATE_STATE_STORAGE_KEY, expected.active);
    if (restoredRecovery && restoredRecords && restoredActive)
      return { ok: false, changed: false, error: 'STORAGE_WRITE_FAILED' };
    return { ok: false, changed: false, error: 'STORAGE_COMMIT_UNCERTAIN' };
  }
  return { ok: true, changed: true };
}

function seedLegacyRecoveryRecords(
  storage: StorageLike,
  current: AuthoritySnapshot,
  reconciliation: ReconciliationContext,
):
  | { readonly ok: true; readonly value: { readonly authority: AuthoritySnapshot; readonly changed: boolean } }
  | { readonly ok: false; readonly error: string } {
  const active = current.active;
  const recovery = current.recovery;
  if (
    !isMissingRecoveryRecords(current.raw.recoveryRecords) ||
    active === undefined ||
    recovery === undefined ||
    recovery.catalogueFingerprint === active.catalogueFingerprint ||
    !hasMigrationPath(reconciliation, recovery.catalogueFingerprint, active.catalogueFingerprint)
  ) {
    return { ok: true, value: { authority: current, changed: false } };
  }
  const historicalContext: ReconciliationContext = {
    migrations: reconciliation.migrations,
    ...(reconciliation.knownSourceItemIdsByFingerprint === undefined
      ? {}
      : { knownSourceItemIdsByFingerprint: reconciliation.knownSourceItemIdsByFingerprint }),
  };
  const migrated = reconcilePrivateState(recovery, active.catalogueFingerprint, historicalContext);
  if (!migrated.ok) return { ok: false, error: migrated.error };
  const additions = recoveryRecordsFromResult(recovery.catalogueFingerprint, migrated.value);
  if (!additions.ok) return { ok: false, error: 'STATE_RECONCILIATION_BLOCKED' };
  const merged = mergeRecoveryRecords(current.recoveryRecords, additions.value);
  if (!merged.ok) return { ok: false, error: 'STATE_RECONCILIATION_BLOCKED' };
  if (merged.value.length === current.recoveryRecords.length) {
    return { ok: true, value: { authority: current, changed: false } };
  }
  const written = writeAuthority(storage, current.raw, active, recovery, merged.value);
  if (!written.ok) return { ok: false, error: written.error ?? 'STORAGE_COMMIT_UNCERTAIN' };
  const after = readAuthority(storage);
  if (!after.ok) return after;
  return { ok: true, value: { authority: after.value, changed: true } };
}

async function exclusive<T>(storage: StorageLike, callback: () => T): Promise<T> {
  if (storage.withLock === undefined) return callback();
  return storage.withLock(async () => callback());
}

/** Apply producer-reviewed catalogue transitions before the new state is used. */
export async function reconcileBrowserState(
  targetFingerprint: string,
  knownItemIds: ReadonlySet<string>,
  reconciliation: ReconciliationContext,
): Promise<BrowserReconciliationResult> {
  const storage = getBrowserStorage();
  if (!storage.ok) return { ok: false, changed: false, error: storage.error };
  return exclusive(storage.value, () => {
    const current = readAuthority(storage.value);
    if (!current.ok) return { ok: false, changed: false, error: current.error };
    const seeded = seedLegacyRecoveryRecords(storage.value, current.value, reconciliation);
    if (!seeded.ok) return { ok: false, changed: false, error: seeded.error };
    const authority = seeded.value.authority;
    const seededChanged = seeded.value.changed;
    const active = authority.active;
    if (active === undefined) return { ok: true, changed: seededChanged };
    if (active.catalogueFingerprint === targetFingerprint) {
      const checked = validatePrivateState(active, knownItemIds);
      return checked.ok
        ? { ok: true, changed: seededChanged }
        : { ok: false, changed: false, error: 'LOCAL_STATE_UNREADABLE' };
    }
    const matchingRecovery = authority.recovery;
    if (matchingRecovery?.catalogueFingerprint === targetFingerprint) {
      const checked = validatePrivateState(matchingRecovery, knownItemIds);
      if (!checked.ok) return { ok: false, changed: false, error: 'LOCAL_STATE_UNREADABLE' };
      if (hasMigrationPath(reconciliation, active.catalogueFingerprint, targetFingerprint)) {
        const reconciled = reconcilePrivateState(active, targetFingerprint, {
          ...reconciliation,
          knownTargetItemIds: knownItemIds,
        });
        if (!reconciled.ok) return { ok: false, changed: false, error: reconciled.error };
        const reconciledText = serialized(reconciled.value.state);
        const recoveryText = serialized(matchingRecovery);
        if (reconciledText === undefined || recoveryText === undefined) {
          return { ok: false, changed: false, error: 'STATE_RECONCILIATION_BLOCKED' };
        }
        if (reconciledText !== recoveryText) {
          return { ok: false, changed: false, error: 'STATE_RECONCILIATION_CONFLICT' };
        }
        const additions = recoveryRecordsFromResult(active.catalogueFingerprint, reconciled.value);
        if (!additions.ok) return { ok: false, changed: false, error: 'STATE_RECONCILIATION_BLOCKED' };
        const mergedRecords = updateRecoveryRecords(authority.recoveryRecords, additions.value);
        if (!mergedRecords.ok) return { ok: false, changed: false, error: 'STATE_RECONCILIATION_BLOCKED' };
        return writeAuthority(storage.value, authority.raw, matchingRecovery, active, mergedRecords.value);
      }
      // A rollback deploy targets the snapshot in the recovery slot. Swap it
      // into active while retaining the newer active state for a future roll-forward.
      // When a migration route exists, the active state is reconciled first so
      // edits made during rollback cannot be silently discarded.
      return writeAuthority(storage.value, authority.raw, matchingRecovery, active, authority.recoveryRecords);
    }
    const result = reconcilePrivateState(active, targetFingerprint, {
      ...reconciliation,
      knownTargetItemIds: knownItemIds,
    });
    if (!result.ok) return { ok: false, changed: false, error: result.error };
    const recovery = preserveRecovery(active, result.value);
    const additions = recoveryRecordsFromResult(active.catalogueFingerprint, result.value);
    if (!additions.ok) return { ok: false, changed: false, error: 'STATE_RECONCILIATION_BLOCKED' };
    const mergedRecords = mergeRecoveryRecords(authority.recoveryRecords, additions.value);
    if (!mergedRecords.ok) return { ok: false, changed: false, error: 'STATE_RECONCILIATION_BLOCKED' };
    // Each migration rotates the sidecar to the immediately previous active
    // snapshot.  Keeping an older recovery copy would block every later
    // catalogue adoption because there is only one rollback slot.
    return writeAuthority(
      storage.value,
      authority.raw,
      result.value.state,
      recovery ?? authority.recovery,
      mergedRecords.value,
    );
  });
}
