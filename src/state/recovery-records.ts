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

function canonicalRecords(
  records: readonly DurableRecoveryRecord[],
): RecoveryRecordsResult<readonly DurableRecoveryRecord[]> {
  const byKey = new Map<string, DurableRecoveryRecord>();
  for (const candidate of records) {
    const item = validateItem(candidate.sourceFingerprint, candidate.item);
    if (item === undefined || !validDisposition(candidate.disposition)) return { ok: false };
    byKey.set(recordKey(candidate), {
      sourceFingerprint: candidate.sourceFingerprint,
      item: { ...item },
      disposition: candidate.disposition,
    });
  }
  return { ok: true, value: [...byKey.values()].sort(compareRecords) };
}

export function readRecoveryRecords(raw: string | null): RecoveryRecordsResult<readonly DurableRecoveryRecord[]> {
  if (raw === null || raw.trim() === '' || raw.trim() === 'null') return { ok: true, value: [] };
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
  const canonical = canonicalRecords(records);
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
