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

test("fails closed on orphan editions and duplicate physical printings", () => {
  const orphanEdition = structuredClone(fixture.catalogue);
  orphanEdition.setEditions[0].localizationId = "missing-localization";
  assert.deepEqual(validateSnapshot(orphanEdition), { ok: false, reason: "invalid" });

  const duplicatePrinting = structuredClone(fixture.catalogue);
  duplicatePrinting.items.push({
    ...duplicatePrinting.items[0],
    itemId: "item-00000000-0000-5000-8000-000000000004"
  });
  assert.deepEqual(validateSnapshot(duplicatePrinting), { ok: false, reason: "invalid" });
});

test("fails closed on duplicate locality-language projections", () => {
  const duplicateProjection = structuredClone(fixture.catalogue);
  duplicateProjection.localizations[1].locality = duplicateProjection.localizations[0].locality;
  duplicateProjection.localizations[1].languageTag = duplicateProjection.localizations[0].languageTag;
  assert.deepEqual(validateSnapshot(duplicateProjection), { ok: false, reason: "invalid" });
});
