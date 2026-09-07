import {
  PRIVATE_DATASET_ID,
  PRIVATE_STATE_SCHEMA,
  PRIVATE_STATE_VERSION,
  validatePrivateState,
  type PrivateItemState,
} from './domain.ts';
import type { ReconciliationSuccess } from './reconciliation.ts';

export const PRIVATE_STATE_RECOVERY_RECORDS_SCHEMA = 'snoredex-private-state-recovery-records' as const;
export const PRIVATE_STATE_RECOVERY_RECORDS_VERSION = 1 as const;

export type RecoveryRecordDisposition = 'orphan' | 'conflict';

export interface DurableRecoveryRecord {
  readonly sourceFingerprint: string;
  readonly item: PrivateItemState;
  readonly disposition: RecoveryRecordDisposition;
}

export type RecoveryRecordsResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

interface RecoveryRecordsEnvelope {
  readonly schema: typeof PRIVATE_STATE_RECOVERY_RECORDS_SCHEMA;
  readonly schemaVersion: typeof PRIVATE_STATE_RECOVERY_RECORDS_VERSION;
  readonly records: readonly DurableRecoveryRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validDisposition(value: unknown): value is RecoveryRecordDisposition {
  return value === 'orphan' || value === 'conflict';
}

function validateItem(sourceFingerprint: unknown, value: unknown): PrivateItemState | undefined {
  if (typeof sourceFingerprint !== 'string' || !isRecord(value)) return undefined;
  const state = validatePrivateState({
    schema: PRIVATE_STATE_SCHEMA,
    schemaVersion: PRIVATE_STATE_VERSION,
    datasetId: PRIVATE_DATASET_ID,
    catalogueFingerprint: sourceFingerprint,
    items: [value],
  });
  if (!state.ok || state.value.items.length !== 1) return undefined;
  return state.value.items[0];
}

function compareRecords(left: DurableRecoveryRecord, right: DurableRecoveryRecord): number {
  if (left.sourceFingerprint !== right.sourceFingerprint) {
    return left.sourceFingerprint < right.sourceFingerprint ? -1 : 1;
  }
  if (left.item.itemId !== right.item.itemId) return left.item.itemId < right.item.itemId ? -1 : 1;
  return left.disposition < right.disposition ? -1 : left.disposition > right.disposition ? 1 : 0;
}

function recordKey(record: DurableRecoveryRecord): string {
  return `${record.sourceFingerprint}\u0000${record.item.itemId}`;
}

function sameRecord(left: DurableRecoveryRecord, right: DurableRecoveryRecord): boolean {
  return (
    left.sourceFingerprint === right.sourceFingerprint &&
    left.disposition === right.disposition &&
    left.item.itemId === right.item.itemId &&
    left.item.status === right.item.status &&
    left.item.quantityOwned === right.item.quantityOwned &&
    left.item.quantityOrdered === right.item.quantityOrdered &&
    left.item.note === right.item.note
  );
}

function canonicalRecords(
  records: readonly DurableRecoveryRecord[],
  options: { readonly rejectDuplicates?: boolean } = {},
): RecoveryRecordsResult<readonly DurableRecoveryRecord[]> {
  const byKey = new Map<string, DurableRecoveryRecord>();
  for (const candidate of records) {
    const item = validateItem(candidate.sourceFingerprint, candidate.item);
    if (item === undefined || !validDisposition(candidate.disposition)) return { ok: false };
    const normalized: DurableRecoveryRecord = {
      sourceFingerprint: candidate.sourceFingerprint,
      item: { ...item },
      disposition: candidate.disposition,
    };
    const key = recordKey(normalized);
    const previous = byKey.get(key);
    if (previous !== undefined) {
      if (!sameRecord(previous, normalized) || options.rejectDuplicates === true) return { ok: false };
      continue;
    }
    byKey.set(key, normalized);
  }
  return { ok: true, value: [...byKey.values()].sort(compareRecords) };
}

export function readRecoveryRecords(raw: string | null): RecoveryRecordsResult<readonly DurableRecoveryRecord[]> {
  if (raw === null) return { ok: true, value: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false };
  }
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ['schema', 'schemaVersion', 'records']) ||
    parsed.schema !== PRIVATE_STATE_RECOVERY_RECORDS_SCHEMA ||
    parsed.schemaVersion !== PRIVATE_STATE_RECOVERY_RECORDS_VERSION ||
    !Array.isArray(parsed.records)
  ) {
    return { ok: false };
  }
  const records: DurableRecoveryRecord[] = [];
  for (const candidate of parsed.records) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['sourceFingerprint', 'item', 'disposition'])) {
      return { ok: false };
    }
    const item = validateItem(candidate.sourceFingerprint, candidate.item);
    if (item === undefined || !validDisposition(candidate.disposition)) return { ok: false };
    records.push({
      sourceFingerprint: candidate.sourceFingerprint as string,
      item: { ...item },
      disposition: candidate.disposition,
    });
  }
  const canonical = canonicalRecords(records, { rejectDuplicates: true });
  if (!canonical.ok || canonical.value.length !== records.length) return { ok: false };
  return canonical;
}

export function serializeRecoveryRecords(
  records: readonly DurableRecoveryRecord[],
): RecoveryRecordsResult<string | null> {
  const canonical = canonicalRecords(records);
  if (!canonical.ok) return canonical;
  if (canonical.value.length === 0) return { ok: true, value: null };
  const envelope: RecoveryRecordsEnvelope = {
    schema: PRIVATE_STATE_RECOVERY_RECORDS_SCHEMA,
    schemaVersion: PRIVATE_STATE_RECOVERY_RECORDS_VERSION,
    records: canonical.value,
  };
  return { ok: true, value: `${JSON.stringify(envelope, null, 2)}\n` };
}

export function recoveryRecordsFromResult(
  sourceFingerprint: string,
  result: ReconciliationSuccess,
): RecoveryRecordsResult<readonly DurableRecoveryRecord[]> {
  return canonicalRecords([
    ...result.orphans.map((item) => ({ sourceFingerprint, item, disposition: 'orphan' as const })),
    ...result.conflicts.map((item) => ({ sourceFingerprint, item, disposition: 'conflict' as const })),
  ]);
}

export function mergeRecoveryRecords(
  existing: readonly DurableRecoveryRecord[],
  additions: readonly DurableRecoveryRecord[],
): RecoveryRecordsResult<readonly DurableRecoveryRecord[]> {
  return canonicalRecords([...existing, ...additions]);
}

/** Replace an existing local record only when a newer local reconciliation produced it. */
export function updateRecoveryRecords(
  existing: readonly DurableRecoveryRecord[],
  updates: readonly DurableRecoveryRecord[],
  sourceFingerprint?: string,
): RecoveryRecordsResult<readonly DurableRecoveryRecord[]> {
  const current = canonicalRecords(existing, { rejectDuplicates: true });
  const next = canonicalRecords(updates, { rejectDuplicates: true });
  if (!current.ok || !next.ok) return { ok: false };
  const byKey = new Map(
    current.value
      .filter((record) => sourceFingerprint === undefined || record.sourceFingerprint !== sourceFingerprint)
      .map((record) => [recordKey(record), record]),
  );
  for (const record of next.value) byKey.set(recordKey(record), record);
  return { ok: true, value: [...byKey.values()].sort(compareRecords) };
}
