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

function hasUniqueIds(rows: readonly unknown[], key: string): boolean {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || !isString(row[key]) || ids.has(row[key])) return false;
    ids.add(row[key]);
  }
  return true;
}

/** Small browser-side guard for the already validated, build-time snapshot. */
export function validateSnapshot(value: unknown): SnapshotValidation {
  if (!isRecord(value) || !isRecord(value.meta)) {
    return { ok: false, reason: "invalid" };
  }
  if (value.meta.schema !== "snoredex-collector-catalogue" || value.meta.schemaVersion !== "1.0.0") {
    return { ok: false, reason: "unsupported" };
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(value.meta.catalogueFingerprint ?? ""))) {
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
  if (!hasUniqueIds(localizations, "localizationId") || !hasUniqueIds(localSets, "localSetId") ||
      !hasUniqueIds(setEditions, "setEditionId") || !hasUniqueIds(works, "workId") ||
      !hasUniqueIds(items, "itemId") || !hasUniqueIds(assets, "assetId")) {
    return { ok: false, reason: "invalid" };
  }
  const localizationIds = new Set(localizations.map((row) => isRecord(row) ? row.localizationId : undefined));
  if (items.some((item) => !isRecord(item) || !isString(item.itemId) || !localizationIds.has(item.localizationId))) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, snapshot: value as unknown as CatalogueSnapshot };
}
