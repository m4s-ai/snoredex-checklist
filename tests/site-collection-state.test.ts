import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCollectionStateController } from "../src/site/collection-state.ts";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

type Store = ConstructorParameters<typeof BrowserCollectionStateController>[0];
type Domain = ConstructorParameters<typeof BrowserCollectionStateController>[1];
type SaveOutcome = { readonly ok: true; readonly value: { readonly skipped?: boolean } } | { readonly ok: false; readonly error: string };
type DeferredSave = ReturnType<typeof deferred<SaveOutcome>>;
type ScheduleOutcome = { readonly ok: true; readonly value: undefined } | { readonly ok: false; readonly error: string };

function makeController(
  saves: DeferredSave[],
  noteFlushes: DeferredSave[] = [],
  scheduleNoteError?: string,
  scheduleNoteOutcomes: ScheduleOutcome[] = [],
  scheduleFlushes: boolean[] = [],
  pendingNote = false,
): BrowserCollectionStateController {
  const store = {
    read: () => ({ ok: true, value: undefined }),
    unsaved: () => undefined,
    adoptUnsavedDraft: () => ({ ok: true, value: undefined }),
    discardUnsavedDraft: () => undefined,
    hasPendingNote: () => pendingNote,
    saveImmediate: () => {
      const save = deferred<SaveOutcome>();
      saves.push(save);
      return save.promise;
    },
    scheduleNoteSave: (_state: unknown, scheduleFlush = true) => {
      scheduleFlushes.push(scheduleFlush);
      return scheduleNoteOutcomes.shift() ?? (scheduleNoteError === undefined
        ? { ok: true, value: undefined }
        : { ok: false, error: scheduleNoteError });
    },
    flushNote: () => noteFlushes.shift()?.promise ?? Promise.resolve({ ok: true, value: {} }),
  } as Store;
  const domain = {
    applyStatusCommand: (itemId: string, _current: unknown, status: string) => ({
      ok: true,
      value: { itemId, status, quantityOwned: 0, quantityOrdered: 0 },
    }),
    applyQuantityEdit: () => ({ ok: true, value: undefined }),
    applyNoteEdit: () => ({ ok: true, value: undefined }),
  } as Domain;
  return new BrowserCollectionStateController(store, domain, 1_000, FINGERPRINT, undefined);
}

test("settles superseded immediate edits with the encompassing save", async () => {
  const saves: Array<ReturnType<typeof deferred<SaveOutcome>>> = [];
  const controller = makeController(saves);
  const events: string[] = [];
  controller.onSave((itemId, result) => events.push(`${itemId}:${result.ok ? (result.skipped ? "skipped" : "saved") : "failed"}`));

  const first = controller.setStatus("item-a", "have");
  const second = controller.setStatus("item-b", "have");
  saves[1].resolve({ ok: true, value: {} });
  await Promise.resolve();
  assert.deepEqual(events, ["item-a:saved", "item-b:saved"]);
  saves[0].resolve({ ok: true, value: { skipped: true } });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, { ok: true, skipped: true, deferred: true });
  assert.deepEqual(secondResult, { ok: true, skipped: undefined });
  assert.deepEqual(events, ["item-a:saved", "item-b:saved"]);
});

test("retains failed immediate edit owners until a later save succeeds", async () => {
  const saves: Array<ReturnType<typeof deferred<SaveOutcome>>> = [];
  const controller = makeController(saves);
  const events: string[] = [];
  controller.onSave((itemId, result) => events.push(`${itemId}:${result.ok ? "saved" : "failed"}`));

  const first = controller.setStatus("item-a", "have");
  const second = controller.setStatus("item-b", "have");
  saves[0].resolve({ ok: true, value: { skipped: true } });
  saves[1].resolve({ ok: false, error: "STORAGE_COMMIT_UNCERTAIN" });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["item-a:failed", "item-b:failed"]);

  const retry = controller.setStatus("item-a", "have");
  saves[2].resolve({ ok: true, value: {} });
  await retry;
  assert.deepEqual(events, ["item-a:failed", "item-b:failed", "item-a:saved", "item-b:saved"]);
});

test("settles failed immediate owners after a successful note save", async () => {
  const saves: DeferredSave[] = [];
  const controller = makeController(saves);
  const events: string[] = [];
  controller.onSave((itemId, result) => events.push(`${itemId}:${result.ok ? "saved" : "failed"}`));

  const first = controller.setStatus("item-a", "have");
  const second = controller.setStatus("item-b", "have");
  saves[0].resolve({ ok: true, value: { skipped: true } });
  saves[1].resolve({ ok: false, error: "STORAGE_COMMIT_UNCERTAIN" });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["item-a:failed", "item-b:failed"]);

  controller.scheduleNote("item-c", "note");
  await controller.flushNote();
  assert.deepEqual(events, ["item-a:failed", "item-b:failed", "item-a:saved", "item-b:saved", "item-c:saved"]);
});

test("retains a failed note owner through a later immediate save", async () => {
  const saves: DeferredSave[] = [];
  const noteFlush = deferred<SaveOutcome>();
  const noteFlushes = [noteFlush];
  const controller = makeController(saves, noteFlushes);
  const events: string[] = [];
  controller.onSave((itemId, result) => events.push(`${itemId}:${result.ok ? "saved" : "failed"}`));

  controller.scheduleNote("item-a", "note");
  const note = controller.flushNote();
  noteFlush.resolve({ ok: false, error: "STORAGE_WRITE_FAILED" });
  await note;
  assert.deepEqual(events, ["item-a:failed"]);

  const status = controller.setStatus("item-b", "have");
  saves[0].resolve({ ok: true, value: {} });
  await status;
  assert.deepEqual(events, ["item-a:failed", "item-a:saved", "item-b:saved"]);
});

test("retains a note owner when scheduling the durable draft fails", async () => {
  const saves: DeferredSave[] = [];
  const controller = makeController(saves, [], "STORAGE_WRITE_FAILED");
  const events: string[] = [];
  controller.onSave((itemId, result) => events.push(`${itemId}:${result.ok ? "saved" : "failed"}`));

  assert.deepEqual(controller.scheduleNote("item-a", "note"), { ok: false, error: "STORAGE_WRITE_FAILED" });
  assert.deepEqual(events, ["item-a:failed"]);

  const status = controller.setStatus("item-b", "have");
  saves[0].resolve({ ok: true, value: {} });
  await status;
  assert.deepEqual(events, ["item-a:failed", "item-a:saved", "item-b:saved"]);
  await controller.flushNote();
});

test("settles superseded note owners after a later note save succeeds", async () => {
  const controller = makeController(
    [],
    [],
    undefined,
    [{ ok: true, value: undefined }, { ok: false, error: "STORAGE_WRITE_FAILED" }],
  );
  const events: string[] = [];
  controller.onSave((itemId, result) => events.push(`${itemId}:${result.ok ? "saved" : "failed"}`));

  assert.deepEqual(controller.scheduleNote("item-a", "first"), { ok: true });
  assert.deepEqual(controller.scheduleNote("item-b", "second"), { ok: false, error: "STORAGE_WRITE_FAILED" });
  assert.deepEqual(events, ["item-b:failed", "item-a:failed"]);

  await controller.flushNote();
  assert.deepEqual(events, ["item-b:failed", "item-a:failed", "item-a:saved", "item-b:saved"]);
});

test("lets the controller own note autosave timing", async () => {
  const scheduleFlushes: boolean[] = [];
  const controller = makeController([], [], undefined, [], scheduleFlushes, true);

  assert.deepEqual(controller.scheduleNote("item-a", "note"), { ok: true });
  await controller.flushNote();
  assert.deepEqual(scheduleFlushes, [false]);
});
