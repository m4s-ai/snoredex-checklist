import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_NOTE_CODE_POINTS,
  PRIVATE_DATASET_ID,
  PRIVATE_STATE_SCHEMA,
  PRIVATE_STATE_VERSION,
  applyNoteEdit,
  applyQuantityEdit,
  applyStatusCommand,
  serializePortableState,
  serializePrivateState,
  validatePortableState,
  validatePrivateState,
  type PrivateState,
} from "../src/state/domain.ts";

const fingerprint = "sha256:" + "a".repeat(64);
const itemA = "item-00000000-0000-0000-0000-00000000000a";
const itemB = "item-00000000-0000-0000-0000-00000000000b";

function state(items: unknown[] = []): PrivateState {
  return {
    schema: PRIVATE_STATE_SCHEMA,
    schemaVersion: PRIVATE_STATE_VERSION,
    datasetId: PRIVATE_DATASET_ID,
    catalogueFingerprint: fingerprint,
    items: items as PrivateState["items"],
  };
}

function record(itemId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId,
    status: "have",
    quantityOwned: 1,
    quantityOrdered: 0,
    ...overrides,
  };
}

test("normalizes status commands and preserves compatible quantities", () => {
  const ordered = applyStatusCommand(itemA, undefined, "ordered");
  assert.deepEqual(ordered, {
    ok: true,
    value: { itemId: itemA, status: "ordered", quantityOwned: 0, quantityOrdered: 1 },
  });
  const have = applyStatusCommand(itemA, ordered.ok ? ordered.value : undefined, "have");
  assert.equal(have.ok, true);
  if (have.ok) {
    assert.equal(have.value?.status, "have");
    assert.equal(have.value?.quantityOwned, 1);
    assert.equal(have.value?.quantityOrdered, 1);
  }
  const skip = applyStatusCommand(itemA, have.ok ? have.value : undefined, "skip");
  assert.deepEqual(skip, {
    ok: true,
    value: { itemId: itemA, status: "skip", quantityOwned: 0, quantityOrdered: 0 },
  });
  assert.deepEqual(applyStatusCommand(itemA, skip.ok ? skip.value : undefined, "need"), {
    ok: true,
    value: undefined,
  });
});

test("quantity edits validate before deriving status and prune only the implicit default", () => {
  assert.deepEqual(applyQuantityEdit(itemA, undefined, 0, 0), { ok: true, value: undefined });
  assert.equal(applyQuantityEdit(itemA, undefined, 1, 0).ok, true);
  assert.equal(applyQuantityEdit(itemA, undefined, 0, 1).ok, true);
  for (const invalid of [-1, 10_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) {
    assert.deepEqual(applyQuantityEdit(itemA, undefined, invalid, 0), {
      ok: false,
      error: "EDIT_INVALID_QUANTITY",
    });
  }
  assert.deepEqual(applyQuantityEdit(itemA, undefined, 0, 9_999), {
    ok: true,
    value: { itemId: itemA, status: "ordered", quantityOwned: 0, quantityOrdered: 9_999 },
  });
});

test("notes preserve meaningful multiline text and remove whitespace-only values", () => {
  const meaningful = applyNoteEdit(itemA, undefined, "  first\r\nsecond\r  ");
  assert.deepEqual(meaningful, {
    ok: true,
    value: {
      itemId: itemA,
      status: "need",
      quantityOwned: 0,
      quantityOrdered: 0,
      note: "  first\nsecond\n  ",
    },
  });
  assert.deepEqual(applyNoteEdit(itemA, undefined, " \r\n\t "), { ok: true, value: undefined });
  assert.deepEqual(applyNoteEdit(itemA, undefined, "x".repeat(MAX_NOTE_CODE_POINTS + 1)), {
    ok: false,
    error: "EDIT_INVALID_NOTE",
  });
  assert.deepEqual(applyNoteEdit(itemA, undefined, "\ud800"), {
    ok: false,
    error: "EDIT_INVALID_NOTE",
  });
});

test("rejects unknown fields, inconsistent records and duplicate IDs without copying input", () => {
  const unknown = validatePrivateState({ ...state(), unexpected: true });
  assert.deepEqual(unknown, { ok: false, error: "IMPORT_UNKNOWN_FIELD" });
  const invalid = validatePrivateState(state([record(itemA, { status: "have", quantityOwned: 0 })]));
  assert.deepEqual(invalid, { ok: false, error: "IMPORT_INVALID_STATE_DATA" });
  assert.deepEqual(validatePrivateState(state([record(itemA, { note: undefined })])), {
    ok: false,
    error: "IMPORT_INVALID_STATE_DATA",
  });
  const duplicate = validatePrivateState(state([record(itemA), record(itemA, { quantityOwned: 2 })]));
  assert.deepEqual(duplicate, { ok: false, error: "IMPORT_DUPLICATE_ITEM_ID" });
  const hostile = JSON.parse(
    `{"schema":"${PRIVATE_STATE_SCHEMA}","schemaVersion":"${PRIVATE_STATE_VERSION}","datasetId":"${PRIVATE_DATASET_ID}","catalogueFingerprint":"${fingerprint}","items":[{"itemId":"${itemB}","status":"skip","quantityOwned":0,"quantityOrdered":0,"__proto__":"x"}]}`,
  );
  assert.deepEqual(validatePrivateState(hostile), { ok: false, error: "IMPORT_UNKNOWN_FIELD" });
  assert.deepEqual(validatePrivateState(state([{ itemId: itemA, status: "need", quantityOwned: 0, quantityOrdered: 0 }]), new Set([itemB])), {
    ok: false,
    error: "IMPORT_INVALID_STATE_DATA",
  });
});

test("prunes default records, keeps research-independent opaque IDs and sorts canonical output", () => {
  const candidate = state([
    { itemId: itemB, status: "skip", quantityOwned: 0, quantityOrdered: 0 },
    { itemId: itemA, status: "need", quantityOwned: 0, quantityOrdered: 0 },
  ]);
  const parsed = validatePrivateState(candidate);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.items, [
    { itemId: itemB, status: "skip", quantityOwned: 0, quantityOrdered: 0 },
  ]);
  const serialized = serializePrivateState(candidate);
  assert.equal(serialized.ok, true);
  if (serialized.ok) {
    assert.match(serialized.value, /"items": \[\n    \{\n      "itemId": "item-00000000-0000-0000-0000-00000000000b"/);
    assert.equal(serialized.value.endsWith("\n"), true);
    assert.equal(serialized.value.includes("\r"), false);
  }
});

test("portable serialization and validation retain fixed diagnostic metadata", () => {
  const appRevision = "b".repeat(40);
  const exportedAt = "2026-08-25T18:00:00.000Z";
  const serialized = serializePortableState(state([record(itemA)]), { exportedAt, appRevision });
  assert.equal(serialized.ok, true);
  if (!serialized.ok) return;
  const portable = JSON.parse(serialized.value) as Record<string, unknown>;
  assert.deepEqual(validatePortableState(portable), {
    ok: true,
    value: {
      ...state([record(itemA)]),
      items: [record(itemA)],
      exportedAt,
      appRevision,
    },
  });
  assert.deepEqual(validatePortableState({ ...portable, appRevision: "B".repeat(40) }), {
    ok: false,
    error: "IMPORT_INVALID_STATE_DATA",
  });
});
