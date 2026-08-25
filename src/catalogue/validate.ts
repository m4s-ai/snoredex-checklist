import { createHash } from "node:crypto";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

import catalogueSchema from "../../schemas/collector-catalogue.schema.json" with { type: "json" };

const CATALOGUE_SCHEMA = "snoredex-collector-catalogue";
const CATALOGUE_VERSION = "1.0.0";
const FIXTURE_SCHEMA = "snoredex-collector-catalogue-fixture";
const FIXTURE_VERSION = "1.0.0";
const CORRECTION_ORIGIN = "https://github.com";
const CORRECTION_PATH = "/m4s-ai/snoredex-data/issues/new";
const CORRECTION_FIELDS = new Set([
  "template",
  "title",
  "row-id",
  "card-name",
  "set-code",
  "card-number",
  "current-state",
]);
const MAPPED_WORK_STATES = new Set(["mapped", "mapped-by-explicit-equivalence"]);
const UNMAPPED_WORK_STATES = new Set(["unmapped", "needs-explicit-equivalence"]);
const RECONCILIATION_EXPECTATIONS = {
  retained: {
    action: "preserve",
    resolution: "identity-retained",
    disposition: "active",
    adoption: "allowed-after-atomic-conservation",
  },
  "rekey-1:1": {
    action: "preserve",
    resolution: "one-to-one-preserve",
    disposition: "migrated",
    adoption: "allowed-after-atomic-conservation",
  },
  "retired-1:0": {
    action: "none",
    resolution: "retire-to-orphan",
    disposition: "orphan",
    adoption: "allowed-after-atomic-conservation",
  },
  "split-1:N": {
    action: "none",
    resolution: "requires-user-resolution",
    disposition: "orphan-and-conflict",
    adoption: "allowed-after-atomic-conservation",
  },
  "merge-N:1": {
    action: "none",
    resolution: "requires-user-resolution",
    disposition: "orphans-and-conflict",
    adoption: "allowed-after-atomic-conservation",
  },
  unresolved: {
    action: "none",
    resolution: "requires-user-resolution",
    disposition: "orphan-and-conflict",
    adoption: "allowed-after-atomic-conservation",
  },
  "missing-chain": {
    action: "none",
    resolution: "fail-closed",
    disposition: "last-known-good",
    adoption: "blocked-with-stored-fingerprint-unchanged",
  },
} as const;

export const CATALOGUE_ERROR_CODES = [
  "CATALOGUE_UNSUPPORTED_CONTRACT",
  "CATALOGUE_SCHEMA_INVALID",
  "CATALOGUE_FINGERPRINT_MISMATCH",
  "CATALOGUE_ID_INVALID",
  "CATALOGUE_REFERENCE_INVALID",
  "CATALOGUE_LOCALIZATION_INVALID",
  "CATALOGUE_RELEASE_RELATION_INVALID",
  "CATALOGUE_ITEM_CLASS_INVALID",
  "CATALOGUE_ASSET_INVALID",
  "CATALOGUE_CORRECTION_LINK_INVALID",
  "CATALOGUE_FIXTURE_INVALID",
] as const;

export type CatalogueErrorCode = (typeof CATALOGUE_ERROR_CODES)[number];

type ValidationResult =
  | { readonly ok: true; readonly catalogue: Catalogue }
  | { readonly ok: false; readonly errors: readonly CatalogueErrorCode[] };

interface Catalogue {
  meta: {
    schema: string;
    schemaVersion: string;
    catalogueFingerprint: string;
    assetBaseUrl: string;
  };
  localizations: Localization[];
  localSets: LocalSet[];
  setEditions: SetEdition[];
  works: Work[];
  items: Item[];
  assets: Asset[];
}

interface Localization {
  localizationId: string;
  locality: string;
  languageTag: string;
}

interface LocalSet {
  localSetId: string;
  locality: string;
}

interface SetEdition {
  setEditionId: string;
  localSetId: string;
  localizationId: string;
}

interface Work {
  workId: string;
}

interface Item {
  itemId: string;
  legacyChecklistIds: string[];
  itemKind: "verified-printing" | "finish-candidate" | "research-placeholder";
  progressClass: "current-known" | "research";
  workId: string | null;
  workMappingState: string;
  setEditionId: string;
  localSetId: string;
  cardReleaseId: string;
  physicalPrintingId: string | null;
  localizationId: string;
  finish: string | null;
  imageAssetId: string | null;
  imageScope: Asset["imageScope"];
  correctionLink: string;
}

interface Asset {
  assetId: string;
  path: string;
  url: string;
  imageScope: "exact-printing" | "card-release" | "legacy-product" | "unknown";
}

interface ReconciliationCase {
  caseId: string;
  sourceGraphRef?: string;
  fromItemId: string;
  fromItemIds: string[];
  toItemIds: string[];
  changeKind: string;
  expectedAutomaticStateAction: string;
  expectedResolution: string;
  expectedStateDisposition: string;
  expectedAdoption: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormatsModule.default(ajv);
const validateSchema = ajv.compile(catalogueSchema);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function semanticFingerprint(catalogue: unknown): string {
  const payload = structuredClone(catalogue);
  if (isRecord(payload) && isRecord(payload.meta)) {
    delete payload.meta.catalogueFingerprint;
  }
  const bytes = JSON.stringify(canonicalize(payload));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function ordered(errors: Set<CatalogueErrorCode>): CatalogueErrorCode[] {
  return CATALOGUE_ERROR_CODES.filter((code) => errors.has(code));
}

function indexBy<T>(
  rows: readonly T[],
  key: (row: T) => string,
  errors: Set<CatalogueErrorCode>,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (result.has(id)) {
      errors.add("CATALOGUE_ID_INVALID");
    }
    result.set(id, row);
  }
  return result;
}

function correctionLinkIsValid(value: string, itemId: string): boolean {
  try {
    const url = new URL(value);
    const entries = [...url.searchParams.entries()];
    const keys = entries.map(([key]) => key);
    return (
      url.origin === CORRECTION_ORIGIN &&
      url.pathname === CORRECTION_PATH &&
      url.hash === "" &&
      entries.length === CORRECTION_FIELDS.size &&
      new Set(keys).size === keys.length &&
      keys.every((key) => CORRECTION_FIELDS.has(key)) &&
      url.searchParams.get("template") === "printing-correction.yml" &&
      url.searchParams.get("row-id") === itemId
    );
  } catch {
    return false;
  }
}

function validateSemantics(catalogue: Catalogue): CatalogueErrorCode[] {
  const errors = new Set<CatalogueErrorCode>();
  if (catalogue.meta.catalogueFingerprint !== semanticFingerprint(catalogue)) {
    errors.add("CATALOGUE_FINGERPRINT_MISMATCH");
  }

  const localizations = indexBy(catalogue.localizations, (row) => row.localizationId, errors);
  const localSets = indexBy(catalogue.localSets, (row) => row.localSetId, errors);
  const editions = indexBy(catalogue.setEditions, (row) => row.setEditionId, errors);
  const works = indexBy(catalogue.works, (row) => row.workId, errors);
  const items = indexBy(catalogue.items, (row) => row.itemId, errors);
  const assets = indexBy(catalogue.assets, (row) => row.assetId, errors);

  const localizationKeys = new Set<string>();
  for (const localization of localizations.values()) {
    const key = `${localization.locality}\u0000${localization.languageTag}`;
    if (localizationKeys.has(key)) {
      errors.add("CATALOGUE_LOCALIZATION_INVALID");
    }
    localizationKeys.add(key);
  }
  const westSpanish = [...localizations.values()].find(
    (row) => row.locality === "WEST" && row.languageTag === "es-ES",
  );
  const latamSpanish = [...localizations.values()].find(
    (row) => row.locality === "LATAM" && row.languageTag === "es-419",
  );
  if (
    !westSpanish ||
    !latamSpanish ||
    westSpanish.localizationId === latamSpanish.localizationId ||
    ![...localizations.values()].some((row) => row.languageTag === "pt")
  ) {
    errors.add("CATALOGUE_LOCALIZATION_INVALID");
  }

  for (const edition of editions.values()) {
    const localSet = localSets.get(edition.localSetId);
    const localization = localizations.get(edition.localizationId);
    if (!localSet || !localization) {
      errors.add("CATALOGUE_REFERENCE_INVALID");
    } else if (localSet.locality !== localization.locality) {
      errors.add("CATALOGUE_LOCALIZATION_INVALID");
    }
  }

  const physicalPrintingIds = new Set<string>();
  const legacyChecklistIds = new Set<string>();
  const releaseMappings = new Map<
    string,
    { setEditionId: string; workId: string | null; workMappingState: string }
  >();
  let assetBaseUrl: URL | undefined;
  try {
    const parsedAssetBaseUrl = new URL(catalogue.meta.assetBaseUrl);
    if (
      parsedAssetBaseUrl.protocol !== "https:" ||
      parsedAssetBaseUrl.username !== "" ||
      parsedAssetBaseUrl.password !== "" ||
      !parsedAssetBaseUrl.pathname.endsWith("/") ||
      parsedAssetBaseUrl.search !== "" ||
      parsedAssetBaseUrl.hash !== ""
    ) {
      errors.add("CATALOGUE_ASSET_INVALID");
    } else {
      assetBaseUrl = parsedAssetBaseUrl;
    }
  } catch {
    errors.add("CATALOGUE_ASSET_INVALID");
  }

  for (const item of items.values()) {
    const edition = editions.get(item.setEditionId);
    if (
      !edition ||
      edition.localSetId !== item.localSetId ||
      edition.localizationId !== item.localizationId ||
      !localSets.has(item.localSetId) ||
      !localizations.has(item.localizationId) ||
      (item.workId !== null && !works.has(item.workId)) ||
      (item.imageAssetId !== null && !assets.has(item.imageAssetId))
    ) {
      errors.add("CATALOGUE_REFERENCE_INVALID");
    }

    const workStateIsMapped = MAPPED_WORK_STATES.has(item.workMappingState);
    if (
      (!workStateIsMapped && !UNMAPPED_WORK_STATES.has(item.workMappingState)) ||
      workStateIsMapped !== (item.workId !== null)
    ) {
      errors.add("CATALOGUE_RELEASE_RELATION_INVALID");
    }

    const releaseMapping = releaseMappings.get(item.cardReleaseId);
    if (
      releaseMapping !== undefined &&
      (releaseMapping.setEditionId !== item.setEditionId ||
        releaseMapping.workId !== item.workId ||
        releaseMapping.workMappingState !== item.workMappingState)
    ) {
      errors.add("CATALOGUE_RELEASE_RELATION_INVALID");
    }
    releaseMappings.set(item.cardReleaseId, {
      setEditionId: item.setEditionId,
      workId: item.workId,
      workMappingState: item.workMappingState,
    });

    if (item.itemKind === "verified-printing") {
      if (item.physicalPrintingId === null || item.progressClass !== "current-known") {
        errors.add("CATALOGUE_ITEM_CLASS_INVALID");
      } else if (physicalPrintingIds.has(item.physicalPrintingId)) {
        errors.add("CATALOGUE_ID_INVALID");
      } else {
        physicalPrintingIds.add(item.physicalPrintingId);
      }
    } else if (
      item.physicalPrintingId !== null ||
      item.progressClass !== "research" ||
      (item.itemKind === "research-placeholder" && item.finish !== null)
    ) {
      errors.add("CATALOGUE_ITEM_CLASS_INVALID");
    }

    for (const legacyId of item.legacyChecklistIds) {
      if (legacyChecklistIds.has(legacyId)) {
        errors.add("CATALOGUE_ID_INVALID");
      }
      legacyChecklistIds.add(legacyId);
    }

    if (!correctionLinkIsValid(item.correctionLink, item.itemId)) {
      errors.add("CATALOGUE_CORRECTION_LINK_INVALID");
    }

    if (item.imageAssetId !== null) {
      const asset = assets.get(item.imageAssetId);
      if (asset && asset.imageScope !== item.imageScope) {
        errors.add("CATALOGUE_ASSET_INVALID");
      }
    }
  }

  for (const asset of assets.values()) {
    try {
      if (!assetBaseUrl) {
        continue;
      }
      const resolved = new URL(asset.path, assetBaseUrl);
      if (!resolved.href.startsWith(assetBaseUrl.href) || resolved.href !== asset.url) {
        errors.add("CATALOGUE_ASSET_INVALID");
      }
    } catch {
      errors.add("CATALOGUE_ASSET_INVALID");
    }
  }

  return ordered(errors);
}

export function validateCatalogue(value: unknown): ValidationResult {
  if (!isRecord(value) || !isRecord(value.meta)) {
    return { ok: false, errors: ["CATALOGUE_SCHEMA_INVALID"] };
  }
  const schema = value.meta.schema;
  const version = value.meta.schemaVersion;
  if (
    (typeof schema === "string" && schema !== CATALOGUE_SCHEMA) ||
    (typeof version === "string" && version !== CATALOGUE_VERSION)
  ) {
    return { ok: false, errors: ["CATALOGUE_UNSUPPORTED_CONTRACT"] };
  }
  if (!validateSchema(value)) {
    return { ok: false, errors: ["CATALOGUE_SCHEMA_INVALID"] };
  }
  const catalogue = value as unknown as Catalogue;
  const errors = validateSemantics(catalogue);
  return errors.length === 0 ? { ok: true, catalogue } : { ok: false, errors };
}

export function validateCatalogueFixture(value: unknown): ValidationResult {
  if (
    !isRecord(value) ||
    !isRecord(value.meta) ||
    value.meta.schema !== FIXTURE_SCHEMA ||
    value.meta.schemaVersion !== FIXTURE_VERSION ||
    !Array.isArray(value.reconciliationCases)
  ) {
    return { ok: false, errors: ["CATALOGUE_FIXTURE_INVALID"] };
  }
  const catalogueResult = validateCatalogue(value.catalogue);
  if (!catalogueResult.ok) {
    return catalogueResult;
  }

  const itemIds = new Set(catalogueResult.catalogue.items.map((item) => item.itemId));
  const kinds = new Set<string>();
  const caseIds = new Set<string>();
  let u0414Count = 0;
  for (const rawCase of value.reconciliationCases) {
    if (!isRecord(rawCase)) {
      return { ok: false, errors: ["CATALOGUE_FIXTURE_INVALID"] };
    }
    const entry = rawCase as unknown as ReconciliationCase;
    if (
      typeof entry.caseId !== "string" ||
      caseIds.has(entry.caseId) ||
      typeof entry.fromItemId !== "string" ||
      !Array.isArray(entry.fromItemIds) ||
      !entry.fromItemIds.every((itemId) => typeof itemId === "string") ||
      !entry.fromItemIds.includes(entry.fromItemId) ||
      !Array.isArray(entry.toItemIds) ||
      !entry.toItemIds.every((itemId) => typeof itemId === "string" && itemIds.has(itemId)) ||
      typeof entry.changeKind !== "string" ||
      typeof entry.expectedAutomaticStateAction !== "string" ||
      typeof entry.expectedResolution !== "string" ||
      typeof entry.expectedStateDisposition !== "string" ||
      typeof entry.expectedAdoption !== "string"
    ) {
      return { ok: false, errors: ["CATALOGUE_FIXTURE_INVALID"] };
    }
    caseIds.add(entry.caseId);
    kinds.add(entry.changeKind);

    if (
      new Set(entry.fromItemIds).size !== entry.fromItemIds.length ||
      new Set(entry.toItemIds).size !== entry.toItemIds.length
    ) {
      return { ok: false, errors: ["CATALOGUE_FIXTURE_INVALID"] };
    }

    const cardinalityIsValid =
      (entry.changeKind === "retained" &&
        entry.fromItemIds.length === 1 &&
        entry.toItemIds.length === 1 &&
        entry.fromItemId === entry.toItemIds[0]) ||
      (entry.changeKind === "rekey-1:1" &&
        entry.fromItemIds.length === 1 &&
        entry.toItemIds.length === 1) ||
      (entry.changeKind === "retired-1:0" &&
        entry.fromItemIds.length === 1 &&
        entry.toItemIds.length === 0) ||
      (entry.changeKind === "split-1:N" &&
        entry.fromItemIds.length === 1 &&
        entry.toItemIds.length > 1) ||
      (entry.changeKind === "merge-N:1" &&
        entry.fromItemIds.length > 1 &&
        entry.toItemIds.length === 1) ||
      (["unresolved", "missing-chain"].includes(entry.changeKind) &&
        entry.fromItemIds.length > 0 &&
        entry.toItemIds.length === 0);
    if (!cardinalityIsValid) {
      return { ok: false, errors: ["CATALOGUE_FIXTURE_INVALID"] };
    }

    const expected =
      RECONCILIATION_EXPECTATIONS[
        entry.changeKind as keyof typeof RECONCILIATION_EXPECTATIONS
      ];
    if (
      !expected ||
      entry.expectedAutomaticStateAction !== expected.action ||
      entry.expectedResolution !== expected.resolution ||
      entry.expectedStateDisposition !== expected.disposition ||
      entry.expectedAdoption !== expected.adoption
    ) {
      return { ok: false, errors: ["CATALOGUE_FIXTURE_INVALID"] };
    }

    if (entry.sourceGraphRef === "legacy-issue-rekey:U0414") {
      u0414Count += 1;
      if (
        entry.changeKind !== "split-1:N" ||
        entry.toItemIds.length !== 2 ||
        entry.expectedResolution !== "requires-user-resolution"
      ) {
        return { ok: false, errors: ["CATALOGUE_FIXTURE_INVALID"] };
      }
    }
  }

  const requiredKinds = Object.keys(RECONCILIATION_EXPECTATIONS);
  if (u0414Count !== 1 || requiredKinds.some((kind) => !kinds.has(kind))) {
    return { ok: false, errors: ["CATALOGUE_FIXTURE_INVALID"] };
  }
  return catalogueResult;
}
