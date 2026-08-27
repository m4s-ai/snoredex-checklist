import type {
  CatalogueSnapshot,
  SnapshotItem,
  SnapshotLocalSet,
  SnapshotLocalization,
  SnapshotSetEdition,
} from "./catalogue.js";
import type { ResearchCriterion } from "./filter.js";
import type { QueryCriteria } from "./query.js";

export type CollectionStatus = "need" | "ordered" | "have" | "skip";

export interface ResultViewModel {
  readonly activeItems: SnapshotItem[];
  readonly inactiveItems: SnapshotItem[];
  readonly activeSummary: string;
  readonly inactiveHeading?: string;
  readonly inactiveSummary?: string;
}

export interface ProgressViewModel {
  readonly currentKnownTotal: number;
  readonly ownedTotal: number;
  readonly securedTotal: number;
  readonly researchTotal: number;
  readonly ownedPercent: number;
  readonly securedPercent: number;
}

export interface BrowseEditionViewModel {
  readonly edition: SnapshotSetEdition;
  readonly items: SnapshotItem[];
}

export interface BrowseSetViewModel {
  readonly set: SnapshotLocalSet;
  readonly editions: BrowseEditionViewModel[];
}

export interface BrowseLocalizationViewModel {
  readonly localization: SnapshotLocalization;
  readonly sets: BrowseSetViewModel[];
}

function publicSearchValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(publicSearchValue).filter(Boolean).join(" ");
  if (typeof value === "object" && value !== null) return Object.values(value).map(publicSearchValue).filter(Boolean).join(" ");
  return "";
}

function publicSearchText(item: SnapshotItem): string {
  return [
    item.cardName,
    item.localCardName,
    item.localSetName,
    item.localSetCode,
    item.collectorNumber,
    item.finish,
    item.finishFamily,
    item.foilPattern,
    item.markings,
    item.distribution,
    item.cardSize,
  ].map(publicSearchValue).filter(Boolean).join(" ").toLowerCase();
}

function searchTerms(query: string | undefined): string[] {
  return query?.trim().split(/\s+/u).filter(Boolean).map((term) => term.toLowerCase()) ?? [];
}

function sortKey(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function compareStable(a: unknown, b: unknown): number {
  return sortKey(a).localeCompare(sortKey(b), "en", { numeric: true }) || 0;
}

function compareItems(a: SnapshotItem, b: SnapshotItem): number {
  return compareStable(a.releaseSortKey, b.releaseSortKey) ||
    compareStable(a.collectorNumberSortKey, b.collectorNumberSortKey) ||
    compareStable(a.finishGroupId, b.finishGroupId) ||
    compareStable(a.itemId, b.itemId);
}

function matchesCriteria(
  item: SnapshotItem,
  criteria: QueryCriteria,
  matchesResearch: (progressClass: string, criterion?: ResearchCriterion) => boolean,
  privateStatuses?: ReadonlyMap<string, CollectionStatus>,
): boolean {
  const terms = searchTerms(criteria.q);
  const status = privateStatuses?.get(item.itemId) ?? "need";
  return (!criteria.localization || item.localizationId === criteria.localization) &&
    (!criteria.edition || item.setEditionId === criteria.edition) &&
    (terms.length === 0 || terms.every((term) => publicSearchText(item).includes(term))) &&
    (!criteria.kind || item.itemKind === criteria.kind) &&
    (!criteria.research || matchesResearch(item.progressClass ?? "", criteria.research)) &&
    (!criteria.status || (item.active && item.progressClass === "current-known" && status === criteria.status));
}

export function filterCatalogueItems(
  criteria: QueryCriteria,
  catalogue: CatalogueSnapshot,
  matchesResearch: (progressClass: string, criterion?: ResearchCriterion) => boolean,
  privateStatuses?: ReadonlyMap<string, CollectionStatus>,
): SnapshotItem[] {
  return catalogue.items.filter((item) => matchesCriteria(item, criteria, matchesResearch, privateStatuses)).sort(compareItems);
}

export function buildProgressViewModel(
  items: readonly SnapshotItem[],
  privateStatuses?: ReadonlyMap<string, CollectionStatus>,
): ProgressViewModel {
  const currentKnown = items.filter((item) => item.active && item.progressClass === "current-known");
  const researchTotal = items.filter((item) => item.active && item.progressClass === "research").length;
  let ownedTotal = 0;
  let securedTotal = 0;
  for (const item of currentKnown) {
    const status = privateStatuses?.get(item.itemId) ?? "need";
    if (status === "have") {
      ownedTotal += 1;
      securedTotal += 1;
    } else if (status === "ordered") {
      securedTotal += 1;
    }
  }
  const denominator = currentKnown.length;
  return {
    currentKnownTotal: denominator,
    ownedTotal,
    securedTotal,
    researchTotal,
    ownedPercent: denominator === 0 ? 0 : Math.round((ownedTotal / denominator) * 100),
    securedPercent: denominator === 0 ? 0 : Math.round((securedTotal / denominator) * 100),
  };
}

export function buildResultViewModel(
  criteria: QueryCriteria,
  catalogue: CatalogueSnapshot,
  matchesResearch: (progressClass: string, criterion?: ResearchCriterion) => boolean,
  privateStatuses?: ReadonlyMap<string, CollectionStatus>,
): ResultViewModel {
  const filteredItems = filterCatalogueItems(criteria, catalogue, matchesResearch, privateStatuses);
  const activeItems: SnapshotItem[] = [];
  const inactiveItems: SnapshotItem[] = [];
  for (const item of filteredItems) (item.active ? activeItems : inactiveItems).push(item);
  const activeSummary = `${activeItems.length} public catalogue item${activeItems.length === 1 ? "" : "s"}.`;
  return inactiveItems.length === 0
    ? { activeItems, inactiveItems, activeSummary }
    : {
        activeItems,
        inactiveItems,
        activeSummary,
        inactiveHeading: "Inactive catalogue items",
        inactiveSummary: `${inactiveItems.length} catalogue item${inactiveItems.length === 1 ? " is" : "s are"} inactive and excluded from the active checklist.`,
      };
}

function compareSets(a: SnapshotLocalSet, b: SnapshotLocalSet): number {
  return compareStable(a.sortKey, b.sortKey) || compareStable(a.localSetId, b.localSetId);
}

function compareEditions(a: SnapshotSetEdition, b: SnapshotSetEdition): number {
  return compareStable(a.sortKey, b.sortKey) || compareStable(a.setEditionId, b.setEditionId);
}

/** Group results by producer IDs while retaining producer sort keys and stable tie-breakers. */
export function buildBrowseHierarchy(
  criteria: QueryCriteria,
  catalogue: CatalogueSnapshot,
  matchesResearch: (progressClass: string, criterion?: ResearchCriterion) => boolean,
  privateStatuses?: ReadonlyMap<string, CollectionStatus>,
): BrowseLocalizationViewModel[] {
  const matches = filterCatalogueItems(criteria, catalogue, matchesResearch, privateStatuses);
  const itemByEdition = new Map<string, SnapshotItem[]>();
  for (const item of matches) {
    const editionId = item.setEditionId;
    if (!editionId) continue;
    const rows = itemByEdition.get(editionId) ?? [];
    rows.push(item);
    itemByEdition.set(editionId, rows);
  }
  const sets = new Map(catalogue.localSets.map((set) => [set.localSetId, set] as const));
  const result: BrowseLocalizationViewModel[] = [];
  for (const localization of [...catalogue.localizations].sort((a, b) =>
    compareStable(a.displayOrder, b.displayOrder) || compareStable(a.localizationId, b.localizationId))) {
    if (criteria.localization && localization.localizationId !== criteria.localization) continue;
    const bySet = new Map<string, BrowseEditionViewModel[]>();
    for (const edition of catalogue.setEditions) {
      if (edition.localizationId !== localization.localizationId) continue;
      const set = sets.get(edition.localSetId);
      if (!set) continue;
      const editionItems = (itemByEdition.get(edition.setEditionId) ?? []).filter((item) => item.active);
      // A filtered/global search only displays groups containing a result. A plain
      // localization browse keeps empty editions visible as useful navigation.
      if ((criteria.edition || criteria.q || criteria.kind || criteria.research || criteria.status) && editionItems.length === 0) continue;
      const rows = bySet.get(set.localSetId) ?? [];
      rows.push({ edition, items: editionItems });
      bySet.set(set.localSetId, rows);
    }
    const localizationSets: BrowseSetViewModel[] = [];
    for (const [localSetId, rows] of bySet) {
      const set = sets.get(localSetId);
      if (!set) continue;
      localizationSets.push({ set, editions: rows.sort((a, b) => compareEditions(a.edition, b.edition)) });
    }
    localizationSets.sort((a, b) => compareSets(a.set, b.set));
    // Keep an explicitly selected localization visible even when filters produce no rows.
    if (criteria.localization || localizationSets.length > 0) result.push({ localization, sets: localizationSets });
  }
  return result;
}
