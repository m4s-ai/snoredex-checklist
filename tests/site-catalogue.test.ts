import assert from "node:assert/strict";
import test from "node:test";

import fixture from "./fixtures/collector-catalogue.fixture.json" with { type: "json" };
import { semanticFingerprint } from "../src/catalogue/validate.ts";
import { validateSnapshot } from "../src/site/catalogue.ts";

function reseal(value: any): any {
  value.meta.catalogueFingerprint = semanticFingerprint(value);
  return value;
}

test("accepts the reviewed browser snapshot shape", async () => {
  assert.equal((await validateSnapshot(fixture.catalogue)).ok, true);
});

test("fails closed on dangling references and invalid item classes", async () => {
  const dangling = structuredClone(fixture.catalogue);
  dangling.items[0].setEditionId = "missing-edition";
  assert.deepEqual(await validateSnapshot(reseal(dangling)), { ok: false, reason: "invalid" });

  const invalidClass = structuredClone(fixture.catalogue);
  invalidClass.items[0].itemKind = "research-placeholder";
  assert.deepEqual(await validateSnapshot(reseal(invalidClass)), { ok: false, reason: "invalid" });
});

test("fails closed on orphan editions and duplicate physical printings", async () => {
  const orphanEdition = structuredClone(fixture.catalogue);
  orphanEdition.setEditions[0].localizationId = "missing-localization";
  assert.deepEqual(await validateSnapshot(reseal(orphanEdition)), { ok: false, reason: "invalid" });

  const duplicatePrinting = structuredClone(fixture.catalogue);
  duplicatePrinting.items.push({
    ...duplicatePrinting.items[0],
    itemId: "item-00000000-0000-5000-8000-000000000004"
  });
  assert.deepEqual(await validateSnapshot(reseal(duplicatePrinting)), { ok: false, reason: "invalid" });
});

test("fails closed on duplicate locality-language projections", async () => {
  const duplicateProjection = structuredClone(fixture.catalogue);
  duplicateProjection.localizations[1].locality = duplicateProjection.localizations[0].locality;
  duplicateProjection.localizations[1].languageTag = duplicateProjection.localizations[0].languageTag;
  assert.deepEqual(await validateSnapshot(reseal(duplicateProjection)), { ok: false, reason: "invalid" });
});

test("fails closed when an item card name is missing or empty", async () => {
  const missing = structuredClone(fixture.catalogue);
  delete (missing.items[0] as Record<string, unknown>).cardName;
  assert.deepEqual(await validateSnapshot(reseal(missing)), { ok: false, reason: "invalid" });

  const empty = structuredClone(fixture.catalogue);
  empty.items[0].cardName = "";
  assert.deepEqual(await validateSnapshot(reseal(empty)), { ok: false, reason: "invalid" });
});

test("fails closed when content does not match its declared fingerprint", async () => {
  const corrupted = structuredClone(fixture.catalogue);
  corrupted.items[0].cardName = "Corrupted snapshot";
  assert.deepEqual(await validateSnapshot(corrupted), { ok: false, reason: "invalid" });
});
