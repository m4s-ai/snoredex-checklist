import assert from 'node:assert/strict';
import test from 'node:test';
import { readPrivateState } from '../src/site/private-state.ts';

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const ITEM_ID = 'item-a';
const envelope = {
  schema: 'snoredex-collection-state',
  schemaVersion: '1.0.0',
  datasetId: 'snoredex-data/snorlax-current-known',
} as const;

async function withStorage<T>(raw: string | null, callback: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (): string | null => raw },
  });
  try {
    return await callback();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
    else Object.defineProperty(globalThis, 'localStorage', previous);
  }
}

test('defers malformed private storage', async () => {
  const state = await withStorage('malformed', () =>
    readPrivateState(FINGERPRINT, new Set([ITEM_ID]), () => ({ ok: false, error: 'LOCAL_STATE_UNREADABLE' })),
  );
  assert.equal(state.readable, false);
  assert.equal(state.hasActiveState, false);
  assert.equal(state.statuses.size, 0);
});

test('defers a private state from another catalogue fingerprint', async () => {
  const state = await withStorage('stale', () =>
    readPrivateState(FINGERPRINT, new Set([ITEM_ID]), () => ({
      ok: true,
      recovery: undefined,
      enveloped: false,
      active: { ...envelope, catalogueFingerprint: 'sha256:stale', items: [] },
    })),
  );
  assert.equal(state.readable, false);
  assert.equal(state.hasActiveState, true);
  assert.equal(state.statuses.size, 0);
});

test('defers private state containing an unknown item ID', async () => {
  const state = await withStorage('orphan', () =>
    readPrivateState(FINGERPRINT, new Set([ITEM_ID]), () => ({
      ok: true,
      recovery: undefined,
      enveloped: false,
      active: {
        ...envelope,
        catalogueFingerprint: FINGERPRINT,
        items: [
          { itemId: ITEM_ID, status: 'have', quantityOwned: 1, quantityOrdered: 0 },
          { itemId: 'orphan', status: 'ordered', quantityOwned: 0, quantityOrdered: 1 },
        ],
      },
    })),
  );
  assert.equal(state.readable, false);
  assert.equal(state.hasActiveState, true);
  assert.equal(state.statuses.size, 0);
});

test('projects valid private state statuses', async () => {
  const state = await withStorage('valid', () =>
    readPrivateState(FINGERPRINT, new Set([ITEM_ID]), () => ({
      ok: true,
      recovery: undefined,
      enveloped: false,
      active: {
        ...envelope,
        catalogueFingerprint: FINGERPRINT,
        items: [{ itemId: ITEM_ID, status: 'have', quantityOwned: 1, quantityOrdered: 0 }],
      },
    })),
  );
  assert.equal(state.readable, true);
  assert.equal(state.hasActiveState, true);
  assert.equal(state.statuses.get(ITEM_ID), 'have');
});
