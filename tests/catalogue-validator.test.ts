import assert from "node:assert/strict";
import test from "node:test";

import fixture from "./fixtures/collector-catalogue.fixture.json" with { type: "json" };
import {
  semanticFingerprint,
  validateCatalogue,
  validateCatalogueFixture,
  type CatalogueErrorCode,
} from "../src/catalogue/validate.ts";

type JsonObject = Record<string, any>;

function cloneCatalogue(): JsonObject {
  return structuredClone(fixture.catalogue);
}

function seal(catalogue: JsonObject): JsonObject {
  catalogue.meta.catalogueFingerprint = semanticFingerprint(catalogue);
  return catalogue;
}

function expectFailure(
  mutate: (catalogue: JsonObject) => void,
  code: CatalogueErrorCode,
  { reseal = true }: { reseal?: boolean } = {},
): void {
  const catalogue = cloneCatalogue();
  mutate(catalogue);
  if (reseal) {
    seal(catalogue);
  }
  assert.deepEqual(validateCatalogue(catalogue), { ok: false, errors: [code] });
}

test("accepts the exact reviewed producer fixture", () => {
  const result = validateCatalogueFixture(structuredClone(fixture));
  assert.equal(result.ok, true);
  assert.equal(semanticFingerprint(fixture.catalogue), fixture.catalogue.meta.catalogueFingerprint);
});

test("fails closed on unsupported and malformed contracts", () => {
  expectFailure(
    (catalogue) => {
      catalogue.meta.schemaVersion = "1.0.1";
    },
    "CATALOGUE_UNSUPPORTED_CONTRACT",
    { reseal: false },
  );
  expectFailure(
    (catalogue) => {
      catalogue.items[0].unexpected = true;
    },
    "CATALOGUE_SCHEMA_INVALID",
    { reseal: false },
  );
  assert.deepEqual(validateCatalogue(null), {
    ok: false,
    errors: ["CATALOGUE_SCHEMA_INVALID"],
  });
});

test("checks semantic fingerprint independently", () => {
  expectFailure(
    (catalogue) => {
      catalogue.items[0].cardName = "Changed";
    },
    "CATALOGUE_FINGERPRINT_MISMATCH",
    { reseal: false },
  );
});

test("rejects duplicate IDs and dangling references", () => {
  expectFailure((catalogue) => {
    catalogue.works.push(structuredClone(catalogue.works[0]));
  }, "CATALOGUE_ID_INVALID");
  expectFailure((catalogue) => {
    catalogue.items[0].workId = "missing-work";
  }, "CATALOGUE_REFERENCE_INVALID");
  expectFailure((catalogue) => {
    catalogue.items[1].itemKind = "verified-printing";
    catalogue.items[1].progressClass = "current-known";
    catalogue.items[1].physicalPrintingId = catalogue.items[0].physicalPrintingId;
  }, "CATALOGUE_ID_INVALID");
});

test("keeps WEST and LATAM distinct while accepting new localizations", () => {
  expectFailure((catalogue) => {
    catalogue.localizations[1].languageTag = "es-ES";
  }, "CATALOGUE_LOCALIZATION_INVALID");

  const catalogue = cloneCatalogue();
  catalogue.localizations.push({
    localizationId: "fixture-loc-new",
    locality: "NEW",
    languageId: "LANG:New",
    language: "New",
    languageTag: "qaa",
    script: "Latn",
    displayName: "New",
    displayOrder: 70,
  });
  assert.equal(validateCatalogue(seal(catalogue)).ok, true);
});

test("enforces item classes without using rarity as existence evidence", () => {
  expectFailure((catalogue) => {
    catalogue.items[1].physicalPrintingId = "invented-printing";
  }, "CATALOGUE_ITEM_CLASS_INVALID");
  expectFailure((catalogue) => {
    catalogue.items[2].finish = "holo";
  }, "CATALOGUE_ITEM_CLASS_INVALID");
  expectFailure((catalogue) => {
    catalogue.items[0].progressClass = "research";
  }, "CATALOGUE_ITEM_CLASS_INVALID");

  for (const evidenceStatus of [
    "source-backed",
    "marketplace-claimed",
    "conflicting",
    "unknown",
  ]) {
    const catalogue = cloneCatalogue();
    catalogue.items[0].rarity.evidenceStatus = evidenceStatus;
    assert.equal(validateCatalogue(seal(catalogue)).ok, true);
  }
});

test("rejects one card release projected through different set editions", () => {
  expectFailure((catalogue) => {
    catalogue.items[1].cardReleaseId = catalogue.items[0].cardReleaseId;
  }, "CATALOGUE_RELEASE_RELATION_INVALID");
});

test("allows missing images and checks present asset references and scope", () => {
  assert.equal(validateCatalogue(cloneCatalogue()).ok, true);

  const catalogue = cloneCatalogue();
  catalogue.assets.push({
    assetId: "fixture-asset",
    path: "images/fixture.webp",
    url: "https://m4s-ai.github.io/snoredex-data/images/fixture.webp",
    sha256: `sha256:${"0".repeat(64)}`,
    mimeType: "image/webp",
    imageScope: "exact-printing",
    altTextBasis: "Fixture",
    attribution: {
      rightsStatus: "third-party-rights-excluded-from-project-grants",
      licenceRef: "LICENSE.md",
      noticeRef: "THIRD_PARTY_NOTICES.md",
    },
  });
  catalogue.items[0].imageAssetId = "fixture-asset";
  catalogue.items[0].imageScope = "exact-printing";
  assert.equal(validateCatalogue(seal(catalogue)).ok, true);

  catalogue.items[0].imageScope = "legacy-product";
  assert.deepEqual(validateCatalogue(seal(catalogue)), {
    ok: false,
    errors: ["CATALOGUE_ASSET_INVALID"],
  });

  catalogue.items[0].imageScope = "exact-printing";
  catalogue.assets[0].path = "https://example.invalid/fixture.webp";
  catalogue.assets[0].url = "https://example.invalid/fixture.webp";
  assert.deepEqual(validateCatalogue(seal(catalogue)), {
    ok: false,
    errors: ["CATALOGUE_ASSET_INVALID"],
  });
});

test("accepts only bounded producer-owned correction-link fields", () => {
  expectFailure((catalogue) => {
    catalogue.items[0].correctionLink += "&note=private";
  }, "CATALOGUE_CORRECTION_LINK_INVALID");
  expectFailure((catalogue) => {
    const url = new URL(catalogue.items[0].correctionLink);
    url.searchParams.set("row-id", catalogue.items[1].itemId);
    catalogue.items[0].correctionLink = url.href;
  }, "CATALOGUE_CORRECTION_LINK_INVALID");
});

test("keeps U0414 and every unsafe reconciliation case non-automatic", () => {
  for (const field of [
    "expectedAutomaticStateAction",
    "expectedResolution",
    "expectedStateDisposition",
    "expectedAdoption",
  ]) {
    const inconsistentFixture = structuredClone(fixture) as JsonObject;
    inconsistentFixture.reconciliationCases[0][field] = "unsafe-substitute";
    assert.deepEqual(validateCatalogueFixture(inconsistentFixture), {
      ok: false,
      errors: ["CATALOGUE_FIXTURE_INVALID"],
    });
  }

  const unsafeFixture = structuredClone(fixture) as JsonObject;
  const u0414 = unsafeFixture.reconciliationCases.find(
    (entry: JsonObject) => entry.sourceGraphRef === "legacy-issue-rekey:U0414",
  );
  u0414.expectedAutomaticStateAction = "preserve";
  assert.deepEqual(validateCatalogueFixture(unsafeFixture), {
    ok: false,
    errors: ["CATALOGUE_FIXTURE_INVALID"],
  });

  const danglingFixture = structuredClone(fixture) as JsonObject;
  danglingFixture.reconciliationCases[0].toItemIds = [
    "item-ffffffff-ffff-5fff-8fff-ffffffffffff",
  ];
  assert.deepEqual(validateCatalogueFixture(danglingFixture), {
    ok: false,
    errors: ["CATALOGUE_FIXTURE_INVALID"],
  });

  const badCardinalityFixture = structuredClone(fixture) as JsonObject;
  const retired = badCardinalityFixture.reconciliationCases.find(
    (entry: JsonObject) => entry.changeKind === "retired-1:0",
  );
  retired.toItemIds = [fixture.catalogue.items[0].itemId];
  assert.deepEqual(validateCatalogueFixture(badCardinalityFixture), {
    ok: false,
    errors: ["CATALOGUE_FIXTURE_INVALID"],
  });
});

test("never reflects untrusted values in diagnostics", () => {
  const secret = "PRIVATE-NOTE-DO-NOT-LOG";
  const catalogue = cloneCatalogue();
  catalogue.items[0].workId = secret;
  const result = validateCatalogue(seal(catalogue));
  assert.equal(JSON.stringify(result).includes(secret), false);
});
