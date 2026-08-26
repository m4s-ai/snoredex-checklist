import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTE_AUTOSAVE_DELAY_MS,
  OrderedStateStore,
  PRIVATE_STATE_NOTE_DRAFT_KEY,
  PRIVATE_STATE_STORAGE_KEY,
  PRIVATE_STATE_LOCK_NAME,
  type DraftStorageLike,
  type StorageLockLike,
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
const secondItemId = "item-00000000-0000-0000-0000-00000000000b";

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
  public draftValues = new Map<string, string>();
  private readonly inactiveHandlers = new Set<() => void>();
  private readonly activeHandlers = new Set<() => void>();
  public registerDraftLifecycle(
    onInactive: () => void,
    onActive: () => void,
  ): () => void {
    this.inactiveHandlers.add(onInactive);
    this.activeHandlers.add(onActive);
    return () => {
      this.inactiveHandlers.delete(onInactive);
      this.activeHandlers.delete(onActive);
    };
  }
  public emitInactive(): void {
    for (const handler of this.inactiveHandlers) handler();
  }
  public emitActive(): void {
    for (const handler of this.activeHandlers) handler();
  }
  public draftStorage: DraftStorageLike = {
    getItem: (key) => this.draftValues.get(key) ?? null,
    setItem: (key, value) => {
      if (this.failDraftSet !== undefined) throw this.failDraftSet;
      if (this.failTombstoneSet !== undefined && key.includes(":tombstone:")) {
        throw this.failTombstoneSet;
      }
      if (this.failRotatedDraftSet !== undefined && key.includes(":rotated:")) {
        this.beforeRotatedDraftQuota?.(key);
        throw this.failRotatedDraftSet;
      }
      this.draftWrites += 1;
      this.draftValues.set(key, value);
    },
    removeItem: (key) => {
      if (this.failDraftRemove !== undefined) throw this.failDraftRemove;
      this.draftValues.delete(key);
    },
    listKeys: (prefix) => [...this.draftValues.keys()].filter((key) => key.startsWith(prefix)),
  };
  public withLock: StorageLike["withLock"] = undefined;
  public failGet = false;
  public failSet: unknown = undefined;
  public failDraftSet: unknown = undefined;
  public failTombstoneSet: unknown = undefined;
  public failDraftRemove: unknown = undefined;
  public failRotatedDraftSet: unknown = undefined;
  public beforeRotatedDraftQuota: ((key: string) => void) | undefined;
  public rewriteOnRead: string | undefined;
  public rewriteAfterWrite: string | undefined;
  public writes = 0;
  public draftWrites = 0;

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

class FakeLock implements StorageLockLike {
  private queue: Promise<void> = Promise.resolve();
  public active = 0;
  public maximumActive = 0;

  public request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      this.active += 1;
      this.maximumActive = Math.max(this.maximumActive, this.active);
      try {
        return await callback();
      } finally {
        this.active -= 1;
      }
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

class BlockingLock implements StorageLockLike {
  private gate: Promise<void>;
  private releaseGate!: () => void;

  public constructor() {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  public release(): void {
    this.releaseGate();
  }

  public async request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    await this.gate;
    return callback();
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

test("reports scheduled draft persistence failures instead of hiding them", async () => {
  const storage = new FakeStorage();
  const store = new OrderedStateStore(storage);
  storage.failDraftSet = new Error("draft storage unavailable");
  assert.deepEqual(store.scheduleNoteSave(state(0, "report this failure")), {
    ok: false,
    error: "STORAGE_WRITE_FAILED",
  });
  assert.equal(storage.draftValues.size, 0);

  storage.failDraftSet = undefined;
  assert.deepEqual(await store.flushNote(), {
    ok: true,
    value: { state: state(0, "report this failure") },
  });
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(0, "report this failure") });
});

test("persists a pending note draft before pagehide and restores it after an interrupted flush", async () => {
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const store = new OrderedStateStore(storage, clock);
  store.scheduleNoteSave(state(0, "before pagehide"));

  assert.equal(storage.draftValues.size, 1);
  assert.equal(storage.writes, 0);

  const restored = new OrderedStateStore(storage, clock);
  assert.deepEqual(restored.read(), { ok: true, value: undefined });
  assert.deepEqual(restored.unsaved(), state(0, "before pagehide"));

  await store.flushNote();
  assert.equal(storage.draftValues.size, 0);
  assert.deepEqual(new OrderedStateStore(storage).read(), {
    ok: true,
    value: state(0, "before pagehide"),
  });
});

test("keeps pending recovery records separate across tabs", async () => {
  const storage = new FakeStorage();
  const firstTab = new OrderedStateStore(storage);
  const secondTab = new OrderedStateStore(storage);
  firstTab.scheduleNoteSave(state(0, "first tab"));
  secondTab.scheduleNoteSave(state(0, "second tab"));

  assert.equal(storage.draftValues.size, 2);
  await firstTab.flushNote();
  assert.equal(storage.draftValues.size, 1);
  assert.deepEqual(secondTab.unsaved(), state(0, "second tab"));
});

test("orders recovery drafts by edit time rather than heartbeat refresh time", () => {
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const lock = new BlockingLock();
  storage.withLock = <T>(callback: () => Promise<T>) => lock.request(PRIVATE_STATE_LOCK_NAME, callback);
  const older = new OrderedStateStore(storage, clock);
  const newer = new OrderedStateStore(storage, clock);
  void older.saveImmediate(state(0, "older edit"));
  void newer.saveImmediate(state(0, "newer edit"));

  const olderKey = [...storage.draftValues.keys()]
    .find((key) => storage.draftValues.get(key)?.includes("older edit"));
  const newerKey = [...storage.draftValues.keys()]
    .find((key) => storage.draftValues.get(key)?.includes("newer edit"));
  assert.equal(typeof olderKey, "string");
  assert.equal(typeof newerKey, "string");
  const olderRecord = JSON.parse(storage.draftValues.get(olderKey as string) as string) as Record<string, unknown>;
  const newerRecord = JSON.parse(storage.draftValues.get(newerKey as string) as string) as Record<string, unknown>;
  olderRecord.updatedAt = 1;
  newerRecord.updatedAt = 2;
  storage.draftValues.set(olderKey as string, JSON.stringify(olderRecord));
  storage.draftValues.set(newerKey as string, JSON.stringify(newerRecord));

  clock.advance(5_000);
  const restored = new OrderedStateStore(storage, clock);
  assert.deepEqual(restored.read(), { ok: true, value: undefined });
  assert.deepEqual(restored.unsaved(), state(0, "newer edit"));
});

test("does not let a tab discard another tab's orphaned recovery draft", () => {
  const storage = new FakeStorage();
  const firstTab = new OrderedStateStore(storage);
  firstTab.scheduleNoteSave(state(0, "keep this draft"));
  const secondTab = new OrderedStateStore(storage);
  assert.deepEqual(secondTab.read(), { ok: true, value: undefined });
  assert.deepEqual(secondTab.unsaved(), state(0, "keep this draft"));
  secondTab.discardUnsavedDraft();
  assert.equal(storage.draftValues.size, 1);
});

test("durable recovery restores its original concurrency baseline", async () => {
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const writer = new OrderedStateStore(storage, clock);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "draft from first tab"));

  const otherTab = new OrderedStateStore(storage);
  assert.deepEqual(otherTab.read(), { ok: true, value: state(1) });
  otherTab.discardUnsavedDraft();
  assert.deepEqual(await otherTab.saveImmediate(state(2)), { ok: true, value: { state: state(2) } });

  const restored = new OrderedStateStore(storage, clock);
  assert.deepEqual(restored.read(), { ok: true, value: state(2) });
  assert.deepEqual(restored.unsaved(), state(1, "draft from first tab"));
  assert.deepEqual(await restored.saveImmediate(state(1, "draft from first tab")), {
    ok: false,
    error: "STORAGE_COMMIT_UNCERTAIN",
  });
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(2) });
});

test("consumes a foreign source after an edited direct replacement save", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "recovered draft"));

  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(1) });
  assert.deepEqual(recovered.unsaved(), state(1, "recovered draft"));
  assert.deepEqual(await recovered.saveImmediate(state(1, "edited recovered draft")), {
    ok: true,
    value: { state: state(1, "edited recovered draft") },
  });
  assert.equal([...storage.draftValues.keys()].some((key) => key.includes(":tombstone:")), true);
  const reloaded = new OrderedStateStore(storage);
  assert.deepEqual(reloaded.read(), { ok: true, value: state(1, "edited recovered draft") });
  assert.equal(reloaded.unsaved(), undefined);
});

test("keeps a recovered source for an unrelated read-based immediate edit", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "keep my note"));

  const unrelated = new OrderedStateStore(storage);
  assert.deepEqual(unrelated.read(), { ok: true, value: state(1) });
  assert.deepEqual(await unrelated.saveImmediate(state(2)), {
    ok: true,
    value: { state: state(2) },
  });
  assert.equal([...storage.draftValues.keys()].some((key) => key.includes(":tombstone:")), false);
  const reloaded = new OrderedStateStore(storage);
  assert.deepEqual(reloaded.read(), { ok: true, value: state(2) });
  assert.deepEqual(reloaded.unsaved(), state(1, "keep my note"));
});

test("keeps a recovered source when a read-based edit retains a different canonical note", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1, "canonical note")), {
    ok: true,
    value: { state: state(1, "canonical note") },
  });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1, "canonical note") });
  writer.scheduleNoteSave(state(1, "foreign recovery note"));

  const unrelated = new OrderedStateStore(storage);
  assert.deepEqual(unrelated.read(), { ok: true, value: state(1, "canonical note") });
  assert.deepEqual(await unrelated.saveImmediate(state(2, "canonical note")), {
    ok: true,
    value: { state: state(2, "canonical note") },
  });
  assert.equal([...storage.draftValues.keys()].some((key) => key.includes(":tombstone:")), false);
  const reloaded = new OrderedStateStore(storage);
  assert.deepEqual(reloaded.read(), { ok: true, value: state(2, "canonical note") });
  assert.deepEqual(reloaded.unsaved(), state(1, "foreign recovery note"));
});

test("keeps a recovered source when a multi-item edit omits a recovered note", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1, "canonical note")), {
    ok: true,
    value: { state: state(1, "canonical note") },
  });

  const recoveredState: PrivateState = {
    ...state(1, "canonical note"),
    items: [
      ...state(1, "canonical note").items,
      {
        itemId: secondItemId,
        status: "need",
        quantityOwned: 0,
        quantityOrdered: 0,
        note: "foreign recovery note",
      },
    ],
  };
  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1, "canonical note") });
  writer.scheduleNoteSave(recoveredState);

  const unrelated = new OrderedStateStore(storage);
  assert.deepEqual(unrelated.read(), { ok: true, value: state(1, "canonical note") });
  assert.deepEqual(await unrelated.saveImmediate(state(2, "canonical note")), {
    ok: true,
    value: { state: state(2, "canonical note") },
  });
  assert.equal([...storage.draftValues.keys()].some((key) => key.includes(":tombstone:")), false);
  const reloaded = new OrderedStateStore(storage);
  assert.deepEqual(reloaded.read(), { ok: true, value: state(2, "canonical note") });
  assert.deepEqual(reloaded.unsaved(), recoveredState);
});

test("keeps a recovered source when a read-based edit retains a note deleted by the draft", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(0, "canonical note")), {
    ok: true,
    value: { state: state(0, "canonical note") },
  });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(0, "canonical note") });
  writer.scheduleNoteSave(state(0));

  const unrelated = new OrderedStateStore(storage);
  assert.deepEqual(unrelated.read(), { ok: true, value: state(0, "canonical note") });
  assert.deepEqual(await unrelated.saveImmediate(state(1, "canonical note")), {
    ok: true,
    value: { state: state(1, "canonical note") },
  });
  assert.equal([...storage.draftValues.keys()].some((key) => key.includes(":tombstone:")), false);
  const reloaded = new OrderedStateStore(storage);
  assert.deepEqual(reloaded.read(), { ok: true, value: state(1, "canonical note") });
  assert.deepEqual(reloaded.unsaved(), state(0));
});

test("uses the recovery record baseline when another tab already applied the note deletion", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1, "canonical note")), {
    ok: true,
    value: { state: state(1, "canonical note") },
  });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1, "canonical note") });
  writer.scheduleNoteSave(state(1));

  const otherTab = new OrderedStateStore(storage);
  assert.deepEqual(otherTab.read(), { ok: true, value: state(1, "canonical note") });
  otherTab.discardUnsavedDraft();
  assert.deepEqual(await otherTab.saveImmediate(state(2)), {
    ok: true,
    value: { state: state(2) },
  });

  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(2) });
  assert.deepEqual(recovered.unsaved(), state(1));
  // The CAS guard must still reject the stale canonical write; inspect the
  // adoption decision separately so a changed non-note field cannot erase the
  // recovery record's original note baseline.
  const detectsAdoption = (recovered as unknown as {
    isRecoveredDraftReplacement: (submitted: PrivateState) => boolean;
  }).isRecoveredDraftReplacement(state(2));
  assert.equal(detectsAdoption, true);
  assert.deepEqual(await recovered.saveImmediate(state(2)), {
    ok: false,
    error: "STORAGE_COMMIT_UNCERTAIN",
  });
  assert.equal([...storage.draftValues.keys()].some((key) => key.includes(":tombstone:")), false);
});

test("clears an in-memory foreign recovery when its source disappears", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "source disappears"));

  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(1) });
  assert.deepEqual(recovered.unsaved(), state(1, "source disappears"));
  for (const key of [...storage.draftValues.keys()]) {
    if (!key.includes(":tombstone:")) {
      storage.draftValues.delete(key);
    }
  }

  assert.deepEqual(recovered.read(), { ok: true, value: state(1) });
  assert.equal(recovered.unsaved(), undefined);
  assert.deepEqual(await recovered.saveImmediate(state(2)), {
    ok: true,
    value: { state: state(2) },
  });
});

test("allows an explicit rebase after a recovered draft conflicts", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "draft to rebase"));

  const otherTab = new OrderedStateStore(storage);
  assert.deepEqual(otherTab.read(), { ok: true, value: state(1) });
  otherTab.discardUnsavedDraft();
  assert.deepEqual(await otherTab.saveImmediate(state(2)), { ok: true, value: { state: state(2) } });

  storage.emitInactive();
  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(2) });
  assert.deepEqual(await recovered.saveImmediate(state(1, "draft to rebase")), {
    ok: false,
    error: "STORAGE_COMMIT_UNCERTAIN",
  });
  assert.deepEqual(recovered.rebaseUnsavedDraft(), { ok: true, value: state(1, "draft to rebase") });
  assert.equal(storage.draftValues.size, 1);
  assert.deepEqual(await recovered.saveImmediate(state(1, "draft to rebase")), {
    ok: true,
    value: { state: state(1, "draft to rebase") },
  });
  assert.equal(storage.draftValues.size, 0);
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(1, "draft to rebase") });
});

test("preserves a live foreign recovery draft during rebase", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "live draft"));

  const otherTab = new OrderedStateStore(storage);
  assert.deepEqual(otherTab.read(), { ok: true, value: state(1) });
  otherTab.discardUnsavedDraft();
  assert.deepEqual(await otherTab.saveImmediate(state(2)), { ok: true, value: { state: state(2) } });

  const foreignKey = [...storage.draftValues.keys()][0];
  const foreignRecord = JSON.parse(storage.draftValues.get(foreignKey) as string) as Record<string, unknown>;
  storage.draftValues.set(foreignKey, JSON.stringify({ ...foreignRecord, updatedAt: 0, ownerState: "active" }));
  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(2) });
  assert.deepEqual(recovered.rebaseUnsavedDraft(), { ok: true, value: state(1, "live draft") });
  assert.equal(storage.draftValues.size, 2);
  storage.emitInactive();
  storage.emitActive();
  assert.deepEqual(await recovered.saveImmediate(state(1, "live draft")), {
    ok: true,
    value: { state: state(1, "live draft") },
  });
  storage.emitInactive();
  storage.emitActive();
  assert.equal(storage.draftValues.size, 2);
  const activeForeignKey = [...storage.draftValues.keys()]
    .find((key) => key !== foreignKey && !key.includes(":tombstone:"));
  assert.equal(typeof activeForeignKey, "string");
  const transferred = JSON.parse(storage.draftValues.get(activeForeignKey as string) as string) as Record<string, unknown>;
  assert.equal(transferred.ownerState, "consumed");
  const tombstoneKey = [...storage.draftValues.keys()].find((key) => key.includes(":tombstone:"));
  assert.equal(typeof tombstoneKey, "string");
  const tombstone = JSON.parse(storage.draftValues.get(tombstoneKey as string) as string) as Record<string, unknown>;
  assert.equal(tombstone.sourceKey, foreignKey);
  storage.emitInactive();
  storage.emitActive();
  const lifecycleRefreshed = JSON.parse(storage.draftValues.get(activeForeignKey as string) as string) as Record<string, unknown>;
  assert.equal(lifecycleRefreshed.ownerState, "consumed");
  const reloaded = new OrderedStateStore(storage);
  assert.deepEqual(reloaded.read(), { ok: true, value: state(1, "live draft") });
  assert.equal(reloaded.unsaved(), undefined);
  const laterWriter = new OrderedStateStore(storage);
  assert.deepEqual(laterWriter.read(), { ok: true, value: state(1, "live draft") });
  assert.deepEqual(await laterWriter.saveImmediate(state(2)), { ok: true, value: { state: state(2) } });
  const afterCanonicalChange = new OrderedStateStore(storage);
  assert.deepEqual(afterCanonicalChange.read(), { ok: true, value: state(2) });
  assert.equal(afterCanonicalChange.unsaved(), undefined);
});

test("does not consume a foreign draft that changed during ownership transfer", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "live draft"));
  const otherTab = new OrderedStateStore(storage);
  assert.deepEqual(otherTab.read(), { ok: true, value: state(1) });
  otherTab.discardUnsavedDraft();
  assert.deepEqual(await otherTab.saveImmediate(state(2)), { ok: true, value: { state: state(2) } });

  const foreignKey = [...storage.draftValues.keys()][0];
  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(2) });
  assert.deepEqual(recovered.rebaseUnsavedDraft(), { ok: true, value: state(1, "live draft") });
  const changedForeign = JSON.parse(storage.draftValues.get(foreignKey) as string) as Record<string, unknown>;
  changedForeign.state = state(1, "edited by owner");
  storage.draftValues.set(foreignKey, JSON.stringify(changedForeign));

  assert.deepEqual(await recovered.saveImmediate(state(1, "live draft")), {
    ok: true,
    value: { state: state(1, "live draft") },
  });
  const remaining = JSON.parse(storage.draftValues.get(foreignKey) as string) as Record<string, unknown>;
  assert.equal(remaining.ownerState, "active");
  assert.deepEqual(new OrderedStateStore(storage).unsaved(), undefined);
  const restored = new OrderedStateStore(storage);
  assert.deepEqual(restored.read(), { ok: true, value: state(1, "live draft") });
  assert.deepEqual(restored.unsaved(), state(1, "edited by owner"));
});

test("reclaims consumed source records after an explicit inactive lifecycle", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "reclaim me"));
  const otherTab = new OrderedStateStore(storage);
  assert.deepEqual(otherTab.read(), { ok: true, value: state(1) });
  otherTab.discardUnsavedDraft();
  assert.deepEqual(await otherTab.saveImmediate(state(2)), { ok: true, value: { state: state(2) } });

  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(2) });
  assert.deepEqual(recovered.rebaseUnsavedDraft(), { ok: true, value: state(1, "reclaim me") });
  assert.deepEqual(await recovered.saveImmediate(state(1, "reclaim me")), {
    ok: true,
    value: { state: state(1, "reclaim me") },
  });
  assert.equal(storage.draftValues.size, 2);
  storage.emitInactive();

  const reloaded = new OrderedStateStore(storage);
  assert.deepEqual(reloaded.read(), { ok: true, value: state(1, "reclaim me") });
  assert.equal(reloaded.unsaved(), undefined);
  assert.equal(storage.draftValues.size, 0);
});

test("rotates a tombstoned source before owner reactivation", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "rotate me"));
  const otherTab = new OrderedStateStore(storage);
  assert.deepEqual(otherTab.read(), { ok: true, value: state(1) });
  otherTab.discardUnsavedDraft();
  assert.deepEqual(await otherTab.saveImmediate(state(2)), { ok: true, value: { state: state(2) } });
  const sourceKey = [...storage.draftValues.keys()][0];

  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(2) });
  assert.deepEqual(recovered.rebaseUnsavedDraft(), { ok: true, value: state(1, "rotate me") });
  assert.deepEqual(await recovered.saveImmediate(state(1, "rotate me")), {
    ok: true,
    value: { state: state(1, "rotate me") },
  });
  assert.equal(typeof sourceKey, "string");

  storage.emitInactive();
  storage.emitActive();
  const rotatedKey = [...storage.draftValues.keys()]
    .find((key) => key !== sourceKey && !key.includes(":tombstone:"));
  assert.equal(typeof rotatedKey, "string");

  const reloaded = new OrderedStateStore(storage);
  assert.deepEqual(reloaded.read(), { ok: true, value: state(1, "rotate me") });
  assert.equal(reloaded.unsaved(), undefined);
  assert.equal(storage.draftValues.has(sourceKey as string), false);
  assert.equal(storage.draftValues.has(rotatedKey as string), true);
});

test("does not tombstone a later foreign revision that reuses the same state", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "same state revision"));
  const otherTab = new OrderedStateStore(storage);
  assert.deepEqual(otherTab.read(), { ok: true, value: state(1) });
  otherTab.discardUnsavedDraft();
  assert.deepEqual(await otherTab.saveImmediate(state(2)), { ok: true, value: { state: state(2) } });

  const foreignKey = [...storage.draftValues.keys()][0];
  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(2) });
  assert.deepEqual(recovered.rebaseUnsavedDraft(), { ok: true, value: state(1, "same state revision") });
  const laterRevision = JSON.parse(storage.draftValues.get(foreignKey) as string) as Record<string, unknown>;
  laterRevision.revision = `${String(laterRevision.revision)}:later`;
  storage.draftValues.set(foreignKey, JSON.stringify(laterRevision));

  assert.deepEqual(await recovered.saveImmediate(state(1, "same state revision")), {
    ok: true,
    value: { state: state(1, "same state revision") },
  });
  assert.equal(storage.draftValues.size, 1);
  assert.equal([...storage.draftValues.keys()].some((key) => key.includes(":tombstone:")), false);
});

test("keeps the old baseline when rebasing cannot persist the replacement draft", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });
  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "draft with old baseline"));
  const otherTab = new OrderedStateStore(storage);
  assert.deepEqual(otherTab.read(), { ok: true, value: state(1) });
  otherTab.discardUnsavedDraft();
  assert.deepEqual(await otherTab.saveImmediate(state(2)), { ok: true, value: { state: state(2) } });

  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(2) });
  storage.failDraftSet = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
  assert.deepEqual(recovered.rebaseUnsavedDraft(), { ok: false, error: "STORAGE_QUOTA_EXCEEDED" });
  storage.failDraftSet = undefined;
  assert.deepEqual(await recovered.saveImmediate(state(1, "draft with old baseline")), {
    ok: false,
    error: "STORAGE_COMMIT_UNCERTAIN",
  });
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(2) });
});

test("allows an explicit discard of a recovered draft", () => {
  const storage = new FakeStorage();
  const store = new OrderedStateStore(storage);
  store.scheduleNoteSave(state(0, "discard me"));
  assert.equal(storage.draftValues.size, 1);
  store.discardUnsavedDraft();
  assert.equal(storage.draftValues.size, 0);
  assert.equal(store.unsaved(), undefined);
  assert.equal(store.hasPendingNote(), false);
});

test("clears its superseded recovery draft only after an immediate save succeeds", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });
  const store = new OrderedStateStore(storage);
  assert.deepEqual(store.read(), { ok: true, value: state(1) });
  store.scheduleNoteSave(state(1, "superseded note"));
  assert.equal(storage.draftValues.size, 1);
  assert.deepEqual(await store.saveImmediate(state(2)), { ok: true, value: { state: state(2) } });
  assert.equal(storage.draftValues.size, 0);
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(2) });
});

test("ignores a recovery draft that already matches canonical state without deleting it", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });
  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1));
  assert.equal(storage.draftValues.size, 1);

  const restored = new OrderedStateStore(storage);
  assert.deepEqual(restored.read(), { ok: true, value: state(1) });
  assert.equal(restored.unsaved(), undefined);
  assert.equal(storage.draftValues.size, 2);
  const sourceKey = [...storage.draftValues.keys()].find((key) => !key.includes(":tombstone:"));
  assert.equal(typeof sourceKey, "string");
  assert.equal(storage.draftValues.has(sourceKey as string), true);
});

test("clears an in-memory foreign draft when a later read retires an exact match", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "foreign note"));

  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(1) });
  assert.deepEqual(recovered.unsaved(), state(1, "foreign note"));

  storage.failDraftRemove = new Error("cleanup unavailable");
  assert.deepEqual(await writer.flushNote(), {
    ok: true,
    value: { state: state(1, "foreign note") },
  });
  storage.failDraftRemove = undefined;

  storage.failDraftSet = new Error("tombstone unavailable");
  assert.deepEqual(recovered.read(), { ok: true, value: state(1, "foreign note") });
  assert.deepEqual(recovered.unsaved(), state(1, "foreign note"));
  storage.failDraftSet = undefined;
  assert.deepEqual(recovered.read(), { ok: true, value: state(1, "foreign note") });
  assert.equal(recovered.unsaved(), undefined);
});

test("skips a note flush discarded while waiting for the cross-tab lock", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });
  const lock = new BlockingLock();
  storage.withLock = <T>(callback: () => Promise<T>) => lock.request(PRIVATE_STATE_LOCK_NAME, callback);
  const store = new OrderedStateStore(storage);
  assert.deepEqual(store.read(), { ok: true, value: state(1) });
  store.scheduleNoteSave(state(1, "discarded while locked"));
  const flush = store.flushNote();
  await Promise.resolve();
  store.discardUnsavedDraft();
  lock.release();
  assert.deepEqual(await flush, { ok: true, value: { state: state(1), skipped: true } });
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(1) });
});

test("skips an immediate save discarded while waiting for the cross-tab lock", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });
  const lock = new BlockingLock();
  storage.withLock = <T>(callback: () => Promise<T>) => lock.request(PRIVATE_STATE_LOCK_NAME, callback);
  const store = new OrderedStateStore(storage);
  assert.deepEqual(store.read(), { ok: true, value: state(1) });
  const save = store.saveImmediate(state(2));
  assert.equal(storage.draftValues.size, 1);
  const durableImmediate = JSON.parse([...storage.draftValues.values()][0]) as { state: unknown };
  assert.deepEqual(durableImmediate.state, state(2));
  await Promise.resolve();
  store.discardUnsavedDraft();
  lock.release();
  assert.deepEqual(await save, { ok: true, value: { state: state(1), skipped: true } });
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(1) });
});

test("clears a heartbeat-refreshed draft after a locked note commit", async () => {
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const lock = new BlockingLock();
  storage.withLock = <T>(callback: () => Promise<T>) => lock.request(PRIVATE_STATE_LOCK_NAME, callback);
  const store = new OrderedStateStore(storage, clock);
  assert.deepEqual(store.read(), { ok: true, value: undefined });
  store.scheduleNoteSave(state(0, "refresh before commit"));
  const flush = store.flushNote();
  await Promise.resolve();
  const writesBeforeHeartbeat = storage.draftWrites;
  clock.advance(5_000);
  assert.equal(storage.draftWrites, writesBeforeHeartbeat + 1);
  lock.release();
  assert.deepEqual(await flush, { ok: true, value: { state: state(0, "refresh before commit") } });
  assert.equal(storage.draftValues.size, 0);
});

test("retains an owned recovery reference when post-commit cleanup fails", async () => {
  const storage = new FakeStorage();
  const store = new OrderedStateStore(storage);
  storage.failDraftRemove = new Error("cleanup unavailable");
  assert.deepEqual(await store.saveImmediate(state(1, "keep after commit")), {
    ok: true,
    value: { state: state(1, "keep after commit") },
  });
  assert.deepEqual(store.unsaved(), state(1, "keep after commit"));
  assert.equal(storage.draftValues.size, 1);
  storage.failDraftRemove = undefined;
  assert.deepEqual(store.read(), { ok: true, value: state(1, "keep after commit") });
  assert.equal(store.unsaved(), undefined);
});

test("retains a foreign recovery reference when post-commit tombstoning fails", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });
  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: state(1) });
  writer.scheduleNoteSave(state(1, "foreign recovery"));
  const recovered = new OrderedStateStore(storage);
  assert.deepEqual(recovered.read(), { ok: true, value: state(1) });
  assert.deepEqual(recovered.unsaved(), state(1, "foreign recovery"));

  storage.failTombstoneSet = new Error("tombstone unavailable");
  assert.deepEqual(await recovered.saveImmediate(state(1, "edited recovery")), {
    ok: true,
    value: { state: state(1, "edited recovery") },
  });
  assert.deepEqual(recovered.unsaved(), state(1, "foreign recovery"));
  assert.equal([...storage.draftValues.keys()].some((key) => key.includes(":tombstone:")), false);
  const foreignKey = [...storage.draftValues.keys()]
    .find((key) => storage.draftValues.get(key)?.includes("foreign recovery"));
  assert.equal(typeof foreignKey, "string");
  storage.draftValues.delete(foreignKey as string);
  storage.failTombstoneSet = undefined;
  assert.deepEqual(recovered.read(), { ok: true, value: state(1, "edited recovery") });
  assert.equal(recovered.unsaved(), undefined);
  assert.deepEqual(await recovered.saveImmediate(state(2, "later edit")), {
    ok: true,
    value: { state: state(2, "later edit") },
  });
  assert.equal(recovered.unsaved(), undefined);
});

test("keeps the draft heartbeat alive while an immediate save waits for the lock", async () => {
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const lock = new BlockingLock();
  storage.withLock = <T>(callback: () => Promise<T>) => lock.request(PRIVATE_STATE_LOCK_NAME, callback);
  const store = new OrderedStateStore(storage, clock);
  assert.deepEqual(store.read(), { ok: true, value: undefined });
  store.scheduleNoteSave(state(0, "pending before immediate"));
  const save = store.saveImmediate(state(1));
  await Promise.resolve();
  const writesBeforeHeartbeat = storage.draftWrites;
  clock.advance(5_000);
  assert.equal(storage.draftWrites, writesBeforeHeartbeat + 1);
  lock.release();
  assert.deepEqual(await save, { ok: true, value: { state: state(1) } });
  assert.equal(storage.draftValues.size, 0);
});

test("keeps the previous durable draft when replacing it fails", async () => {
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const store = new OrderedStateStore(storage, clock);
  store.scheduleNoteSave(state(0, "first draft"));
  const firstDraftKey = [...storage.draftValues.keys()][0];
  assert.equal(typeof firstDraftKey, "string");
  const firstDraft = storage.draftValues.get(firstDraftKey as string);
  assert.equal(typeof firstDraft, "string");

  storage.failDraftSet = new Error("quota");
  store.scheduleNoteSave(state(0, "second draft"));
  assert.equal(storage.draftValues.get(firstDraftKey as string), firstDraft);

  storage.failDraftSet = undefined;
  assert.deepEqual(await store.flushNote(), { ok: true, value: { state: state(0, "second draft") } });
  assert.equal(storage.draftValues.has(firstDraftKey as string), false);
});

test("falls back to an in-place active draft overwrite when rotation exceeds quota", async () => {
  const storage = new FakeStorage();
  const store = new OrderedStateStore(storage);
  store.scheduleNoteSave(state(0, "first draft"));
  const firstDraftKey = [...storage.draftValues.keys()][0];
  assert.equal(typeof firstDraftKey, "string");

  const quotaError = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
  storage.failRotatedDraftSet = quotaError;
  assert.deepEqual(store.scheduleNoteSave(state(0, "second draft")), { ok: true, value: undefined });
  assert.equal(storage.draftValues.size, 1);
  assert.equal(storage.draftValues.has(firstDraftKey as string), true);
  assert.equal([...storage.draftValues.keys()].some((key) => key.includes(":rotated:")), false);

  storage.failRotatedDraftSet = undefined;
  assert.deepEqual(await store.flushNote(), { ok: true, value: { state: state(0, "second draft") } });
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(0, "second draft") });
});

test("does not use the quota fallback after a tombstone appears", () => {
  const storage = new FakeStorage();
  const store = new OrderedStateStore(storage);
  store.scheduleNoteSave(state(0, "first draft"));
  const firstDraftKey = [...storage.draftValues.keys()][0];
  assert.equal(typeof firstDraftKey, "string");

  const quotaError = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
  storage.failRotatedDraftSet = quotaError;
  storage.beforeRotatedDraftQuota = () => {
    const raw = storage.draftValues.get(firstDraftKey as string);
    assert.equal(typeof raw, "string");
    const record = JSON.parse(raw as string) as Record<string, unknown>;
    record.ownerState = "inactive";
    storage.draftValues.set(firstDraftKey as string, JSON.stringify(record));
    const tombstoneKey = `${PRIVATE_STATE_NOTE_DRAFT_KEY}:tombstone:${encodeURIComponent(String(record.draftId))}:${encodeURIComponent(firstDraftKey as string)}:${encodeURIComponent(String(record.revision))}`;
    storage.draftValues.set(tombstoneKey, JSON.stringify({
      schema: "snoredex-checklist.pending-note-tombstone",
      schemaVersion: 1,
      sourceKey: firstDraftKey,
      sourceDraftId: record.draftId,
      sourceRevision: record.revision,
      consumedAt: Date.now(),
    }));
  };

  assert.deepEqual(store.scheduleNoteSave(state(0, "second draft")), {
    ok: false,
    error: "STORAGE_QUOTA_EXCEEDED",
  });
  assert.equal(storage.draftValues.get(firstDraftKey as string)?.includes("second draft"), false);
  assert.equal([...storage.draftValues.keys()].some((key) => key.includes(":rotated:")), false);
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

test("immediate saves are not superseded by a note scheduled in the same task", async () => {
  const storage = new FakeStorage();
  const clock = new FakeClock();
  const store = new OrderedStateStore(storage, clock);
  const immediate = store.saveImmediate(state(1));
  store.scheduleNoteSave(state(1, "same task note"));

  assert.deepEqual(await immediate, { ok: true, value: { state: state(1) } });
  assert.equal(storage.writes, 1);
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(1) });

  assert.deepEqual(await store.flushNote(), { ok: true, value: { state: state(1, "same task note") } });
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(1, "same task note") });
});

test("detects a concurrent tab write before replacing the observed envelope", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const firstTab = new OrderedStateStore(storage);
  const secondTab = new OrderedStateStore(storage);
  assert.deepEqual(firstTab.read(), { ok: true, value: state(1) });
  assert.deepEqual(secondTab.read(), { ok: true, value: state(1) });
  assert.deepEqual(await firstTab.saveImmediate(state(2)), { ok: true, value: { state: state(2) } });

  assert.deepEqual(await secondTab.saveImmediate(state(3)), {
    ok: false,
    error: "STORAGE_COMMIT_UNCERTAIN",
  });
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(2) });
  assert.deepEqual(secondTab.unsaved(), state(3));
});

test("coordinates the complete cross-tab commit through one lock", async () => {
  const storage = new FakeStorage();
  const lock = new FakeLock();
  storage.withLock = <T>(callback: () => Promise<T>) => lock.request(PRIVATE_STATE_LOCK_NAME, callback);
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const firstTab = new OrderedStateStore(storage);
  const secondTab = new OrderedStateStore(storage);
  assert.deepEqual(firstTab.read(), { ok: true, value: state(1) });
  assert.deepEqual(secondTab.read(), { ok: true, value: state(1) });
  const first = firstTab.saveImmediate(state(2));
  const second = secondTab.saveImmediate(state(3));
  const results = await Promise.all([first, second]);

  assert.equal(lock.maximumActive, 1);
  assert.deepEqual(results, [
    { ok: true, value: { state: state(2) } },
    { ok: false, error: "STORAGE_COMMIT_UNCERTAIN" },
  ]);
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(2) });
});

test("rejects an unobserved existing envelope instead of adopting it as a baseline", async () => {
  const storage = new FakeStorage();
  const seed = new OrderedStateStore(storage);
  assert.deepEqual(await seed.saveImmediate(state(1)), { ok: true, value: { state: state(1) } });

  const uninitialized = new OrderedStateStore(storage);
  assert.deepEqual(await uninitialized.saveImmediate(state(2)), {
    ok: false,
    error: "STORAGE_COMMIT_UNCERTAIN",
  });
  assert.deepEqual(new OrderedStateStore(storage).read(), { ok: true, value: state(1) });
  assert.deepEqual(uninitialized.unsaved(), state(2));
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

test("restores a valid recovery draft while rejecting a malformed canonical envelope", () => {
  const storage = new FakeStorage();
  const writer = new OrderedStateStore(storage);
  assert.deepEqual(writer.read(), { ok: true, value: undefined });
  writer.scheduleNoteSave(state(0, "recover despite malformed canonical state"));
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, "not-json");

  const restored = new OrderedStateStore(storage);
  assert.deepEqual(restored.read(), { ok: false, error: "LOCAL_STATE_UNREADABLE" });
  assert.deepEqual(restored.unsaved(), state(0, "recover despite malformed canonical state"));
});

test("never overwrites an unreadable existing value", async () => {
  const storage = new FakeStorage();
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, "corrupt");
  const store = new OrderedStateStore(storage);
  assert.deepEqual(await store.saveImmediate(state(1)), { ok: false, error: "LOCAL_STATE_UNREADABLE" });
  assert.equal(storage.values.get(PRIVATE_STATE_STORAGE_KEY), "corrupt");
});
