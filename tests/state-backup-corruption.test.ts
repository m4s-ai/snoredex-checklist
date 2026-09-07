import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecoveryRecordsBackup, PrivateStateLifecycle, createPortableBackup } from '../src/state/backup.ts';
import {
  PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY,
  PRIVATE_STATE_RECOVERY_RECORDS_QUARANTINE_STORAGE_KEY,
  PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY,
  PRIVATE_STATE_RECOVERY_STORAGE_KEY,
  PRIVATE_STATE_STORAGE_KEY,
  type StorageLike,
} from '../src/state/storage.ts';
import {
  PRIVATE_DATASET_ID,
  PRIVATE_STATE_SCHEMA,
  PRIVATE_STATE_VERSION,
  type PrivateState,
} from '../src/state/domain.ts';

const fingerprint = `sha256:${'a'.repeat(64)}`;
const otherFingerprint = `sha256:${'b'.repeat(64)}`;
const itemA = 'item-00000000-0000-0000-0000-00000000000a';
const knownItemIds = new Set([itemA]);
const appRevision = 'c'.repeat(40);
const exportedAt = '2026-08-26T10:00:00.000Z';

function state(note?: string): PrivateState {
  return {
    schema: PRIVATE_STATE_SCHEMA,
    schemaVersion: PRIVATE_STATE_VERSION,
    datasetId: PRIVATE_DATASET_ID,
    catalogueFingerprint: fingerprint,
    items: note === undefined ? [] : [{ itemId: itemA, status: 'have', quantityOwned: 2, quantityOrdered: 1, note }],
  };
}

class FakeStorage implements StorageLike {
  public values = new Map<string, string>();
  public withLock: StorageLike['withLock'] = async (callback) => callback();

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }
}

class FailAuthorityQuarantineStorage extends FakeStorage {
  public override setItem(key: string, value: string): void {
    if (key === PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY) {
      const error = new Error('quota');
      Object.defineProperty(error, 'name', { value: 'QuotaExceededError' });
      throw error;
    }
    super.setItem(key, value);
  }
}

function importedState(note = 'replacement') {
  return createPortableBackup(state(note), { appRevision, exportedAt });
}

test('reads and exports each authority component independently', () => {
  const storage = new FakeStorage();
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(state('active')));
  storage.values.set(PRIVATE_STATE_RECOVERY_STORAGE_KEY, '{broken-recovery');
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });

  const current = lifecycle.read();
  assert.equal(current.ok, true);
  if (!current.ok) return;
  assert.equal(current.value.active?.items[0]?.note, 'active');
  assert.equal(current.value.recovery, undefined);
  assert.equal(current.value.recoveryError, 'LOCAL_STATE_UNREADABLE');
  assert.equal(lifecycle.exportActive().ok, true);
  assert.deepEqual(lifecycle.exportRecovery(), { ok: false, error: 'LOCAL_STATE_UNREADABLE' });
});

test('imports over unreadable authority only after quarantining both original bytes', async () => {
  const storage = new FakeStorage();
  const brokenActive = '{broken-active';
  const brokenRecovery = '{broken-recovery';
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, brokenActive);
  storage.values.set(PRIVATE_STATE_RECOVERY_STORAGE_KEY, brokenRecovery);
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const imported = importedState();
  assert.equal(imported.ok, true);
  if (!imported.ok) return;

  const plan = lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.preview.mode, 'replace');
  const committed = await lifecycle.commitImport(plan.value, true);
  assert.equal(committed.ok, true);
  assert.equal(JSON.parse(storage.values.get(PRIVATE_STATE_STORAGE_KEY) ?? 'null').items[0].note, 'replacement');
  assert.deepEqual(JSON.parse(storage.values.get(PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY) ?? 'null'), {
    schema: 'snoredex-private-state-authority-quarantine',
    schemaVersion: 2,
    active: [brokenActive],
    recovery: [brokenRecovery],
  });
});

test('retains readable active state as recovery when only recovery is malformed', async () => {
  const storage = new FakeStorage();
  const brokenRecovery = '{broken-recovery';
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(state('old active')));
  storage.values.set(PRIVATE_STATE_RECOVERY_STORAGE_KEY, brokenRecovery);
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const imported = importedState();
  assert.equal(imported.ok, true);
  if (!imported.ok) return;

  const plan = lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const committed = await lifecycle.commitImport(plan.value, true);
  assert.equal(committed.ok, true);
  if (!committed.ok) return;
  assert.equal(committed.value.recovery?.items[0]?.note, 'old active');
  assert.deepEqual(JSON.parse(storage.values.get(PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY) ?? 'null').recovery, [
    brokenRecovery,
  ]);
});

test('quarantines malformed recovery bytes embedded in an authority envelope', async () => {
  const storage = new FakeStorage();
  const envelope = JSON.stringify({
    schema: 'snoredex-private-state-authority',
    schemaVersion: 1,
    active: state('old active'),
    recovery: '{invalid nested recovery}',
  });
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, envelope);
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const imported = importedState();
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const plan = lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  assert.equal((await lifecycle.commitImport(plan.value, true)).ok, true);
  const quarantine = JSON.parse(storage.values.get(PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY) ?? 'null');
  assert.deepEqual(quarantine.active, []);
  assert.deepEqual(quarantine.recovery, [envelope]);
});

test('repairs a JSON-valid envelope component with missing state metadata', async () => {
  const storage = new FakeStorage();
  const envelope = JSON.stringify({
    schema: 'snoredex-private-state-authority',
    schemaVersion: 1,
    active: state('old active'),
    recovery: {},
  });
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, envelope);
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const current = lifecycle.read();
  assert.equal(current.ok, true);
  if (!current.ok) return;
  assert.equal(current.value.recoveryError, 'LOCAL_STATE_UNREADABLE');
  const imported = importedState();
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const plan = lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal((await lifecycle.commitImport(plan.value, true)).ok, true);
  assert.deepEqual(JSON.parse(storage.values.get(PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY) ?? 'null').recovery, [
    envelope,
  ]);
});

test('rejects unsupported authority components instead of replacing them', () => {
  const storage = new FakeStorage();
  storage.values.set(
    PRIVATE_STATE_STORAGE_KEY,
    JSON.stringify({
      schema: 'snoredex-private-state-authority',
      schemaVersion: 1,
      active: { ...state('future'), schemaVersion: '999.0.0' },
      recovery: null,
    }),
  );
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const imported = importedState();
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  assert.deepEqual(lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds), {
    ok: false,
    error: 'LOCAL_STATE_UNSUPPORTED',
  });
  assert.equal(storage.values.has(PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY), false);
});

test('rejects unsupported recovery-ledger versions instead of repairing them', () => {
  const storage = new FakeStorage();
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(state('active')));
  storage.values.set(
    PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY,
    JSON.stringify({ schema: 'snoredex-private-state-recovery-records', schemaVersion: 999, records: [] }),
  );
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const imported = importedState();
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  assert.deepEqual(lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds), {
    ok: false,
    error: 'LOCAL_STATE_UNSUPPORTED',
  });
  assert.equal(storage.values.has(PRIVATE_STATE_RECOVERY_RECORDS_QUARANTINE_STORAGE_KEY), false);
});

test('rejects unsupported recovery-ledger schemas instead of repairing them', () => {
  const storage = new FakeStorage();
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(state('active')));
  storage.values.set(
    PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY,
    JSON.stringify({ schema: 'snoredex-private-state-recovery-records-v2', schemaVersion: 1, records: [] }),
  );
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const imported = importedState();
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  assert.deepEqual(lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds), {
    ok: false,
    error: 'LOCAL_STATE_UNSUPPORTED',
  });
  assert.equal(storage.values.has(PRIVATE_STATE_RECOVERY_RECORDS_QUARANTINE_STORAGE_KEY), false);
});

test('repairs wrong-typed recovery-ledger metadata as corruption', async () => {
  const storage = new FakeStorage();
  const malformedLedger = JSON.stringify({ schema: null, schemaVersion: '1', records: [] });
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(state('active')));
  storage.values.set(PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, malformedLedger);
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const imported = importedState();
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const plan = lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal((await lifecycle.commitImport(plan.value, true)).ok, true);
  assert.deepEqual(
    JSON.parse(storage.values.get(PRIVATE_STATE_RECOVERY_RECORDS_QUARANTINE_STORAGE_KEY) ?? 'null').entries,
    [malformedLedger],
  );
});

test('uses the normal merge path for a valid existing recovery ledger', async () => {
  const storage = new FakeStorage();
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(state('active')));
  const existing = {
    schema: 'snoredex-private-state-recovery-records',
    schemaVersion: 1,
    records: [
      {
        sourceFingerprint: fingerprint,
        item: { itemId: itemA, status: 'have', quantityOwned: 1, quantityOrdered: 0 },
        disposition: 'orphan',
      },
    ],
  };
  storage.values.set(PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY, JSON.stringify(existing));
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const imported = createRecoveryRecordsBackup([
    {
      sourceFingerprint: otherFingerprint,
      item: { itemId: itemA, status: 'have', quantityOwned: 2, quantityOrdered: 0 },
      disposition: 'orphan',
    },
  ]);
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const plan = lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const committed = await lifecycle.commitImport(plan.value, true);
  assert.equal(committed.ok, true);
  assert.equal(storage.values.has(PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY), false);
  assert.notEqual(storage.values.get(PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY), JSON.stringify(existing));
  assert.equal(storage.values.get(PRIVATE_STATE_RECOVERY_RECORDS_STORAGE_KEY)?.includes(otherFingerprint), true);
});

test('does not mutate malformed authority when quarantine cannot be written', async () => {
  const storage = new FailAuthorityQuarantineStorage();
  const brokenActive = '{broken-active';
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, brokenActive);
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const imported = importedState();
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const plan = lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  assert.deepEqual(await lifecycle.commitImport(plan.value, true), {
    ok: false,
    error: 'STORAGE_QUOTA_EXCEEDED',
  });
  assert.equal(storage.values.get(PRIVATE_STATE_STORAGE_KEY), brokenActive);
});

test('continues recovery after the same authority component corrupts again', async () => {
  const storage = new FakeStorage();
  const firstCorruption = '{first-broken-active';
  const secondCorruption = '{second-broken-active';
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, firstCorruption);
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const first = importedState('first repair');
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstPlan = lifecycle.prepareImport(first.value.bytes, fingerprint, knownItemIds);
  assert.equal(firstPlan.ok, true);
  if (!firstPlan.ok) return;
  assert.equal((await lifecycle.commitImport(firstPlan.value, true)).ok, true);

  storage.values.set(PRIVATE_STATE_STORAGE_KEY, secondCorruption);
  const second = importedState('second repair');
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const secondPlan = lifecycle.prepareImport(second.value.bytes, fingerprint, knownItemIds);
  assert.equal(secondPlan.ok, true);
  if (!secondPlan.ok) return;
  assert.equal((await lifecycle.commitImport(secondPlan.value, true)).ok, true);
  assert.deepEqual(JSON.parse(storage.values.get(PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY) ?? 'null').active, [
    firstCorruption,
    secondCorruption,
  ]);
});

test('reports invalid imports before reading a malformed local authority', () => {
  const storage = new FakeStorage();
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, '{broken-active');
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  assert.deepEqual(lifecycle.prepareImport(new TextEncoder().encode('{invalid'), fingerprint, knownItemIds), {
    ok: false,
    error: 'IMPORT_INVALID_JSON',
  });
});

test('restores valid recovery when active authority bytes are unreadable', async () => {
  const storage = new FakeStorage();
  const brokenActive = '{broken-active';
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, brokenActive);
  storage.values.set(PRIVATE_STATE_RECOVERY_STORAGE_KEY, JSON.stringify(state('recovery')));
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });

  const restored = await lifecycle.restore(true, fingerprint, knownItemIds);
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(restored.value.active?.items[0]?.note, 'recovery');
  assert.equal(restored.value.recovery, undefined);
  assert.deepEqual(JSON.parse(storage.values.get(PRIVATE_STATE_AUTHORITY_QUARANTINE_STORAGE_KEY) ?? 'null').active, [
    brokenActive,
  ]);
});
