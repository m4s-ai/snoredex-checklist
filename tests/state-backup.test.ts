import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PORTABLE_BYTES,
  PrivateStateLifecycle,
  SUGGESTED_BACKUP_FILENAME,
  buildImportPreview,
  createPortableBackup,
  parsePortableBackup,
} from "../src/state/backup.ts";
import {
  OrderedStateStore,
  PRIVATE_STATE_RECOVERY_STORAGE_KEY,
  PRIVATE_STATE_STORAGE_KEY,
  type StorageLike,
} from "../src/state/storage.ts";
import {
  PRIVATE_DATASET_ID,
  PRIVATE_STATE_SCHEMA,
  PRIVATE_STATE_VERSION,
  type PrivateState,
  validatePrivateState,
} from "../src/state/domain.ts";

const fingerprint = "sha256:" + "a".repeat(64);
const otherFingerprint = "sha256:" + "b".repeat(64);
const itemA = "item-00000000-0000-0000-0000-00000000000a";
const knownItemIds = new Set([itemA]);

function state(note?: string, catalogueFingerprint = fingerprint): PrivateState {
  return {
    schema: PRIVATE_STATE_SCHEMA,
    schemaVersion: PRIVATE_STATE_VERSION,
    datasetId: PRIVATE_DATASET_ID,
    catalogueFingerprint,
    items: note === undefined
      ? []
      : [{ itemId: itemA, status: "have", quantityOwned: 2, quantityOrdered: 1, note }],
  };
}

class FakeStorage implements StorageLike {
  public values = new Map<string, string>();
  public withLock: StorageLike["withLock"] = async (callback) => callback();

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

class FailRecoveryWriteStorage extends FakeStorage {
  public activeWrites = 0;

  public override setItem(key: string, value: string): void {
    if (key === PRIVATE_STATE_RECOVERY_STORAGE_KEY && value !== "null") {
      throw new Error("recovery write failed");
    }
    if (key === PRIVATE_STATE_STORAGE_KEY) this.activeWrites += 1;
    super.setItem(key, value);
  }
}

const appRevision = "c".repeat(40);
const exportedAt = "2026-08-26T10:00:00.000Z";

test("portable export is bounded, private-labelled and round-trips", () => {
  const exported = createPortableBackup(state("line one\nline two"), { appRevision, exportedAt });
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  assert.equal(exported.value.filename, SUGGESTED_BACKUP_FILENAME);
  assert.equal(exported.value.text.includes("line one\\nline two"), true);
  assert.equal(exported.value.bytes.byteLength, new TextEncoder().encode(exported.value.text).byteLength);
  const parsed = parsePortableBackup(exported.value.bytes);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.state, { ...state("line one\nline two"), exportedAt, appRevision });
});

test("import validation fails closed before preview", () => {
  assert.deepEqual(parsePortableBackup(new Uint8Array(MAX_PORTABLE_BYTES + 1)), {
    ok: false,
    error: "IMPORT_FILE_TOO_LARGE",
  });
  assert.deepEqual(parsePortableBackup(new Uint8Array([0xc3, 0x28])), {
    ok: false,
    error: "IMPORT_INVALID_ENCODING",
  });
  assert.deepEqual(parsePortableBackup(new TextEncoder().encode("{not json")), {
    ok: false,
    error: "IMPORT_INVALID_JSON",
  });
  const exported = createPortableBackup(state("private"), { appRevision, exportedAt });
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const candidate = JSON.parse(exported.value.text) as Record<string, unknown>;
  candidate.untrusted = "ignore";
  assert.deepEqual(parsePortableBackup(new TextEncoder().encode(JSON.stringify(candidate))), {
    ok: false,
    error: "IMPORT_UNKNOWN_FIELD",
  });
});

test("preview exposes only safe aggregates and blocks unknown fingerprints", () => {
  const candidate = state("private");
  const preview = buildImportPreview(candidate, state(), fingerprint);
  assert.deepEqual(preview, {
    ok: true,
    value: {
      mode: "create",
      sourceFingerprint: fingerprint,
      targetFingerprint: fingerprint,
      schemaVersion: PRIVATE_STATE_VERSION,
      explicitRecordCount: 1,
      statusCounts: { need: 0, ordered: 0, have: 1, skip: 0 },
      quantityOwned: 2,
      quantityOrdered: 1,
      noteCount: 1,
      recordsToReplace: 0,
    },
  });
  assert.deepEqual(buildImportPreview(candidate, undefined, otherFingerprint), {
    ok: false,
    error: "STATE_FINGERPRINT_UNSUPPORTED",
  });
  assert.deepEqual(buildImportPreview(candidate, undefined, undefined), {
    ok: false,
    error: "STATE_FINGERPRINT_UNSUPPORTED",
  });
});

test("replacement keeps a validated recovery copy and ordinary saves preserve it", async () => {
  const storage = new FakeStorage();
  const old = state("old private note");
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(old));
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const imported = createPortableBackup(state("new private note"), { appRevision, exportedAt });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const plan = lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.value.preview.mode, "replace");
  const committed = await lifecycle.commitImport(plan.value, true);
  assert.equal(committed.ok, true);
  if (!committed.ok) return;
  assert.equal(committed.value.recovery?.items[0]?.note, "old private note");
  assert.equal(validatePrivateState(JSON.parse(storage.values.get(PRIVATE_STATE_STORAGE_KEY) ?? "null")).ok, true);
  assert.notEqual(storage.values.get(PRIVATE_STATE_RECOVERY_STORAGE_KEY), "null");
  assert.equal(new OrderedStateStore(storage).read().ok, true);
  const ordinarySave = new OrderedStateStore(storage);
  const current = ordinarySave.read();
  assert.equal(current.ok, true);
  if (!current.ok || current.value === undefined) return;
  const saved = await ordinarySave.saveImmediate({ ...current.value, items: [] });
  assert.equal(saved.ok, true);
  assert.equal(lifecycle.read().ok, true);
  const recovery = lifecycle.read();
  assert.equal(recovery.ok, true);
  if (recovery.ok) assert.equal(recovery.value.recovery?.items[0]?.note, "old private note");
});

test("keeps the active storage key readable for a rollback build", async () => {
  const storage = new FakeStorage();
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(state("rollback-safe")));
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  assert.equal((await lifecycle.clear(true)).ok, true);

  const activeRaw = storage.values.get(PRIVATE_STATE_STORAGE_KEY);
  assert.equal(typeof activeRaw, "string");
  const legacyRead = validatePrivateState(JSON.parse(activeRaw as string));
  assert.equal(legacyRead.ok, true);
  assert.equal(storage.values.get(PRIVATE_STATE_RECOVERY_STORAGE_KEY)?.includes("rollback-safe"), true);
});

test("migrates an earlier authority envelope recovery slot before an ordinary save", async () => {
  const storage = new FakeStorage();
  const active = state("active");
  const recovery = state("recovery");
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify({
    schema: "snoredex-private-state-authority",
    schemaVersion: 1,
    active,
    recovery,
  }));
  const store = new OrderedStateStore(storage);
  assert.deepEqual(store.read(), { ok: true, value: active });
  assert.deepEqual(await store.saveImmediate({ ...active, items: [] }), {
    ok: true,
    value: { state: { ...active, items: [] } },
  });
  assert.equal(validatePrivateState(JSON.parse(storage.values.get(PRIVATE_STATE_STORAGE_KEY) ?? "null")).ok, true);
  assert.equal(storage.values.get(PRIVATE_STATE_RECOVERY_STORAGE_KEY)?.includes("recovery"), true);
});

test("migrates newer envelope recovery over a stale sidecar", async () => {
  const storage = new FakeStorage();
  const active = state("active");
  const recovery = state("new recovery");
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify({
    schema: "snoredex-private-state-authority",
    schemaVersion: 1,
    active,
    recovery,
  }));
  storage.values.set(PRIVATE_STATE_RECOVERY_STORAGE_KEY, JSON.stringify(state("stale recovery")));
  const store = new OrderedStateStore(storage);
  assert.deepEqual(store.read(), { ok: true, value: active });
  assert.deepEqual(await store.saveImmediate({ ...active, items: [] }), {
    ok: true,
    value: { state: { ...active, items: [] } },
  });
  assert.equal(storage.values.get(PRIVATE_STATE_RECOVERY_STORAGE_KEY)?.includes("new recovery"), true);
  assert.equal(storage.values.get(PRIVATE_STATE_RECOVERY_STORAGE_KEY)?.includes("stale recovery"), false);
});

test("clears a stale sidecar when an earlier envelope explicitly consumed recovery", async () => {
  const storage = new FakeStorage();
  const active = state("active");
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify({
    schema: "snoredex-private-state-authority",
    schemaVersion: 1,
    active,
    recovery: null,
  }));
  storage.values.set(PRIVATE_STATE_RECOVERY_STORAGE_KEY, JSON.stringify(state("consumed recovery")));
  const store = new OrderedStateStore(storage);
  assert.deepEqual(store.read(), { ok: true, value: active });
  assert.deepEqual(await store.saveImmediate({ ...active, items: [] }), {
    ok: true,
    value: { state: { ...active, items: [] } },
  });
  assert.equal(storage.values.get(PRIVATE_STATE_RECOVERY_STORAGE_KEY), "null");
});

test("ignores malformed sidecar bytes while a valid envelope remains authoritative", async () => {
  const storage = new FakeStorage();
  const active = state("active");
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify({
    schema: "snoredex-private-state-authority",
    schemaVersion: 1,
    active,
    recovery: null,
  }));
  storage.values.set(PRIVATE_STATE_RECOVERY_STORAGE_KEY, "{stale-sidecar");
  const store = new OrderedStateStore(storage);
  assert.deepEqual(store.read(), { ok: true, value: active });
  assert.deepEqual(await store.saveImmediate({ ...active, items: [] }), {
    ok: true,
    value: { state: { ...active, items: [] } },
  });
  assert.equal(storage.values.get(PRIVATE_STATE_RECOVERY_STORAGE_KEY), "null");
});

test("writes recovery before active replacement and leaves active state untouched when recovery fails", async () => {
  const storage = new FailRecoveryWriteStorage();
  const original = state("keep me");
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(original));
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  assert.deepEqual(await lifecycle.clear(true), { ok: false, error: "STORAGE_WRITE_FAILED" });
  assert.equal(storage.activeWrites, 0);
  assert.deepEqual(JSON.parse(storage.values.get(PRIVATE_STATE_STORAGE_KEY) ?? "null"), original);
});

test("clear and restore use one recoverable slot and swap without merging", async () => {
  const storage = new FakeStorage();
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(state("keep me")));
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const cleared = await lifecycle.clear(true);
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.deepEqual(cleared.value.active?.items, []);
  assert.equal(cleared.value.recovery?.items[0]?.note, "keep me");
  const restored = await lifecycle.restore(true, fingerprint, knownItemIds);
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(restored.value.active?.items[0]?.note, "keep me");
  assert.equal(restored.value.recovery, undefined);
});

test("restore fails closed when recovery is not valid for the active catalogue", async () => {
  const storage = new FakeStorage();
  const storedRecovery = state("keep me");
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(storedRecovery));
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  assert.equal((await lifecycle.clear(true)).ok, true);
  assert.deepEqual(await lifecycle.restore(true, otherFingerprint, knownItemIds), {
    ok: false,
    error: "STATE_FINGERPRINT_UNSUPPORTED",
  });

  const unknownItemRecovery = { ...storedRecovery, items: [{ ...storedRecovery.items[0], itemId: "item-00000000-0000-0000-0000-00000000000b" }] };
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify({
    schema: "snoredex-private-state-authority",
    schemaVersion: 1,
    active: { ...storedRecovery, items: [] },
    recovery: unknownItemRecovery,
  }));
  assert.deepEqual(await lifecycle.restore(true, fingerprint, knownItemIds), {
    ok: false,
    error: "IMPORT_INVALID_STATE_DATA",
  });
});

test("a stale preview cannot replace a newer local collection", async () => {
  const storage = new FakeStorage();
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(state("first")));
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  const imported = createPortableBackup(state("candidate"), { appRevision, exportedAt });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const plan = lifecycle.prepareImport(imported.value.bytes, fingerprint, knownItemIds);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  storage.values.set(PRIVATE_STATE_STORAGE_KEY, JSON.stringify(state("newer")));
  assert.deepEqual(await lifecycle.commitImport(plan.value, true), {
    ok: false,
    error: "STATE_CHANGED_DURING_OPERATION",
  });
  assert.equal(JSON.parse(storage.values.get(PRIVATE_STATE_STORAGE_KEY) ?? "{}").items[0].note, "newer");
});

test("import rejects a validly shaped item that is absent from the trusted catalogue set", () => {
  const exported = createPortableBackup(state("private"), { appRevision, exportedAt });
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const candidate = JSON.parse(exported.value.text) as { items: Array<Record<string, unknown>> };
  candidate.items[0].itemId = "item-00000000-0000-0000-0000-00000000000b";
  const storage = new FakeStorage();
  const lifecycle = new PrivateStateLifecycle(storage, { appRevision, now: () => exportedAt });
  assert.deepEqual(lifecycle.prepareImport(
    new TextEncoder().encode(JSON.stringify(candidate)),
    fingerprint,
    knownItemIds,
  ), {
    ok: false,
    error: "IMPORT_INVALID_STATE_DATA",
  });
});
