import { readStateAuthority } from './authority.ts';
import { serializePrivateState, validatePrivateState, type PrivateState } from './domain.ts';
import { reconcilePrivateState, type ReconciliationContext, type ReconciliationSuccess } from './reconciliation.ts';
import {
  PRIVATE_STATE_RECOVERY_STORAGE_KEY,
  PRIVATE_STATE_STORAGE_KEY,
  getBrowserStorage,
  type StorageLike,
} from './storage.ts';

export interface BrowserReconciliationResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly error?: string;
}

interface AuthoritySnapshot {
  readonly raw: { readonly active: string | null; readonly recovery: string | null };
  readonly active: PrivateState | undefined;
  readonly recovery: PrivateState | undefined;
}

function readAuthority(
  storage: StorageLike,
): { readonly ok: true; readonly value: AuthoritySnapshot } | { readonly ok: false; readonly error: string } {
  try {
    const raw = {
      active: storage.getItem(PRIVATE_STATE_STORAGE_KEY),
      recovery: storage.getItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY),
    };
    const authority = readStateAuthority(raw.active, raw.recovery);
    if (!authority.ok) return authority;
    return { ok: true, value: { raw, active: authority.active, recovery: authority.recovery } };
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

function writeAuthority(
  storage: StorageLike,
  expected: AuthoritySnapshot['raw'],
  active: PrivateState,
  recovery: PrivateState | undefined,
): BrowserReconciliationResult {
  const current = readAuthority(storage);
  if (!current.ok) return { ok: false, changed: false, error: current.error };
  if (current.value.raw.active !== expected.active || current.value.raw.recovery !== expected.recovery) {
    return { ok: false, changed: false, error: 'STATE_CHANGED_DURING_OPERATION' };
  }
  const activeText = serialized(active);
  const recoveryText = serialized(recovery);
  if (activeText === undefined || recoveryText === undefined) {
    return { ok: false, changed: false, error: 'STATE_RECONCILIATION_BLOCKED' };
  }
  const recoveryChanged = recoveryText !== expected.recovery;
  try {
    if (recoveryChanged) {
      storage.setItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY, recoveryText);
      if (storage.getItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY) !== recoveryText) {
        restoreRaw(storage, PRIVATE_STATE_RECOVERY_STORAGE_KEY, expected.recovery);
        return { ok: false, changed: false, error: 'STORAGE_COMMIT_UNCERTAIN' };
      }
    }
    storage.setItem(PRIVATE_STATE_STORAGE_KEY, activeText);
  } catch {
    const restoredRecovery =
      !recoveryChanged || restoreRaw(storage, PRIVATE_STATE_RECOVERY_STORAGE_KEY, expected.recovery);
    const restoredActive = restoreRaw(storage, PRIVATE_STATE_STORAGE_KEY, expected.active);
    if (restoredRecovery && restoredActive) return { ok: false, changed: false, error: 'STORAGE_WRITE_FAILED' };
    return { ok: false, changed: false, error: 'STORAGE_COMMIT_UNCERTAIN' };
  }
  const after = readAuthority(storage);
  if (!after.ok || after.value.raw.active !== activeText || after.value.raw.recovery !== recoveryText) {
    const restoredRecovery =
      !recoveryChanged || restoreRaw(storage, PRIVATE_STATE_RECOVERY_STORAGE_KEY, expected.recovery);
    const restoredActive = restoreRaw(storage, PRIVATE_STATE_STORAGE_KEY, expected.active);
    if (restoredRecovery && restoredActive) return { ok: false, changed: false, error: 'STORAGE_WRITE_FAILED' };
    return { ok: false, changed: false, error: 'STORAGE_COMMIT_UNCERTAIN' };
  }
  return { ok: true, changed: true };
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
    const active = current.value.active;
    if (active === undefined) return { ok: true, changed: false };
    if (active.catalogueFingerprint === targetFingerprint) {
      const checked = validatePrivateState(active, knownItemIds);
      return checked.ok ? { ok: true, changed: false } : { ok: false, changed: false, error: 'LOCAL_STATE_UNREADABLE' };
    }
    const matchingRecovery = current.value.recovery;
    if (matchingRecovery?.catalogueFingerprint === targetFingerprint) {
      const checked = validatePrivateState(matchingRecovery, knownItemIds);
      if (!checked.ok) return { ok: false, changed: false, error: 'LOCAL_STATE_UNREADABLE' };
      // A rollback deploy targets the snapshot in the recovery slot. Swap it
      // into active while retaining the newer active state for a future roll-forward.
      return writeAuthority(storage.value, current.value.raw, matchingRecovery, active);
    }
    const result = reconcilePrivateState(active, targetFingerprint, {
      ...reconciliation,
      knownTargetItemIds: knownItemIds,
    });
    if (!result.ok) return { ok: false, changed: false, error: result.error };
    const recovery = preserveRecovery(active, result.value);
    // Each migration rotates the sidecar to the immediately previous active
    // snapshot.  Keeping an older recovery copy would block every later
    // catalogue adoption because there is only one rollback slot.
    return writeAuthority(storage.value, current.value.raw, result.value.state, recovery ?? current.value.recovery);
  });
}
