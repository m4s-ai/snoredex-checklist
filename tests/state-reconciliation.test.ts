import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reconcilePrivateState,
  type ReconciliationMigration,
  type ReconciliationTransition,
} from '../src/state/reconciliation.ts';
import {
  PRIVATE_DATASET_ID,
  PRIVATE_STATE_SCHEMA,
  PRIVATE_STATE_VERSION,
  type PrivateState,
} from '../src/state/domain.ts';
import { reconcileBrowserState } from '../src/state/browser-reconciliation.ts';
import {
  OrderedStateStore,
  PRIVATE_STATE_RECOVERY_STORAGE_KEY,
  PRIVATE_STATE_STORAGE_KEY,
} from '../src/state/storage.ts';

const oldFingerprint = `sha256:${'a'.repeat(64)}`;
const middleFingerprint = `sha256:${'b'.repeat(64)}`;
const targetFingerprint = `sha256:${'c'.repeat(64)}`;
const oldA = 'item-10000000-0000-5000-8000-000000000001';
const oldB = 'item-10000000-0000-5000-8000-000000000002';
const oldC = 'item-10000000-0000-5000-8000-000000000003';
const targetA = 'item-00000000-0000-5000-8000-000000000001';
const targetB = 'item-00000000-0000-5000-8000-000000000002';
const targetC = 'item-00000000-0000-5000-8000-000000000003';

function state(fingerprint = oldFingerprint, items: PrivateState['items'] = []): PrivateState {
  return {
    schema: PRIVATE_STATE_SCHEMA,
    schemaVersion: PRIVATE_STATE_VERSION,
    datasetId: PRIVATE_DATASET_ID,
    catalogueFingerprint: fingerprint,
    items,
  };
}

class FakeBrowserLocalStorage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
}

function transition(
  fromItemId: string,
  toItemIds: readonly string[],
  changeKind: string,
  automaticStateAction: string,
  reconciliation: string,
  fromItemIds?: readonly string[],
): ReconciliationTransition {
  return { fromItemId, fromItemIds, toItemIds, changeKind, automaticStateAction, reconciliation };
}

function migration(
  fromFingerprint: string,
  toFingerprint: string,
  transitions: readonly ReconciliationTransition[],
): ReconciliationMigration {
  return { fromFingerprint, toFingerprint, transitions };
}

test('reconciles retained and explicit one-to-one state without mutation', () => {
  const source = state(oldFingerprint, [
    { itemId: oldA, status: 'have', quantityOwned: 2, quantityOrdered: 0, note: 'private' },
  ]);
  const result = reconcilePrivateState(source, targetFingerprint, {
    migrations: [
      migration(oldFingerprint, targetFingerprint, [
        transition(oldA, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
    ],
    knownSourceItemIds: new Set([oldA]),
    knownTargetItemIds: new Set([targetA]),
    targetItemClasses: new Map([
      [targetA, 'current-known'],
      [targetB, 'research'],
    ]),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(source.items[0], {
    itemId: oldA,
    status: 'have',
    quantityOwned: 2,
    quantityOrdered: 0,
    note: 'private',
  });
  assert.deepEqual(result.value.state.items, [
    { itemId: targetA, status: 'have', quantityOwned: 2, quantityOrdered: 0, note: 'private' },
  ]);
  assert.deepEqual(result.value.report.accounting, {
    oldExplicitRecords: 1,
    retained: 0,
    migrated: 1,
    retiredOrphans: 0,
    conflicts: 0,
    unresolved: 0,
    newCurrentKnown: 0,
    newResearch: 1,
    accountedOldRecords: 1,
    conservationSatisfied: true,
  });
  assert.equal(JSON.stringify(result.value.report).includes('private'), false);
});

test('counts catalogue targets independently of private holdings', () => {
  const result = reconcilePrivateState(
    state(oldFingerprint, [
      {
        itemId: oldA,
        status: 'have',
        quantityOwned: 1,
        quantityOrdered: 0,
      },
    ]),
    targetFingerprint,
    {
      migrations: [
        migration(oldFingerprint, targetFingerprint, [
          transition(oldA, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
          transition(oldB, [targetB], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
      ],
      knownSourceItemIds: new Set([oldA, oldB]),
      knownTargetItemIds: new Set([targetA, targetB, targetC]),
      targetItemClasses: new Map([
        [targetA, 'current-known'],
        [targetB, 'current-known'],
        [targetC, 'research'],
      ]),
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.report.accounting.newCurrentKnown, 0);
  assert.equal(result.value.report.accounting.newResearch, 1);
});

test('blocks a migration that omits a source-catalogue item', () => {
  const result = reconcilePrivateState(state(), targetFingerprint, {
    migrations: [
      migration(oldFingerprint, targetFingerprint, [
        transition(oldA, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
    ],
    knownSourceItemIds: new Set([oldA, oldB]),
    knownTargetItemIds: new Set([targetA]),
  });
  assert.deepEqual(result, { ok: false, error: 'STATE_RECONCILIATION_BLOCKED' });
});

test('counts only targets reachable from the original catalogue', () => {
  const middleA = 'item-00000000-0000-5000-8000-000000000011';
  const middleNew = 'item-00000000-0000-5000-8000-000000000012';
  const finalA = 'item-00000000-0000-5000-8000-000000000013';
  const finalNew = 'item-00000000-0000-5000-8000-000000000014';
  const result = reconcilePrivateState(
    state(oldFingerprint, [
      {
        itemId: oldA,
        status: 'have',
        quantityOwned: 1,
        quantityOrdered: 0,
      },
    ]),
    targetFingerprint,
    {
      migrations: [
        migration(oldFingerprint, middleFingerprint, [
          transition(oldA, [middleA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
        migration(middleFingerprint, targetFingerprint, [
          transition(middleA, [finalA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
          transition(middleNew, [finalNew], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
      ],
      knownSourceItemIds: new Set([oldA]),
      knownTargetItemIds: new Set([finalA, finalNew, targetC]),
      targetItemClasses: new Map([
        [finalA, 'current-known'],
        [finalNew, 'current-known'],
        [targetC, 'research'],
      ]),
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.report.accounting.newCurrentKnown, 1);
  assert.equal(result.value.report.accounting.newResearch, 1);
});

test('counts mixed-source merge targets as mapped when one source is original', () => {
  const middleA = 'item-00000000-0000-5000-8000-000000000021';
  const middleNew = 'item-00000000-0000-5000-8000-000000000022';
  const finalMerge = 'item-00000000-0000-5000-8000-000000000023';
  const result = reconcilePrivateState(state(), targetFingerprint, {
    migrations: [
      migration(oldFingerprint, middleFingerprint, [
        transition(oldA, [middleA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
      migration(middleFingerprint, targetFingerprint, [
        transition(middleA, [finalMerge], 'merge-N:1', 'none', 'requires-user-resolution', [middleA, middleNew]),
      ]),
    ],
    knownSourceItemIds: new Set([oldA]),
    knownTargetItemIds: new Set([finalMerge]),
    targetItemClasses: new Map([[finalMerge, 'current-known']]),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.report.accounting.newCurrentKnown, 0);
});

test('preserves retired records as private orphan candidates', () => {
  const result = reconcilePrivateState(
    state(oldFingerprint, [{ itemId: oldA, status: 'skip', quantityOwned: 0, quantityOrdered: 0 }]),
    targetFingerprint,
    {
      migrations: [
        migration(oldFingerprint, targetFingerprint, [transition(oldA, [], 'retired-1:0', 'none', 'retire-to-orphan')]),
      ],
      knownSourceItemIds: new Set([oldA]),
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.state.items, []);
  assert.deepEqual(result.value.orphans, [{ itemId: oldA, status: 'skip', quantityOwned: 0, quantityOrdered: 0 }]);
  assert.equal(result.value.report.accounting.retiredOrphans, 1);
});

test('preserves the original identity through a multi-step retired chain', () => {
  const source = state(oldFingerprint, [
    { itemId: oldA, status: 'have', quantityOwned: 2, quantityOrdered: 0, note: 'private' },
  ]);
  const result = reconcilePrivateState(source, targetFingerprint, {
    migrations: [
      migration(oldFingerprint, middleFingerprint, [
        transition(oldA, [oldB], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
      migration(middleFingerprint, targetFingerprint, [
        transition(oldB, [], 'retired-1:0', 'none', 'retire-to-orphan'),
      ]),
    ],
    knownSourceItemIds: new Set([oldA]),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.orphans, [
    {
      itemId: oldA,
      status: 'have',
      quantityOwned: 2,
      quantityOrdered: 0,
      note: 'private',
    },
  ]);
  assert.deepEqual(result.value.report.records, [
    {
      fromItemIds: [oldA],
      toItemIds: [],
      changeKind: 'retired-1:0',
      automaticStateAction: 'none',
      resolution: 'retire-to-orphan',
      disposition: 'orphan',
    },
  ]);
});

test('preserves the source disposition through a rekey then retained chain', () => {
  const source = state(oldFingerprint, [{ itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0 }]);
  const result = reconcilePrivateState(source, targetFingerprint, {
    migrations: [
      migration(oldFingerprint, middleFingerprint, [
        transition(oldA, [oldB], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
      migration(middleFingerprint, targetFingerprint, [
        transition(oldB, [oldB], 'retained', 'preserve', 'identity-retained'),
      ]),
    ],
    knownSourceItemIds: new Set([oldA]),
    knownTargetItemIds: new Set([oldB]),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.report.records, [
    {
      fromItemIds: [oldA],
      toItemIds: [oldB],
      changeKind: 'rekey-1:1',
      automaticStateAction: 'preserve',
      resolution: 'one-to-one-preserve',
      disposition: 'migrated',
    },
  ]);
  assert.equal(result.value.report.accounting.retained, 0);
  assert.equal(result.value.report.accounting.migrated, 1);
});

test('fails closed for split, merge, unresolved and unaccounted records', () => {
  const split = reconcilePrivateState(
    state(oldFingerprint, [{ itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0 }]),
    targetFingerprint,
    {
      migrations: [
        migration(oldFingerprint, targetFingerprint, [
          transition(oldA, [targetA, targetB], 'split-1:N', 'none', 'requires-user-resolution'),
        ]),
      ],
      knownSourceItemIds: new Set([oldA]),
    },
  );
  assert.deepEqual(split, {
    ok: false,
    error: 'STATE_RECONCILIATION_BLOCKED',
    report: split.ok ? undefined : split.report,
  });
  assert.equal(split.ok, false);

  const merge = reconcilePrivateState(
    state(oldFingerprint, [
      { itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0 },
      { itemId: oldB, status: 'have', quantityOwned: 1, quantityOrdered: 0 },
    ]),
    targetFingerprint,
    {
      migrations: [
        migration(oldFingerprint, targetFingerprint, [
          transition(oldA, [targetA], 'merge-N:1', 'none', 'requires-user-resolution', [oldA, oldB]),
        ]),
      ],
      knownSourceItemIds: new Set([oldA, oldB]),
    },
  );
  assert.equal(merge.ok, false);
  if (!merge.ok) {
    assert.equal(merge.error, 'STATE_RECONCILIATION_BLOCKED');
    assert.equal(merge.report?.accounting.conflicts, 2);
    assert.equal(merge.report?.accounting.conservationSatisfied, true);
    assert.equal(merge.report?.records[0]?.disposition, 'orphan-and-conflict');
  }

  const unaccounted = reconcilePrivateState(
    state(oldFingerprint, [{ itemId: oldC, status: 'skip', quantityOwned: 0, quantityOrdered: 0 }]),
    targetFingerprint,
    {
      migrations: [
        migration(oldFingerprint, targetFingerprint, [
          transition(oldA, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
      ],
    },
  );
  assert.equal(unaccounted.ok, false);
  if (!unaccounted.ok) assert.equal(unaccounted.error, 'STATE_RECONCILIATION_BLOCKED');
});

test('reports original IDs for chained merge conflicts', () => {
  const middleA = 'item-00000000-0000-5000-8000-000000000011';
  const middleB = 'item-00000000-0000-5000-8000-000000000012';
  const source = state(oldFingerprint, [
    { itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0 },
    { itemId: oldB, status: 'ordered', quantityOwned: 0, quantityOrdered: 2 },
  ]);
  const result = reconcilePrivateState(source, targetFingerprint, {
    migrations: [
      migration(oldFingerprint, middleFingerprint, [
        transition(oldA, [middleA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        transition(oldB, [middleB], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
      migration(middleFingerprint, targetFingerprint, [
        transition(middleA, [targetC], 'merge-N:1', 'none', 'requires-user-resolution', [middleA, middleB]),
      ]),
    ],
    knownSourceItemIds: new Set([oldA, oldB]),
    knownTargetItemIds: new Set([targetC]),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.report?.records.map((record) => record.fromItemIds),
    [[oldA], [oldB]],
  );
  assert.deepEqual(
    result.report?.records.map((record) => record.toItemIds),
    [[targetC], [targetC]],
  );
  assert.deepEqual(
    result.report?.records.map((record) => record.disposition),
    ['orphan-and-conflict', 'orphan-and-conflict'],
  );
  assert.equal(result.report?.records.length, 2);
  assert.equal(result.report?.accounting.conflicts, 2);
  assert.equal(result.report?.accounting.conservationSatisfied, true);
  assert.equal(result.report?.accounting.unresolved, 2);
  assert.equal(result.report?.accounting.accountedOldRecords, 2);
  assert.equal(result.report?.accounting.newCurrentKnown, 0);
  assert.equal(result.report?.accounting.newResearch, 0);
});

test('rejects unknown, future and incomplete chains before mutation', () => {
  const unsupported = reconcilePrivateState(
    state(oldFingerprint, [{ itemId: oldA, status: 'skip', quantityOwned: 0, quantityOrdered: 0 }]),
    targetFingerprint,
    {
      migrations: [],
    },
  );
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) {
    assert.equal(unsupported.error, 'STATE_FINGERPRINT_UNSUPPORTED');
    assert.equal(unsupported.report?.records.length, 1);
    assert.equal(unsupported.report?.accounting.conservationSatisfied, true);
  }

  const malformed = reconcilePrivateState(state(oldFingerprint), targetFingerprint, {
    migrations: [
      migration(oldFingerprint, targetFingerprint, [
        {
          fromItemId: oldA,
          toItemIds: [targetA],
          changeKind: 'future-change',
          automaticStateAction: 'preserve',
          reconciliation: 'one-to-one-preserve',
        },
      ]),
    ],
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error, 'STATE_RECONCILIATION_BLOCKED');

  const manifest = {
    meta: { fromFingerprint: oldFingerprint, toFingerprint: targetFingerprint },
    catalogueTransitions: [
      migration(oldFingerprint, targetFingerprint, [
        transition(oldA, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
    ],
  };
  const acceptedManifest = reconcilePrivateState(
    state(oldFingerprint, [{ itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0 }]),
    targetFingerprint,
    {
      migrations: manifest,
      knownSourceItemIds: new Set([oldA]),
      knownTargetItemIds: new Set([targetA]),
    },
  );
  assert.equal(acceptedManifest.ok, true);

  const skewedManifest = {
    ...manifest,
    meta: { fromFingerprint: middleFingerprint, toFingerprint: targetFingerprint },
  };
  const rejectedManifest = reconcilePrivateState(
    state(oldFingerprint, [{ itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0 }]),
    targetFingerprint,
    {
      migrations: skewedManifest,
      knownTargetItemIds: new Set([targetA]),
    },
  );
  assert.deepEqual(rejectedManifest, { ok: false, error: 'STATE_RECONCILIATION_BLOCKED' });

  const hiddenDanglingTarget = reconcilePrivateState(
    state(oldFingerprint, [{ itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0 }]),
    targetFingerprint,
    {
      migrations: [
        migration(oldFingerprint, targetFingerprint, [
          transition(oldA, [targetA], 'retained', 'preserve', 'identity-retained'),
          transition(oldB, [targetB], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
      ],
      knownTargetItemIds: new Set([targetA]),
    },
  );
  assert.deepEqual(hiddenDanglingTarget, { ok: false, error: 'STATE_RECONCILIATION_BLOCKED' });

  const researchTarget = reconcilePrivateState(
    state(oldFingerprint, [{ itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0 }]),
    targetFingerprint,
    {
      migrations: [
        migration(oldFingerprint, targetFingerprint, [
          transition(oldA, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
      ],
      knownTargetItemIds: new Set([targetA]),
      targetItemClasses: new Map([[targetA, 'research']]),
    },
  );
  assert.deepEqual(researchTarget, { ok: false, error: 'STATE_RECONCILIATION_BLOCKED' });

  const missingTargetClass = reconcilePrivateState(
    state(oldFingerprint, [{ itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0 }]),
    targetFingerprint,
    {
      migrations: [
        migration(oldFingerprint, targetFingerprint, [
          transition(oldA, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
      ],
      knownTargetItemIds: new Set([targetA]),
      targetItemClasses: new Map(),
    },
  );
  assert.deepEqual(missingTargetClass, { ok: false, error: 'STATE_RECONCILIATION_BLOCKED' });

  const brokenIntermediateLink = reconcilePrivateState(state(oldFingerprint), targetFingerprint, {
    migrations: [
      migration(oldFingerprint, middleFingerprint, [
        transition(oldA, [oldB], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
      migration(middleFingerprint, targetFingerprint, [
        transition(oldC, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
    ],
    knownTargetItemIds: new Set([targetA]),
  });
  assert.deepEqual(brokenIntermediateLink, { ok: false, error: 'STATE_RECONCILIATION_BLOCKED' });

  const mismatchedRetained = reconcilePrivateState(
    state(oldFingerprint, [{ itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0 }]),
    targetFingerprint,
    {
      migrations: [
        migration(oldFingerprint, targetFingerprint, [
          transition(oldA, [targetA], 'retained', 'preserve', 'identity-retained'),
        ]),
      ],
    },
  );
  assert.equal(mismatchedRetained.ok, false);
  if (!mismatchedRetained.ok) assert.equal(mismatchedRetained.error, 'STATE_RECONCILIATION_BLOCKED');

  const crossedRetainedMetadata = reconcilePrivateState(state(oldFingerprint), targetFingerprint, {
    migrations: [
      migration(oldFingerprint, targetFingerprint, [
        transition(oldA, [oldA], 'retained', 'preserve', 'one-to-one-preserve'),
      ]),
    ],
  });
  assert.equal(crossedRetainedMetadata.ok, false);
  if (!crossedRetainedMetadata.ok) assert.equal(crossedRetainedMetadata.error, 'STATE_RECONCILIATION_BLOCKED');

  const crossedRekeyMetadata = reconcilePrivateState(state(oldFingerprint), targetFingerprint, {
    migrations: [
      migration(oldFingerprint, targetFingerprint, [
        transition(oldA, [targetA], 'rekey-1:1', 'preserve', 'identity-retained'),
      ]),
    ],
  });
  assert.equal(crossedRekeyMetadata.ok, false);
  if (!crossedRekeyMetadata.ok) assert.equal(crossedRekeyMetadata.error, 'STATE_RECONCILIATION_BLOCKED');

  const malformedSplitMetadata = reconcilePrivateState(state(oldFingerprint), targetFingerprint, {
    migrations: [
      migration(oldFingerprint, targetFingerprint, [
        transition(oldA, [targetA, targetB], 'split-1:N', 'none', 'one-to-one-preserve'),
      ]),
    ],
  });
  assert.equal(malformedSplitMetadata.ok, false);
  if (!malformedSplitMetadata.ok) assert.equal(malformedSplitMetadata.error, 'STATE_RECONCILIATION_BLOCKED');

  const malformedMergeMetadata = reconcilePrivateState(state(oldFingerprint), targetFingerprint, {
    migrations: [
      migration(oldFingerprint, targetFingerprint, [
        transition(oldA, [targetA], 'merge-N:1', 'none', 'identity-retained', [oldA, oldB]),
      ]),
    ],
  });
  assert.equal(malformedMergeMetadata.ok, false);
  if (!malformedMergeMetadata.ok) assert.equal(malformedMergeMetadata.error, 'STATE_RECONCILIATION_BLOCKED');

  const malformedUnresolvedMetadata = reconcilePrivateState(state(oldFingerprint), targetFingerprint, {
    migrations: [
      migration(oldFingerprint, targetFingerprint, [transition(oldA, [], 'unresolved', 'none', 'retire-to-orphan')]),
    ],
  });
  assert.equal(malformedUnresolvedMetadata.ok, false);
  if (!malformedUnresolvedMetadata.ok) assert.equal(malformedUnresolvedMetadata.error, 'STATE_RECONCILIATION_BLOCKED');

  const ambiguous = reconcilePrivateState(
    state(oldFingerprint, [{ itemId: oldA, status: 'skip', quantityOwned: 0, quantityOrdered: 0 }]),
    targetFingerprint,
    {
      migrations: [
        migration(oldFingerprint, targetFingerprint, [
          transition(oldA, [oldA], 'retained', 'preserve', 'identity-retained'),
        ]),
        migration(oldFingerprint, middleFingerprint, [
          transition(oldA, [oldB], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
        migration(middleFingerprint, targetFingerprint, [
          transition(oldB, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
      ],
      knownTargetItemIds: new Set([oldA, targetA]),
    },
  );
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) {
    assert.equal(ambiguous.error, 'STATE_RECONCILIATION_BLOCKED');
    assert.equal(ambiguous.report?.records.length, 1);
    assert.equal(ambiguous.report?.accounting.conservationSatisfied, true);
  }

  const emptyStep = reconcilePrivateState(state(oldFingerprint), targetFingerprint, {
    migrations: [{ fromFingerprint: oldFingerprint, toFingerprint: targetFingerprint, transitions: [] }],
  });
  assert.deepEqual(emptyStep, { ok: false, error: 'STATE_RECONCILIATION_BLOCKED' });
});

test('follows a deterministic multi-step chain and is idempotent', () => {
  const source = state(oldFingerprint, [{ itemId: oldA, status: 'ordered', quantityOwned: 0, quantityOrdered: 3 }]);
  const context = {
    migrations: [
      migration(oldFingerprint, middleFingerprint, [
        transition(oldA, [oldB], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
      migration(middleFingerprint, targetFingerprint, [
        transition(oldB, [targetC], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
    ],
    knownSourceItemIds: new Set([oldA]),
    knownTargetItemIds: new Set([targetC]),
  };
  const first = reconcilePrivateState(source, targetFingerprint, context);
  const second = reconcilePrivateState(source, targetFingerprint, context);
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  if (first.ok)
    assert.deepEqual(first.value.state.items, [
      { itemId: targetC, status: 'ordered', quantityOwned: 0, quantityOrdered: 3 },
    ]);
});

test('selects source membership for the stored fingerprint from cumulative manifests', () => {
  const source = state(oldFingerprint, [{ itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0 }]);
  const result = reconcilePrivateState(source, targetFingerprint, {
    migrations: [
      migration(oldFingerprint, targetFingerprint, [
        transition(oldA, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
      migration(middleFingerprint, targetFingerprint, [
        transition(oldB, [targetB], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
      ]),
    ],
    knownSourceItemIdsByFingerprint: new Map([
      [oldFingerprint, new Set([oldA])],
      [middleFingerprint, new Set([oldB])],
    ]),
    knownTargetItemIds: new Set([targetA]),
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.state.items[0]?.itemId, targetA);
});

test('browser migration rotates an existing recovery snapshot', async () => {
  const storage = new FakeBrowserLocalStorage();
  storage.setItem(
    PRIVATE_STATE_STORAGE_KEY,
    JSON.stringify(
      state(oldFingerprint, [{ itemId: oldA, status: 'have', quantityOwned: 2, quantityOrdered: 1, note: 'active' }]),
    ),
  );
  storage.setItem(
    PRIVATE_STATE_RECOVERY_STORAGE_KEY,
    JSON.stringify(
      state(oldFingerprint, [
        { itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0, note: 'stale recovery' },
      ]),
    ),
  );
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name: string, callback: () => Promise<unknown>) => callback() } },
  });
  try {
    const result = await reconcileBrowserState(targetFingerprint, new Set([targetA]), {
      knownSourceItemIds: new Set([oldA]),
      migrations: [
        migration(oldFingerprint, targetFingerprint, [
          transition(oldA, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
      ],
    });
    assert.deepEqual(result, { ok: true, changed: true });
    const active = JSON.parse(storage.getItem(PRIVATE_STATE_STORAGE_KEY) ?? 'null') as PrivateState;
    const recovery = JSON.parse(storage.getItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY) ?? 'null') as PrivateState;
    assert.equal(active.catalogueFingerprint, targetFingerprint);
    assert.equal(recovery.items[0]?.note, 'active');
  } finally {
    if (localStorageDescriptor === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
    if (navigatorDescriptor === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  }
});

test('browser rollback restores matching recovery while preserving newer active state', async () => {
  const storage = new FakeBrowserLocalStorage();
  storage.setItem(
    PRIVATE_STATE_STORAGE_KEY,
    JSON.stringify(
      state(targetFingerprint, [
        { itemId: targetA, status: 'have', quantityOwned: 2, quantityOrdered: 1, note: 'newer active' },
      ]),
    ),
  );
  storage.setItem(
    PRIVATE_STATE_RECOVERY_STORAGE_KEY,
    JSON.stringify(
      state(oldFingerprint, [
        { itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0, note: 'rollback snapshot' },
      ]),
    ),
  );
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name: string, callback: () => Promise<unknown>) => callback() } },
  });
  try {
    const result = await reconcileBrowserState(oldFingerprint, new Set([oldA]), {
      knownSourceItemIds: new Set([oldA]),
      migrations: [],
    });
    assert.deepEqual(result, { ok: true, changed: true });
    const active = JSON.parse(storage.getItem(PRIVATE_STATE_STORAGE_KEY) ?? 'null') as PrivateState;
    const recovery = JSON.parse(storage.getItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY) ?? 'null') as PrivateState;
    assert.equal(active.catalogueFingerprint, oldFingerprint);
    assert.equal(active.items[0]?.note, 'rollback snapshot');
    assert.equal(recovery.catalogueFingerprint, targetFingerprint);
    assert.equal(recovery.items[0]?.note, 'newer active');
  } finally {
    if (localStorageDescriptor === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
    if (navigatorDescriptor === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  }
});

test('browser rollback blocks when edits diverge from the matching recovery', async () => {
  const storage = new FakeBrowserLocalStorage();
  storage.setItem(
    PRIVATE_STATE_STORAGE_KEY,
    JSON.stringify(
      state(oldFingerprint, [
        { itemId: oldA, status: 'have', quantityOwned: 1, quantityOrdered: 0, note: 'edited during rollback' },
      ]),
    ),
  );
  const recovery = state(targetFingerprint, [
    { itemId: targetC, status: 'have', quantityOwned: 1, quantityOrdered: 0, note: 'newer active' },
  ]);
  storage.setItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY, JSON.stringify(recovery));
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: { request: async (_name: string, callback: () => Promise<unknown>) => callback() } },
  });
  const beforeActive = storage.getItem(PRIVATE_STATE_STORAGE_KEY);
  const beforeRecovery = storage.getItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY);
  try {
    const result = await reconcileBrowserState(targetFingerprint, new Set([targetC]), {
      knownSourceItemIds: new Set([oldA]),
      migrations: [
        migration(oldFingerprint, middleFingerprint, [
          transition(oldA, [oldB], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
        migration(middleFingerprint, targetFingerprint, [
          transition(oldB, [targetC], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
      ],
    });
    assert.deepEqual(result, { ok: false, changed: false, error: 'STATE_RECONCILIATION_CONFLICT' });
    assert.equal(storage.getItem(PRIVATE_STATE_STORAGE_KEY), beforeActive);
    assert.equal(storage.getItem(PRIVATE_STATE_RECOVERY_STORAGE_KEY), beforeRecovery);
  } finally {
    if (localStorageDescriptor === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
    if (navigatorDescriptor === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  }
});

test('reconciles a pending note draft before validating the target fingerprint', () => {
  const storage = {
    getItem: (_key: string): string | null => null,
    setItem: (_key: string, _value: string): void => undefined,
    removeItem: (_key: string): void => undefined,
  };
  const store = new OrderedStateStore(storage);
  const source = state(oldFingerprint, [
    { itemId: oldA, status: 'need', quantityOwned: 0, quantityOrdered: 0, note: 'pending source' },
  ]);
  const targetFingerprint = `sha256:${'d'.repeat(64)}`;
  store.scheduleNoteSave(source, false);
  assert.deepEqual(
    store.reconcileUnsavedDraft(targetFingerprint, new Set([targetA]), {
      knownSourceItemIds: new Set([oldA]),
      migrations: [
        migration(oldFingerprint, targetFingerprint, [
          transition(oldA, [targetA], 'rekey-1:1', 'preserve', 'one-to-one-preserve'),
        ]),
      ],
    }),
    { ok: true, value: undefined },
  );
  const draft = store.unsaved();
  assert.equal(draft?.catalogueFingerprint, targetFingerprint);
  assert.equal(draft?.items[0]?.itemId, targetA);
  assert.equal(draft?.items[0]?.note, 'pending source');
});
