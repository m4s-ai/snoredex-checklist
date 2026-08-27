import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCollectionStateController } from "../src/site/collection-state.ts";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

test("settles superseded immediate edits with the encompassing save", async () => {
  type Store = ConstructorParameters<typeof BrowserCollectionStateController>[0];
  type Domain = ConstructorParameters<typeof BrowserCollectionStateController>[1];
  const saves: Array<ReturnType<typeof deferred<{ ok: true; value: { skipped?: boolean } }>>> = [];
  const store = {
    read: () => ({ ok: true, value: undefined }),
    unsaved: () => undefined,
    adoptUnsavedDraft: () => ({ ok: true, value: undefined }),
    discardUnsavedDraft: () => undefined,
    hasPendingNote: () => false,
    saveImmediate: () => {
      const save = deferred<{ ok: true; value: { skipped?: boolean } }>();
      saves.push(save);
      return save.promise;
    },
    scheduleNoteSave: () => ({ ok: true, value: undefined }),
    flushNote: async () => ({ ok: true, value: {} }),
  } as Store;
  const domain = {
    applyStatusCommand: (itemId: string, _current: unknown, status: string) => ({
      ok: true,
      value: { itemId, status, quantityOwned: 0, quantityOrdered: 0 },
    }),
    applyQuantityEdit: () => ({ ok: true, value: undefined }),
    applyNoteEdit: () => ({ ok: true, value: undefined }),
  } as Domain;
  const controller = new BrowserCollectionStateController(store, domain, 1_000, FINGERPRINT, undefined);
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
