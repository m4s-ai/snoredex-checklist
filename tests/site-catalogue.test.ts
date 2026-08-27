import assert from "node:assert/strict";
import test from "node:test";

import fixture from "./fixtures/collector-catalogue.fixture.json" with { type: "json" };
import { semanticFingerprint } from "../src/catalogue/validate.ts";
import { localizationLabel, validateProvenance, validateSnapshot } from "../src/site/catalogue.ts";
import { matchesResearch } from "../src/site/filter.ts";
import { buildBrowseHierarchy, buildProgressViewModel, buildResultViewModel } from "../src/site/results.ts";

function reseal(value: any): any {
  value.meta.catalogueFingerprint = semanticFingerprint(value);
  return value;
}

test("accepts the reviewed browser snapshot shape", async () => {
  assert.equal((await validateSnapshot(fixture.catalogue)).ok, true);
});

test("accepts schema-valid empty sort keys", async () => {
  const emptySortKeys = structuredClone(fixture.catalogue);
  emptySortKeys.localSets[0].sortKey = "";
  emptySortKeys.setEditions[0].sortKey = "";
  assert.equal((await validateSnapshot(reseal(emptySortKeys))).ok, true);
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
  const model = buildResultViewModel({ localization: inactive.items[0].localizationId }, validation.snapshot, matchesResearch);
  assert.equal(model.activeItems.some((item) => item.itemId === inactive.items[0].itemId), false);
  assert.equal(model.inactiveItems.some((item) => item.itemId === inactive.items[0].itemId), true);
  assert.equal(model.activeSummary.startsWith("0 active public catalogue items."), true);
  assert.equal(model.inactiveHeading, "Inactive catalogue items");
  assert.match(model.inactiveSummary ?? "", /inactive and excluded from the active checklist/);
});

test("searches public fields with AND terms and never rarity metadata", () => {
  const result = buildResultViewModel({ q: "Snorlax reverse-holo" }, fixture.catalogue, matchesResearch);
  assert.deepEqual(result.activeItems.map((item) => item.itemId), [fixture.catalogue.items[1].itemId]);

  const structured = structuredClone(fixture.catalogue);
  (structured.items[0] as Record<string, unknown>).markings = [{ kind: "stamp", role: "promo", text: "dragon" }];
  (structured.items[0] as Record<string, unknown>).distribution = { kind: "retail", name: "Card shop", region: "EU", date: "2026-01-01", text: "special release" };
  assert.deepEqual(buildResultViewModel({ q: "dragon" }, structured, matchesResearch).activeItems.map((item) => item.itemId), [structured.items[0].itemId]);
  assert.deepEqual(buildResultViewModel({ q: "card shop" }, structured, matchesResearch).activeItems.map((item) => item.itemId), [structured.items[0].itemId]);

  const withRarity = structuredClone(fixture.catalogue);
  (withRarity.items[0] as Record<string, unknown>).rarity = { display: "secret-only-label" };
  const rarityResult = buildResultViewModel({ q: "secret-only-label" }, withRarity, matchesResearch);
  assert.equal(rarityResult.activeItems.length, 0);
});

test("matches canonically equivalent Unicode search text", () => {
  const decomposed = structuredClone(fixture.catalogue);
  decomposed.items[0].cardName = "Poke\u0301mon";
  const result = buildResultViewModel({ q: "Pokémon" }, decomposed, matchesResearch);
  assert.deepEqual(result.activeItems.map((item) => item.itemId), [decomposed.items[0].itemId]);
});

test("keeps research separate from current-known progress", () => {
  const itemId = fixture.catalogue.items[0].itemId;
  const need = buildProgressViewModel(fixture.catalogue.items);
  assert.deepEqual(need, {
    currentKnownTotal: 1,
    ownedTotal: 0,
    securedTotal: 0,
    researchTotal: 2,
    ownedPercent: 0,
    securedPercent: 0,
  });
  const have = buildProgressViewModel(fixture.catalogue.items, new Map([[itemId, "have"]]));
  assert.equal(have.currentKnownTotal, 1);
  assert.equal(have.researchTotal, 2);
  assert.equal(have.ownedTotal, 1);
  assert.equal(have.securedTotal, 1);
  assert.equal(have.ownedPercent, 100);
});

test("groups browse results by opaque IDs despite duplicate set labels", () => {
  const groups = buildBrowseHierarchy({}, fixture.catalogue, matchesResearch);
  assert.deepEqual(groups.map((group) => group.localization.localizationId), [
    "fixture-loc-west-es",
    "fixture-loc-latam-es",
    "fixture-loc-west-en",
  ]);
  assert.deepEqual(groups.map((group) => group.sets[0].set.localSetId), ["fixture-set-1", "fixture-set-2", "fixture-set-3"]);
  assert.equal(groups[1].sets[0].editions[0].items[0].progressClass, "research");

  const empty = buildBrowseHierarchy({ q: "does-not-exist" }, fixture.catalogue, matchesResearch);
  assert.deepEqual(empty, []);
});

test("applies private status criteria only to current-known items", () => {
  const itemId = fixture.catalogue.items[0].itemId;
  const status = new Map([[itemId, "have" as const]]);
  const have = buildResultViewModel({ status: "have" }, fixture.catalogue, matchesResearch, status);
  assert.deepEqual(have.activeItems.map((item) => item.itemId), [itemId]);
  const need = buildResultViewModel({ status: "need" }, fixture.catalogue, matchesResearch, status);
  assert.deepEqual(need.activeItems, []);
});

test("excludes inactive items from private status criteria", () => {
  const inactive = structuredClone(fixture.catalogue);
  inactive.items[0].active = false;
  const need = buildResultViewModel({ status: "need" }, inactive, matchesResearch);
  assert.deepEqual(need.activeItems, []);
  assert.deepEqual(need.inactiveItems, []);
});

test("scopes selected-edition results and progress by opaque edition ID", () => {
  const editionId = fixture.catalogue.items[0].setEditionId;
  const model = buildResultViewModel({ edition: editionId }, fixture.catalogue, matchesResearch);
  assert.deepEqual(model.activeItems.map((item) => item.itemId), [fixture.catalogue.items[0].itemId]);
  const progress = buildProgressViewModel(fixture.catalogue.items.filter((item) => item.setEditionId === editionId));
  assert.equal(progress.currentKnownTotal, 1);
  assert.equal(progress.researchTotal, 0);
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
