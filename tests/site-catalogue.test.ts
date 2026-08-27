import assert from "node:assert/strict";
import test from "node:test";

import fixture from "./fixtures/collector-catalogue.fixture.json" with { type: "json" };
import { semanticFingerprint } from "../src/catalogue/validate.ts";
import { localizationLabel, partitionByActivity, validateProvenance, validateSnapshot } from "../src/site/catalogue.ts";

function reseal(value: any): any {
  value.meta.catalogueFingerprint = semanticFingerprint(value);
  return value;
}

test("accepts the reviewed browser snapshot shape", async () => {
  assert.equal((await validateSnapshot(fixture.catalogue)).ok, true);
});

test("validates generated provenance and keeps localization labels nonempty", () => {
  const valid = {
    mode: "synthetic-fixture",
    sourceCommit: "synthetic-fixture",
    contractVersion: fixture.catalogue.meta.schemaVersion,
    sourceRepository: fixture.catalogue.meta.sourceRepository,
  };
  assert.equal(validateProvenance(valid, fixture.catalogue), true);
  assert.equal(validateProvenance({ ...valid, contractVersion: "0.0.0" }, fixture.catalogue), false);
  assert.equal(validateProvenance({ ...valid, mode: {} }, fixture.catalogue), false);
  assert.equal(localizationLabel({ localizationId: "loc-1", displayName: "  ", languageTag: " en " }), "en");
  assert.equal(localizationLabel({ localizationId: "loc-2", displayName: "  Spanish  ", languageTag: "en" }), "Spanish");
});

test("keeps inactive items separate from active results", async () => {
  const inactive = structuredClone(fixture.catalogue);
  inactive.items[0].active = false;
  const validation = await validateSnapshot(reseal(inactive));
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const partition = partitionByActivity(validation.snapshot.items);
  assert.equal(partition.active.some((item) => item.itemId === inactive.items[0].itemId), false);
  assert.equal(partition.inactive.some((item) => item.itemId === inactive.items[0].itemId), true);
});

test("fails closed on invalid provenance metadata", async () => {
  const invalidSource = structuredClone(fixture.catalogue);
  (invalidSource.meta as Record<string, unknown>).sourceRepository = {};
  assert.deepEqual(await validateSnapshot(reseal(invalidSource)), { ok: false, reason: "invalid" });

  const invalidDate = structuredClone(fixture.catalogue);
  invalidDate.meta.dataAsOf = "2026-02-30";
  assert.deepEqual(await validateSnapshot(reseal(invalidDate)), { ok: false, reason: "invalid" });

  const invalidAssetBase = structuredClone(fixture.catalogue);
  invalidAssetBase.meta.assetBaseUrl = "not-a-uri";
  assert.deepEqual(await validateSnapshot(reseal(invalidAssetBase)), { ok: false, reason: "invalid" });
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

test("fails closed on invalid localization presentation fields", async () => {
  const invalidName = structuredClone(fixture.catalogue);
  (invalidName.localizations[0] as Record<string, unknown>).displayName = {};
  assert.deepEqual(await validateSnapshot(reseal(invalidName)), { ok: false, reason: "invalid" });

  const invalidOrder = structuredClone(fixture.catalogue);
  (invalidOrder.localizations[0] as Record<string, unknown>).displayOrder = 1.5;
  assert.deepEqual(await validateSnapshot(reseal(invalidOrder)), { ok: false, reason: "invalid" });
});

test("fails closed when an item card name is missing or empty", async () => {
  const missing = structuredClone(fixture.catalogue);
  delete (missing.items[0] as Record<string, unknown>).cardName;
  assert.deepEqual(await validateSnapshot(reseal(missing)), { ok: false, reason: "invalid" });

  const empty = structuredClone(fixture.catalogue);
  empty.items[0].cardName = "";
  assert.deepEqual(await validateSnapshot(reseal(empty)), { ok: false, reason: "invalid" });
});

test("fails closed on invalid rendered item presentation fields", async () => {
  for (const field of ["localSetCode", "collectorNumber", "localCardName"] as const) {
    const missing = structuredClone(fixture.catalogue);
    delete (missing.items[0] as Record<string, unknown>)[field];
    assert.deepEqual(await validateSnapshot(reseal(missing)), { ok: false, reason: "invalid" });

    const invalid = structuredClone(fixture.catalogue);
    (invalid.items[0] as Record<string, unknown>)[field] = {};
    assert.deepEqual(await validateSnapshot(reseal(invalid)), { ok: false, reason: "invalid" });
  }
});

test("fails closed when content does not match its declared fingerprint", async () => {
  const corrupted = structuredClone(fixture.catalogue);
  corrupted.items[0].cardName = "Corrupted snapshot";
  assert.deepEqual(await validateSnapshot(corrupted), { ok: false, reason: "invalid" });
});
