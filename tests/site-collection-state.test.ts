import assert from 'node:assert/strict';
import test from 'node:test';
import { applyNoteEdit, applyQuantityEdit, applyStatusCommand } from '../src/state/domain.ts';
import { BrowserCollectionStateController, type PrivateItemState } from '../src/site/collection-state.ts';

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const ITEM_A = 'item-00000000-0000-0000-0000-00000000000a';
const ITEM_B = 'item-00000000-0000-0000-0000-00000000000b';

type SaveOutcome =
  | { readonly ok: true; readonly value: { readonly skipped?: boolean } }
  | { readonly ok: false; readonly error: string };

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

type Store = ConstructorParameters<typeof BrowserCollectionStateController>[0];
type Domain = ConstructorParameters<typeof BrowserCollectionStateController>[1];

interface Harness {
  readonly controller: BrowserCollectionStateController;
  readonly immediateSaves: Array<ReturnType<typeof deferred<SaveOutcome>>>;
  readonly noteSaves: Array<ReturnType<typeof deferred<SaveOutcome>>>;
  readonly submittedStates: Array<readonly PrivateItemState[]>;
}

function makeHarness(options?: {
  readonly active?: readonly PrivateItemState[];
  readonly recovery?: readonly PrivateItemState[];
  readonly scheduleResults?: Array<{ readonly ok: boolean; readonly error?: string }>;
}): Harness {
  const immediateSaves: Array<ReturnType<typeof deferred<SaveOutcome>>> = [];
  const noteSaves: Array<ReturnType<typeof deferred<SaveOutcome>>> = [];
  const submittedStates: Array<readonly PrivateItemState[]> = [];
  let pendingNote = false;
  let recovery = options?.recovery;
  const scheduleResults = [...(options?.scheduleResults ?? [])];
  const store = {
    read: () => ({ ok: true, value: undefined }),
    unsaved: () =>
      recovery === undefined
        ? undefined
        : {
            schema: 'snoredex-collection-state' as const,
            schemaVersion: '1.0.0' as const,
            datasetId: 'snoredex-data/snorlax-current-known' as const,
            catalogueFingerprint: FINGERPRINT,
            items: recovery,
          },
    adoptUnsavedDraft: () => ({ ok: true, value: store.unsaved() }),
    discardUnsavedDraft: () => {
      recovery = undefined;
    },
    hasPendingNote: () => pendingNote,
    saveImmediate: (state: { readonly items: readonly PrivateItemState[] }) => {
      pendingNote = false;
      submittedStates.push(state.items);
      const save = deferred<SaveOutcome>();
      immediateSaves.push(save);
      return save.promise;
    },
    scheduleNoteSave: (state: { readonly items: readonly PrivateItemState[] }) => {
      pendingNote = true;
      submittedStates.push(state.items);
      const result = scheduleResults.shift();
      return result?.ok === false
        ? { ok: false, error: result.error ?? 'STORAGE_WRITE_FAILED' }
        : { ok: true, value: undefined };
    },
    flushNote: () => {
      pendingNote = false;
      const save = deferred<SaveOutcome>();
      noteSaves.push(save);
      return save.promise;
    },
  } as Store;
  const active =
    options?.active === undefined
      ? undefined
      : {
          schema: 'snoredex-collection-state' as const,
          schemaVersion: '1.0.0' as const,
          datasetId: 'snoredex-data/snorlax-current-known' as const,
          catalogueFingerprint: FINGERPRINT,
          items: options.active,
        };
  const controller = new BrowserCollectionStateController(
    store,
    { applyStatusCommand, applyQuantityEdit, applyNoteEdit } as Domain,
    1_000,
    FINGERPRINT,
    active,
  );
  return { controller, immediateSaves, noteSaves, submittedStates };
}

const saved: SaveOutcome = { ok: true, value: {} };

test('keeps quantity validation as a field draft transition matrix', () => {
  const { controller } = makeHarness();
  const cases = [
    { owned: '', ordered: '0', invalid: ['owned'] },
    { owned: '-1', ordered: '0', invalid: ['owned'] },
    { owned: '0', ordered: '10000', invalid: ['ordered'] },
    { owned: '1.5', ordered: '0', invalid: ['owned'] },
    { owned: '9999', ordered: '0', invalid: [] },
  ] as const;

  for (const entry of cases) {
    controller.setQuantityDraft(ITEM_A, entry.owned, entry.ordered);
    const snapshot = controller.item(ITEM_A);
    assert.equal(snapshot.quantityOwned, entry.owned);
    assert.equal(snapshot.quantityOrdered, entry.ordered);
    assert.deepEqual(snapshot.invalidQuantityFields, entry.invalid);
    assert.equal(snapshot.validationError, entry.invalid.length === 0 ? undefined : 'EDIT_INVALID_QUANTITY');
    assert.equal(snapshot.save.phase, 'dirty');
  }
});

test('does not republish unchanged validation during blur', async () => {
  const { controller } = makeHarness();
  controller.setQuantityDraft(ITEM_A, '10000', '0');
  let notifications = 0;
  controller.onChange(() => notifications++);

  assert.deepEqual(await controller.commitQuantities(ITEM_A), { ok: false, error: 'EDIT_INVALID_QUANTITY' });
  assert.equal(notifications, 0);
});

test('moves a valid quantity through dirty, saving, and saved with a confirmed snapshot', async () => {
  const { controller, immediateSaves } = makeHarness();
  controller.setQuantityDraft(ITEM_A, '5', '0');
  assert.equal(controller.item(ITEM_A).save.phase, 'dirty');

  const commit = controller.commitQuantities(ITEM_A);
  assert.equal(controller.item(ITEM_A).save.phase, 'saving');
  immediateSaves[0].resolve(saved);
  assert.deepEqual(await commit, { ok: true, skipped: undefined });

  const snapshot = controller.item(ITEM_A);
  assert.equal(snapshot.save.phase, 'saved');
  assert.equal(snapshot.confirmed?.quantityOwned, 5);
  assert.equal(snapshot.confirmed?.status, 'have');
  assert.equal(controller.state.statuses.get(ITEM_A), 'have');
});

test('canonicalizes equivalent quantity drafts on no-op and persisted commits', async () => {
  const unchanged = makeHarness({
    active: [{ itemId: ITEM_A, status: 'have', quantityOwned: 1, quantityOrdered: 0 }],
  });
  unchanged.controller.setQuantityDraft(ITEM_A, '01', '0');
  assert.deepEqual(await unchanged.controller.commitQuantities(ITEM_A), { ok: true, skipped: true });
  assert.equal(unchanged.controller.item(ITEM_A).quantityOwned, '1');
  assert.equal(unchanged.controller.item(ITEM_A).save.phase, 'clean');
  assert.equal(unchanged.immediateSaves.length, 0);

  const changed = makeHarness();
  changed.controller.setQuantityDraft(ITEM_A, '1e2', '0');
  const commit = changed.controller.commitQuantities(ITEM_A);
  assert.equal(changed.controller.item(ITEM_A).quantityOwned, '100');
  assert.equal(changed.controller.item(ITEM_A).save.phase, 'saving');
  changed.immediateSaves[0].resolve(saved);
  await commit;
  assert.equal(changed.controller.item(ITEM_A).quantityOwned, '100');
  assert.equal(changed.controller.item(ITEM_A).save.phase, 'saved');
});

test('keeps an invalid quantity visible while an independent status save succeeds', async () => {
  const { controller, immediateSaves } = makeHarness();
  controller.setQuantityDraft(ITEM_A, '1123123123', '0');

  const status = controller.setStatus(ITEM_A, 'have');
  immediateSaves[0].resolve(saved);
  await status;

  const snapshot = controller.item(ITEM_A);
  assert.equal(snapshot.quantityOwned, '1123123123');
  assert.equal(snapshot.validationError, 'EDIT_INVALID_QUANTITY');
  assert.equal(snapshot.status, 'have');
  assert.equal(snapshot.confirmed?.status, 'have');
  assert.equal(snapshot.confirmed?.quantityOwned, 1);
  assert.equal(snapshot.save.phase, 'dirty');
});

test('preserves a failed draft and retries the current complete state', async () => {
  const { controller, immediateSaves, submittedStates } = makeHarness();
  const first = controller.setStatus(ITEM_A, 'have');
  immediateSaves[0].resolve({ ok: false, error: 'STORAGE_WRITE_FAILED' });
  await first;

  assert.equal(controller.item(ITEM_A).save.phase, 'failed');
  assert.equal(controller.item(ITEM_A).confirmed, undefined);
  const retry = controller.retry(ITEM_A);
  assert.equal(controller.item(ITEM_A).save.phase, 'saving');
  immediateSaves[1].resolve(saved);
  await retry;

  assert.equal(controller.item(ITEM_A).save.phase, 'saved');
  assert.equal(controller.item(ITEM_A).confirmed?.status, 'have');
  assert.equal(submittedStates.at(-1)?.find((record) => record.itemId === ITEM_A)?.status, 'have');
});

test('retries the current status unless a quantity draft changed', async () => {
  const unchanged = makeHarness();
  const skipped = unchanged.controller.setStatus(ITEM_A, 'skip');
  unchanged.immediateSaves[0].resolve({ ok: false, error: 'STORAGE_WRITE_FAILED' });
  await skipped;

  const retrySkip = unchanged.controller.retry(ITEM_A);
  assert.equal(unchanged.submittedStates.at(-1)?.find((record) => record.itemId === ITEM_A)?.status, 'skip');
  unchanged.immediateSaves[1].resolve(saved);
  await retrySkip;
  assert.equal(unchanged.controller.item(ITEM_A).confirmed?.status, 'skip');

  const changed = makeHarness();
  const failedSkip = changed.controller.setStatus(ITEM_A, 'skip');
  changed.immediateSaves[0].resolve({ ok: false, error: 'STORAGE_WRITE_FAILED' });
  await failedSkip;
  changed.controller.setQuantityDraft(ITEM_A, '02', '0');

  const retryQuantity = changed.controller.retry(ITEM_A);
  const submitted = changed.submittedStates.at(-1)?.find((record) => record.itemId === ITEM_A);
  assert.equal(submitted?.status, 'have');
  assert.equal(submitted?.quantityOwned, 2);
  assert.equal(changed.controller.item(ITEM_A).quantityOwned, '2');
  changed.immediateSaves[1].resolve(saved);
  await retryQuantity;
  assert.equal(changed.controller.item(ITEM_A).confirmed?.status, 'have');
});

test('rejects stale completion after a newer revision settles', async () => {
  const { controller, immediateSaves } = makeHarness();
  const older = controller.setStatus(ITEM_A, 'have');
  const newer = controller.setStatus(ITEM_A, 'skip');

  immediateSaves[1].resolve(saved);
  await newer;
  immediateSaves[0].resolve({ ok: false, error: 'STORAGE_WRITE_FAILED' });
  await older;

  const snapshot = controller.item(ITEM_A);
  assert.equal(snapshot.status, 'skip');
  assert.equal(snapshot.confirmed?.status, 'skip');
  assert.equal(snapshot.save.phase, 'saved');
  assert.equal(snapshot.save.error, undefined);
});

test('lets one encompassing save settle failed owners across cards', async () => {
  const { controller, immediateSaves } = makeHarness();
  const first = controller.setStatus(ITEM_A, 'have');
  immediateSaves[0].resolve({ ok: false, error: 'STORAGE_WRITE_FAILED' });
  await first;
  assert.equal(controller.item(ITEM_A).save.phase, 'failed');

  const second = controller.setStatus(ITEM_B, 'ordered');
  immediateSaves[1].resolve(saved);
  await second;

  assert.equal(controller.item(ITEM_A).save.phase, 'saved');
  assert.equal(controller.item(ITEM_A).confirmed?.status, 'have');
  assert.equal(controller.item(ITEM_B).confirmed?.status, 'ordered');
});

test('keeps a note failure recoverable while quantity validation changes', async () => {
  const { controller, immediateSaves, noteSaves } = makeHarness();
  assert.deepEqual(controller.scheduleNote(ITEM_A, 'private note'), { ok: true });
  const flush = controller.flushNote();
  noteSaves[0].resolve({ ok: false, error: 'STORAGE_WRITE_FAILED' });
  await flush;
  controller.setQuantityDraft(ITEM_A, '10000', '0');

  let snapshot = controller.item(ITEM_A);
  assert.equal(snapshot.validationError, 'EDIT_INVALID_QUANTITY');
  assert.equal(snapshot.save.phase, 'failed');
  assert.equal(snapshot.save.retryable, true);

  const retry = controller.retry(ITEM_A);
  immediateSaves[0].resolve(saved);
  await retry;
  snapshot = controller.item(ITEM_A);
  assert.equal(snapshot.validationError, 'EDIT_INVALID_QUANTITY');
  assert.equal(snapshot.save.error, undefined);
  assert.equal(snapshot.confirmed?.note, 'private note');
});

test('lets a later complete save recover a synchronous note-draft failure', async () => {
  const { controller, immediateSaves } = makeHarness({
    scheduleResults: [{ ok: false, error: 'STORAGE_WRITE_FAILED' }],
  });
  assert.deepEqual(controller.scheduleNote(ITEM_A, 'private note'), {
    ok: false,
    error: 'STORAGE_WRITE_FAILED',
  });
  assert.equal(controller.item(ITEM_A).save.phase, 'failed');

  const save = controller.setStatus(ITEM_B, 'have');
  immediateSaves[0].resolve(saved);
  await save;

  assert.equal(controller.item(ITEM_A).save.phase, 'saved');
  assert.equal(controller.item(ITEM_A).confirmed?.note, 'private note');
});

test('does not resurrect an older note failure after a newer note succeeds', async () => {
  const { controller, noteSaves } = makeHarness();
  controller.scheduleNote(ITEM_A, 'first');
  const first = controller.flushNote();
  controller.scheduleNote(ITEM_A, 'second');
  const second = controller.flushNote();

  noteSaves[1].resolve(saved);
  await second;
  noteSaves[0].resolve({ ok: false, error: 'STORAGE_WRITE_FAILED' });
  await first;

  const snapshot = controller.item(ITEM_A);
  assert.equal(snapshot.note, 'second');
  assert.equal(snapshot.confirmed?.note, 'second');
  assert.equal(snapshot.save.phase, 'saved');
});

test('keeps a raw note draft until its normalized value is saved', async () => {
  const { controller, noteSaves } = makeHarness({
    active: [{ itemId: ITEM_A, status: 'need', quantityOwned: 0, quantityOrdered: 0, note: 'old' }],
  });

  controller.scheduleNote(ITEM_A, '');
  assert.equal(controller.item(ITEM_A).note, '');
  controller.scheduleNote(ITEM_A, ' ');
  assert.equal(controller.item(ITEM_A).note, ' ');
  controller.scheduleNote(ITEM_A, '  first\nsecond');
  assert.equal(controller.item(ITEM_A).note, '  first\nsecond');

  const flush = controller.flushNote();
  noteSaves[0].resolve(saved);
  await flush;

  const snapshot = controller.item(ITEM_A);
  assert.equal(snapshot.note, '  first\nsecond');
  assert.equal(snapshot.confirmed?.note, '  first\nsecond');
  assert.equal(snapshot.save.phase, 'saved');
});

test('serializes normal edits behind a pending recovery decision and adoption', async () => {
  const recovered = { itemId: ITEM_A, status: 'have' as const, quantityOwned: 2, quantityOrdered: 0 };
  const { controller, immediateSaves } = makeHarness({ recovery: [recovered] });

  assert.equal(controller.item(ITEM_A).editingBlocked, true);
  assert.deepEqual(await controller.setStatus(ITEM_B, 'ordered'), {
    ok: false,
    error: 'RECOVERY_DECISION_REQUIRED',
  });
  assert.equal(immediateSaves.length, 0);

  const adoption = controller.adoptRecovery();
  assert.deepEqual(await controller.setStatus(ITEM_B, 'ordered'), {
    ok: false,
    error: 'RECOVERY_DECISION_REQUIRED',
  });
  assert.deepEqual(controller.discardRecovery(), { ok: false, error: 'RECOVERY_ACTION_PENDING' });
  assert.deepEqual(await controller.adoptRecovery(), { ok: false, error: 'RECOVERY_ACTION_PENDING' });
  assert.equal(immediateSaves.length, 1);
  immediateSaves[0].resolve(saved);
  await adoption;

  assert.equal(controller.recovery, undefined);
  assert.equal(controller.item(ITEM_A).editingBlocked, false);
  assert.deepEqual(controller.item(ITEM_A).confirmed, recovered);
  const edit = controller.setStatus(ITEM_B, 'ordered');
  assert.equal(immediateSaves.length, 2);
  immediateSaves[1].resolve(saved);
  await edit;
  assert.equal(controller.item(ITEM_B).confirmed?.status, 'ordered');
});

test('latches an uncertain recovery adoption until reload', async () => {
  const recovered = { itemId: ITEM_A, status: 'have' as const, quantityOwned: 2, quantityOrdered: 0 };
  const { controller, immediateSaves } = makeHarness({ recovery: [recovered] });

  const adoption = controller.adoptRecovery();
  immediateSaves[0].resolve({ ok: false, error: 'STORAGE_COMMIT_UNCERTAIN' });
  assert.deepEqual(await adoption, { ok: false, error: 'STORAGE_COMMIT_UNCERTAIN' });

  assert.equal(controller.item(ITEM_A).save.phase, 'conflict');
  assert.equal(controller.item(ITEM_A).editingBlocked, true);
  assert.deepEqual(controller.discardRecovery(), { ok: false, error: 'STORAGE_COMMIT_UNCERTAIN' });
  assert.deepEqual(await controller.setStatus(ITEM_B, 'ordered'), {
    ok: false,
    error: 'STORAGE_COMMIT_UNCERTAIN',
  });
  assert.equal(immediateSaves.length, 1);
});

test('latches synchronous note staging uncertainty before any flush or retry', async () => {
  const { controller, immediateSaves, noteSaves, submittedStates } = makeHarness({
    scheduleResults: [{ ok: false, error: 'STORAGE_COMMIT_UNCERTAIN' }],
  });
  controller.item(ITEM_B);
  const notifications: Array<string | undefined> = [];
  controller.onChange((itemId) => notifications.push(itemId));

  assert.deepEqual(controller.scheduleNote(ITEM_A, 'local draft'), {
    ok: false,
    error: 'STORAGE_COMMIT_UNCERTAIN',
  });
  assert.equal(notifications.at(-1), undefined);
  assert.equal(controller.item(ITEM_A).note, 'local draft');
  assert.equal(controller.item(ITEM_A).save.phase, 'conflict');
  assert.equal(controller.item(ITEM_B).save.phase, 'conflict');
  assert.deepEqual(await controller.flushNote(), { ok: false, error: 'STORAGE_COMMIT_UNCERTAIN' });
  assert.deepEqual(await controller.setStatus(ITEM_B, 'ordered'), {
    ok: false,
    error: 'STORAGE_COMMIT_UNCERTAIN',
  });
  assert.equal(immediateSaves.length, 0);
  assert.equal(noteSaves.length, 0);
  assert.equal(submittedStates.length, 1);
});

test('treats commit uncertainty as reload-only recovery', async () => {
  const { controller, immediateSaves, submittedStates } = makeHarness();
  controller.item(ITEM_B);
  const notifications: Array<string | undefined> = [];
  controller.onChange((itemId) => notifications.push(itemId));
  const save = controller.setStatus(ITEM_A, 'have');
  immediateSaves[0].resolve({ ok: false, error: 'STORAGE_COMMIT_UNCERTAIN' });
  await save;
  assert.equal(notifications.at(-1), undefined);

  const snapshot = controller.item(ITEM_A);
  assert.equal(snapshot.save.phase, 'conflict');
  assert.equal(snapshot.save.retryable, false);
  assert.deepEqual(await controller.retry(ITEM_A), { ok: false, error: 'STORAGE_COMMIT_UNCERTAIN' });
  assert.deepEqual(await controller.setStatus(ITEM_B, 'ordered'), {
    ok: false,
    error: 'STORAGE_COMMIT_UNCERTAIN',
  });
  assert.deepEqual(controller.scheduleNote(ITEM_A, 'local draft'), {
    ok: false,
    error: 'STORAGE_COMMIT_UNCERTAIN',
  });
  assert.equal(controller.item(ITEM_A).note, undefined);
  assert.equal(controller.item(ITEM_B).status, 'need');
  assert.equal(controller.item(ITEM_B).save.phase, 'conflict');
  assert.equal(immediateSaves.length, 1);
  assert.equal(submittedStates.length, 1);
});
