import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTE_AUTOSAVE_DELAY_MS,
  OrderedStateStore,
  PRIVATE_STATE_STORAGE_KEY,
  type StorageLike,
  type TimerClock,
} from "../src/state/storage.ts";
import {
  PRIVATE_DATASET_ID,
  PRIVATE_STATE_SCHEMA,
  PRIVATE_STATE_VERSION,
  type PrivateState,
} from "../src/state/domain.ts";

const fingerprint = "sha256:" + "c".repeat(64);
const itemId = "item-00000000-0000-0000-0000-00000000000a";

function state(quantityOwned: number, note?: string): PrivateState {
  const items = quantityOwned === 0 && note === undefined
    ? []
    : [
        {
          itemId,
          status: quantityOwned > 0 ? "have" as const : "need" as const,
          quantityOwned,
          quantityOrdered: 0,
          ...(note === undefined ? {} : { note }),
        },
      ];
  return {
    schema: PRIVATE_STATE_SCHEMA,
    schemaVersion: PRIVATE_STATE_VERSION,
    datasetId: PRIVATE_DATASET_ID,
    catalogueFingerprint: fingerprint,
    items,
  };
}

class FakeStorage implements StorageLike {
  public values = new Map<string, string>();
  public failGet = false;
  public failSet: unknown = undefined;
  public rewriteOnRead: string | undefined;
  public rewriteAfterWrite: string | undefined;
  public writes = 0;

  public getItem(key: string): string | null {
    if (this.failGet) throw new Error("unavailable");
    if (this.rewriteOnRead !== undefined) {
      const override = this.rewriteOnRead;
      this.rewriteOnRead = undefined;
      return override;
    }
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.writes += 1;
    if (this.failSet !== undefined) throw this.failSet;
    this.values.set(key, value);
    if (this.rewriteAfterWrite !== undefined) {
      this.rewriteOnRead = this.rewriteAfterWrite;
      this.rewriteAfterWrite = undefined;
    }
  }
}

class FakeClock implements TimerClock {
  private now = 0;
  private next = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();

  public setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  public advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.now) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

test("untouched profiles do not write and successful writes reload exactly", async () => {
  const storage = new FakeStorage();
  const store = new OrderedStateStore(storage);
  assert.deepEqual(store.read(), { ok: true, value: undefined });
  assert.equal(storage.writes, 0);
  assert.deepEqual(await store.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });
  assert.equal(storage.values.has(PRIVATE_STATE_STORAGE_KEY), true);
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(1) });
});

test("note autosave uses blur or three seconds of inactivity and resets its timer", async () => {
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const store = new OrderedStateStore(storage, clock);
  store.scheduleNoteSave(state(0, "first"));
  clock.advance(NOTE_AUTOSAVE_DELAY_MS - 1);
  assert.equal(storage.writes, 0);
  store.scheduleNoteSave(state(0, "second"));
  clock.advance(NOTE_AUTOSAVE_DELAY_MS - 1);
  assert.equal(storage.writes, 0);
  clock.advance(1);
  await Promise.resolve();
  assert.equal(storage.writes, 1);
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(0, "second") });

  store.scheduleNoteSave(state(0, "blurred"));
  const flushed = await store.flushNote();
  assert.equal(flushed.ok, true);
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(0, "blurred") });
});

test("queued saves keep the newest edit authoritative and page-close flush is explicit", async () => {
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const store = new OrderedStateStore(storage, clock);
  const first = store.saveImmediate(state(1));
  const second = store.saveImmediate(state(2));
  await Promise.all([first, second]);
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(2) });

  store.scheduleNoteSave(state(2, "before close"));
  await store.flushNote();
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(2, "before close") });
});

test("quota and read-back failures preserve the last known-good state", async () => {
  const storage = new FakeStorage();
  const store = new OrderedStateStore(storage);
  await store.saveImmediate(state(1));
  storage.failSet = { name: "QuotaExceededError" };
  assert.deepEqual(await store.saveImmediate(state(2)), { ok: false, error: "STORAGE_QUOTA_EXCEEDED" });
  assert.deepEqual(store.lastReadable(), state(1));
  assert.deepEqual(store.unsaved(), state(2));
  storage.failSet = undefined;
  storage.rewriteAfterWrite = JSON.stringify(state(99));
  assert.deepEqual(await store.saveImmediate(state(2)), { ok: false, error: "STORAGE_COMMIT_UNCERTAIN" });
  assert.deepEqual(store.lastReadable(), state(1));
});

test("corrupt or unsupported stored bytes fail closed without becoming an empty collection", () => {
  const storage = new FakeStorage();
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, "not-json");
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: false, error: "LOCAL_STATE_UNREADABLE" });
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify({ schema: PRIVATE_STATE_SCHEMA, schemaVersion: "9.0.0" }));
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: false, error: "LOCAL_STATE_UNSUPPORTED" });
});

test("never overwrites an unreadable existing value", async () => {
  const storage = new FakeStorage();
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, "corrupt");
  const store = new OrderedStateStore(storage);
  assert.deepEqual(await store.saveImmediate(state(1)), { ok: false, error: "LOCAL_STATE_UNREADABLE" });
  assert.equal(storage.values.get(PRIVATE_STATE_STORAGE_KEY), "corrupt");
});
