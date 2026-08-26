export interface SnapshotMeta {
  readonly schema: string;
  readonly schemaVersion: string;
  readonly catalogueFingerprint: string;
  readonly sourceRepository?: string;
  readonly dataAsOf?: string;
  readonly assetBaseUrl?: string;
  readonly [key: string]: unknown;
}

export interface SnapshotLocalization {
  readonly localizationId: string;
  readonly locality?: string;
  readonly languageTag?: string;
  readonly displayName?: string;
  readonly displayOrder?: number;
  readonly [key: string]: unknown;
}

export interface SnapshotItem {
  readonly itemId: string;
  readonly localizationId: string;
  readonly setEditionId?: string;
  readonly itemKind?: string;
  readonly progressClass?: string;
  readonly cardName?: string;
  readonly localCardName?: string | null;
  readonly localSetName?: string;
  readonly localSetCode?: string;
  readonly collectorNumber?: string;
  readonly imageAssetId?: string | null;
  readonly imageScope?: string;
  readonly [key: string]: unknown;
}

export interface CatalogueSnapshot {
  readonly meta: SnapshotMeta;
  readonly localizations: readonly SnapshotLocalization[];
  readonly localSets: readonly Record<string, unknown>[];
  readonly setEditions: readonly Record<string, unknown>[];
  readonly works: readonly Record<string, unknown>[];
  readonly items: readonly SnapshotItem[];
  readonly assets: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

export type SnapshotValidation =
  | { readonly ok: true; readonly snapshot: CatalogueSnapshot }
  | { readonly ok: false; readonly reason: "unsupported" | "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function allRecords(rows: readonly unknown[]): rows is readonly Record<string, unknown>[] {
  return rows.every(isRecord);
}

function hasUniqueIds(rows: readonly unknown[], key: string): boolean {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || !isString(row[key]) || ids.has(row[key])) return false;
    ids.add(row[key]);
  }
  return true;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

async function hasMatchingFingerprint(value: unknown, expected: string): Promise<boolean> {
  try {
    const payload = structuredClone(value);
    if (isRecord(payload) && isRecord(payload.meta)) delete payload.meta.catalogueFingerprint;
    const bytes = JSON.stringify(canonicalize(payload));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
    const actual = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    return actual === expected;
  } catch {
    return false;
  }
}

/** Small browser-side guard for the already validated, build-time snapshot. */
export async function validateSnapshot(value: unknown): Promise<SnapshotValidation> {
  if (!isRecord(value) || !isRecord(value.meta)) {
    return { ok: false, reason: "invalid" };
  }
  if (value.meta.schema !== "snoredex-collector-catalogue" || value.meta.schemaVersion !== "1.0.0") {
    return { ok: false, reason: "unsupported" };
  }
  const fingerprint = value.meta.catalogueFingerprint;
  if (typeof fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(fingerprint)) {
    return { ok: false, reason: "invalid" };
  }
  if (!(await hasMatchingFingerprint(value, fingerprint))) {
    return { ok: false, reason: "invalid" };
  }
  const arrayKeys = ["localizations", "localSets", "setEditions", "works", "items", "assets"] as const;
  if (arrayKeys.some((key) => !Array.isArray(value[key]))) {
    return { ok: false, reason: "invalid" };
  }
  const localizations = value.localizations as readonly unknown[];
  const localSets = value.localSets as readonly unknown[];
  const setEditions = value.setEditions as readonly unknown[];
  const works = value.works as readonly unknown[];
  const items = value.items as readonly unknown[];
  const assets = value.assets as readonly unknown[];
  if (!allRecords(localizations) || !allRecords(localSets) || !allRecords(setEditions) ||
      !allRecords(works) || !allRecords(items) || !allRecords(assets) ||
      !hasUniqueIds(localizations, "localizationId") || !hasUniqueIds(localSets, "localSetId") ||
      !hasUniqueIds(setEditions, "setEditionId") || !hasUniqueIds(works, "workId") ||
      !hasUniqueIds(items, "itemId") || !hasUniqueIds(assets, "assetId")) {
    return { ok: false, reason: "invalid" };
  }

  if (localizations.some((row) => !isString(row.locality) || !isString(row.languageTag)) ||
      localSets.some((row) => !isString(row.locality)) ||
      setEditions.some((row) => !isString(row.localSetId) || !isString(row.localizationId)) ||
      assets.some((row) => !isString(row.imageScope))) {
    return { ok: false, reason: "invalid" };
  }

  const localizationById = new Map(localizations.map((row) => [row.localizationId as string, row] as const));
  const localSetById = new Map(localSets.map((row) => [row.localSetId as string, row] as const));
  const editionById = new Map(setEditions.map((row) => [row.setEditionId as string, row] as const));
  const workIds = new Set(works.map((row) => row.workId as string));
  const assetById = new Map(assets.map((row) => [row.assetId as string, row] as const));
  const localizationKeys = new Set<string>();
  for (const localization of localizations) {
    const key = `${localization.locality}\u0000${localization.languageTag}`;
    if (localizationKeys.has(key)) return { ok: false, reason: "invalid" };
    localizationKeys.add(key);
  }
  const releaseMappings = new Map<string, string>();
  const itemKinds = new Set(["verified-printing", "finish-candidate", "research-placeholder"]);
  const progressClasses = new Set(["current-known", "research"]);
  const mappedWorkStates = new Set(["mapped", "mapped-by-explicit-equivalence"]);
  const unmappedWorkStates = new Set(["unmapped", "needs-explicit-equivalence"]);
  for (const edition of setEditions) {
    const localization = localizationById.get(edition.localizationId as string);
    const localSet = localSetById.get(edition.localSetId as string);
    if (!localization || !localSet || localSet.locality !== localization.locality) {
      return { ok: false, reason: "invalid" };
    }
  }
  const physicalPrintingIds = new Set<string>();

  for (const item of items) {
    if (!isString(item.itemId) || !isString(item.localizationId) || !isString(item.setEditionId) ||
        !isString(item.localSetId) || !isString(item.cardReleaseId) || !isString(item.itemKind) ||
        !isString(item.progressClass) || !isString(item.workMappingState) ||
        !isString(item.cardName) ||
        !isNullableString(item.workId) || !isNullableString(item.physicalPrintingId) ||
        !isNullableString(item.imageAssetId) || !isString(item.imageScope) ||
        !itemKinds.has(item.itemKind) || !progressClasses.has(item.progressClass)) {
      return { ok: false, reason: "invalid" };
    }
    const localization = localizationById.get(item.localizationId);
    const localSet = localSetById.get(item.localSetId);
    const edition = editionById.get(item.setEditionId);
    if (!localization || !localSet || !edition ||
        edition.localSetId !== item.localSetId || edition.localizationId !== item.localizationId ||
        localSet.locality !== localization.locality) {
      return { ok: false, reason: "invalid" };
    }
    const workIsMapped = mappedWorkStates.has(item.workMappingState);
    if ((!workIsMapped && !unmappedWorkStates.has(item.workMappingState)) ||
        workIsMapped !== (item.workId !== null) || (item.workId !== null && !workIds.has(item.workId))) {
      return { ok: false, reason: "invalid" };
    }
    if (item.itemKind === "verified-printing") {
      if (item.physicalPrintingId === null || item.progressClass !== "current-known") return { ok: false, reason: "invalid" };
      if (physicalPrintingIds.has(item.physicalPrintingId)) return { ok: false, reason: "invalid" };
      physicalPrintingIds.add(item.physicalPrintingId);
    } else if (item.physicalPrintingId !== null || item.progressClass !== "research" ||
        (item.itemKind === "research-placeholder" && item.finish !== null)) {
      return { ok: false, reason: "invalid" };
    }
    const previousMapping = releaseMappings.get(item.cardReleaseId);
    const currentMapping = `${item.setEditionId}\u0000${item.workId ?? ""}\u0000${item.workMappingState}`;
    if (previousMapping !== undefined && previousMapping !== currentMapping) return { ok: false, reason: "invalid" };
    releaseMappings.set(item.cardReleaseId, currentMapping);
    if (item.imageAssetId !== null) {
      const asset = assetById.get(item.imageAssetId);
      if (!asset || asset.imageScope !== item.imageScope) return { ok: false, reason: "invalid" };
    }
  }
  return { ok: true, snapshot: value as unknown as CatalogueSnapshot };
}
