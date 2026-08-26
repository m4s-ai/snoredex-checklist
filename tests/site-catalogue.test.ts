import assert from "node:assert/strict";
import test from "node:test";

import fixture from "./fixtures/collector-catalogue.fixture.json" with { type: "json" };
import { validateSnapshot } from "../src/site/catalogue.ts";

test("accepts the reviewed browser snapshot shape", () => {
  assert.equal(validateSnapshot(fixture.catalogue).ok, true);
});

test("fails closed on dangling references and invalid item classes", () => {
  const dangling = structuredClone(fixture.catalogue);
  dangling.items[0].setEditionId = "missing-edition";
  assert.deepEqual(validateSnapshot(dangling), { ok: false, reason: "invalid" });

  const invalidClass = structuredClone(fixture.catalogue);
  invalidClass.items[0].itemKind = "research-placeholder";
  assert.deepEqual(validateSnapshot(invalidClass), { ok: false, reason: "invalid" });
});
