import assert from "node:assert/strict";
import test from "node:test";
import { readPrivateState } from "../src/site/private-state.ts";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;
const ITEM_ID = "item-a";

async function withStorage<T>(raw: string | null, callback: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (): string | null => raw },
  });
  try {
    return await callback();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", previous);
  }
}

test("defers malformed private storage", async () => {
  const state = await withStorage("malformed", () => readPrivateState(
    FINGERPRINT,
    new Set([ITEM_ID]),
    () => ({ ok: false }),
  ));
  assert.equal(state.readable, false);
  assert.equal(state.hasActiveState, false);
  assert.equal(state.statuses.size, 0);
});

test("defers a private state from another catalogue fingerprint", async () => {
  const state = await withStorage("stale", () => readPrivateState(
    FINGERPRINT,
    new Set([ITEM_ID]),
    () => ({
      ok: true,
      active: { catalogueFingerprint: "sha256:stale", items: [] },
    }),
  ));
  assert.equal(state.readable, false);
  assert.equal(state.hasActiveState, true);
  assert.equal(state.statuses.size, 0);
});

test("defers private state containing an unknown item ID", async () => {
  const state = await withStorage("orphan", () => readPrivateState(
    FINGERPRINT,
    new Set([ITEM_ID]),
    () => ({
      ok: true,
      active: {
        catalogueFingerprint: FINGERPRINT,
        items: [
          { itemId: ITEM_ID, status: "have" },
          { itemId: "orphan", status: "ordered" },
        ],
      },
    }),
  ));
  assert.equal(state.readable, false);
  assert.equal(state.hasActiveState, true);
  assert.equal(state.statuses.size, 0);
});

test("projects valid private state statuses", async () => {
  const state = await withStorage("valid", () => readPrivateState(
    FINGERPRINT,
    new Set([ITEM_ID]),
    () => ({
      ok: true,
      active: {
        catalogueFingerprint: FINGERPRINT,
        items: [{ itemId: ITEM_ID, status: "have" }],
      },
    }),
  ));
  assert.equal(state.readable, true);
  assert.equal(state.hasActiveState, true);
  assert.equal(state.statuses.get(ITEM_ID), "have");
});
