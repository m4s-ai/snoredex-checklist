import type {
  CatalogueSnapshot,
  SnapshotItem,
  SnapshotLocalSet,
  SnapshotLocalization,
  SnapshotSetEdition,
} from './catalogue.js';
import type { ResearchCriterion } from './filter.js';
import type { QueryCriteria } from './query.js';

export type CollectionStatus = 'need' | 'ordered' | 'have' | 'skip';

export interface ResultViewModel {
  readonly activeItems: readonly SnapshotItem[];
  readonly inactiveItems: readonly SnapshotItem[];
  readonly activeSummary: string;
  readonly inactiveHeading?: string;
  readonly inactiveSummary?: string;
}

export interface ProgressViewModel {
  readonly currentKnownTotal: number;
  readonly haveTotal: number;
  readonly orderedTotal: number;
  readonly needTotal: number;
  readonly skipTotal: number;
  readonly ownedTotal: number;
  readonly securedTotal: number;
  readonly researchTotal: number;
  readonly ownedPercent: number;
  readonly securedPercent: number;
}

export interface BrowseEditionViewModel {
  readonly edition: SnapshotSetEdition;
  readonly items: readonly SnapshotItem[];
}

export interface BrowseSetViewModel {
  readonly set: SnapshotLocalSet;
  readonly editions: readonly BrowseEditionViewModel[];
}

export interface BrowseLocalizationViewModel {
  readonly localization: SnapshotLocalization;
  readonly sets: readonly BrowseSetViewModel[];
}

export interface PreparedCatalogueResults {
  readonly items: readonly SnapshotItem[];
  readonly searchText: ReadonlyMap<string, string>;
  readonly itemById: ReadonlyMap<string, SnapshotItem>;
  readonly itemsByEdition: ReadonlyMap<string, readonly SnapshotItem[]>;
  readonly editionById: ReadonlyMap<string, SnapshotSetEdition>;
  readonly editionsByLocalization: ReadonlyMap<string, readonly SnapshotSetEdition[]>;
  readonly setById: ReadonlyMap<string, SnapshotLocalSet>;
  readonly localizationById: ReadonlyMap<string, SnapshotLocalization>;
  readonly localizations: readonly SnapshotLocalization[];
}

function publicSearchValue(value: unknown): string {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(publicSearchValue).filter(Boolean).join(' ');
  if (typeof value === 'object' && value !== null)
    return Object.values(value).map(publicSearchValue).filter(Boolean).join(' ');
  return '';
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
  ]
    .map(publicSearchValue)
    .filter(Boolean)
    .join(' ')
    .normalize('NFC')
    .toLowerCase();
}

function searchTerms(query: string | undefined): string[] {
  return (
    query
      ?.trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map((term) => term.normalize('NFC').toLowerCase()) ?? []
  );
}

function sortKey(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function compareStable(a: unknown, b: unknown): number {
  return resultCollator.compare(sortKey(a), sortKey(b)) || 0;
}

const resultCollator = new Intl.Collator('en', { numeric: true });

function compareItems(a: SnapshotItem, b: SnapshotItem): number {
  return (
    compareStable(a.releaseSortKey, b.releaseSortKey) ||
    compareStable(a.collectorNumberSortKey, b.collectorNumberSortKey) ||
    compareStable(a.finishGroupId, b.finishGroupId) ||
    compareStable(a.itemId, b.itemId)
  );
}

function matchesCriteria(
  item: SnapshotItem,
  criteria: QueryCriteria,
  matchesResearch: (progressClass: string, criterion?: ResearchCriterion) => boolean,
  privateStatuses: ReadonlyMap<string, CollectionStatus> | undefined,
  terms: readonly string[],
  searchText: string,
): boolean {
  const status = privateStatuses?.get(item.itemId) ?? 'need';
  return (
    (!criteria.localization || item.localizationId === criteria.localization) &&
    (!criteria.edition || item.setEditionId === criteria.edition) &&
    terms.every((term) => searchText.includes(term)) &&
    (!criteria.kind || item.itemKind === criteria.kind) &&
    (!criteria.research || matchesResearch(item.progressClass ?? '', criteria.research)) &&
    (!criteria.status || (item.active && item.progressClass === 'current-known' && status === criteria.status))
  );
}

export function filterCatalogueItems(
  criteria: QueryCriteria,
  catalogue: CatalogueSnapshot,
  matchesResearch: (progressClass: string, criterion?: ResearchCriterion) => boolean,
  privateStatuses?: ReadonlyMap<string, CollectionStatus>,
): SnapshotItem[] {
  return filterPreparedItems(criteria, prepareCatalogueResults(catalogue), matchesResearch, privateStatuses);
}

/** Owned by one validated snapshot, never shared across catalogue generations. */
export function prepareCatalogueResults(catalogue: CatalogueSnapshot): PreparedCatalogueResults {
  const itemsByEdition = new Map<string, SnapshotItem[]>();
  for (const item of catalogue.items) {
    if (!item.setEditionId) continue;
    const rows = itemsByEdition.get(item.setEditionId) ?? [];
    rows.push(item);
    itemsByEdition.set(item.setEditionId, rows);
  }
  const editionsByLocalization = new Map<string, SnapshotSetEdition[]>();
  for (const edition of catalogue.setEditions) {
    const rows = editionsByLocalization.get(edition.localizationId) ?? [];
    rows.push(edition);
    editionsByLocalization.set(edition.localizationId, rows);
  }
  return {
    items: [...catalogue.items].sort(compareItems),
    searchText: new Map(catalogue.items.map((item) => [item.itemId, publicSearchText(item)])),
    itemById: new Map(catalogue.items.map((item) => [item.itemId, item])),
    itemsByEdition,
    editionById: new Map(catalogue.setEditions.map((edition) => [edition.setEditionId, edition])),
    editionsByLocalization,
    setById: new Map(catalogue.localSets.map((set) => [set.localSetId, set])),
    localizationById: new Map(
      catalogue.localizations.map((localization) => [localization.localizationId, localization]),
    ),
    localizations: [...catalogue.localizations].sort(
      (a, b) => compareStable(a.displayOrder, b.displayOrder) || compareStable(a.localizationId, b.localizationId),
    ),
  };
}

function filterPreparedItems(
  criteria: QueryCriteria,
  prepared: PreparedCatalogueResults,
  matchesResearch: (progressClass: string, criterion?: ResearchCriterion) => boolean,
  privateStatuses?: ReadonlyMap<string, CollectionStatus>,
): SnapshotItem[] {
  const terms = searchTerms(criteria.q);
  return prepared.items.filter((item) =>
    matchesCriteria(
      item,
      criteria,
      matchesResearch,
      privateStatuses,
      terms,
      prepared.searchText.get(item.itemId) ?? '',
    ),
  );
}

/** One filtered feed supplies counts and all visible groupings for this revision. */
export function buildCatalogueResult(
  criteria: QueryCriteria,
  prepared: PreparedCatalogueResults,
  matchesResearch: (progressClass: string, criterion?: ResearchCriterion) => boolean,
  privateStatuses?: ReadonlyMap<string, CollectionStatus>,
): ResultViewModel & { readonly groups: readonly BrowseLocalizationViewModel[] } {
  const currentCriteria = { ...criteria };
  const items = filterPreparedItems(currentCriteria, prepared, matchesResearch, privateStatuses);
  return { ...summarizeResults(items), groups: groupResults(currentCriteria, prepared, items) };
}

export function buildProgressViewModel(
  items: readonly SnapshotItem[],
  privateStatuses?: ReadonlyMap<string, CollectionStatus>,
): ProgressViewModel {
  const currentKnown = items.filter((item) => item.active && item.progressClass === 'current-known');
  const researchTotal = items.filter((item) => item.active && item.progressClass === 'research').length;
  let haveTotal = 0;
  let orderedTotal = 0;
  let needTotal = 0;
  let skipTotal = 0;
  for (const item of currentKnown) {
    const status = privateStatuses?.get(item.itemId) ?? 'need';
    if (status === 'have') haveTotal += 1;
    else if (status === 'ordered') orderedTotal += 1;
    else if (status === 'skip') skipTotal += 1;
    else needTotal += 1;
  }
  const denominator = currentKnown.length;
  const ownedTotal = haveTotal;
  const securedTotal = haveTotal + orderedTotal;
  return {
    currentKnownTotal: denominator,
    haveTotal,
    orderedTotal,
    needTotal,
    skipTotal,
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
  return summarizeResults(filteredItems);
}

function summarizeResults(filteredItems: readonly SnapshotItem[]): ResultViewModel {
  const activeItems: SnapshotItem[] = [];
  const inactiveItems: SnapshotItem[] = [];
  for (const item of filteredItems) (item.active ? activeItems : inactiveItems).push(item);
  const activeSummary = `${activeItems.length} active public catalogue item${activeItems.length === 1 ? '' : 's'}.`;
  return inactiveItems.length === 0
    ? { activeItems, inactiveItems, activeSummary }
    : {
        activeItems,
        inactiveItems,
        activeSummary,
        inactiveHeading: 'Inactive catalogue items',
        inactiveSummary: `${inactiveItems.length} catalogue item${inactiveItems.length === 1 ? ' is' : 's are'} inactive and excluded from the active checklist.`,
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
  const prepared = prepareCatalogueResults(catalogue);
  return groupResults(criteria, prepared, filterPreparedItems(criteria, prepared, matchesResearch, privateStatuses));
}

function groupResults(
  criteria: QueryCriteria,
  prepared: PreparedCatalogueResults,
  matches: readonly SnapshotItem[],
): BrowseLocalizationViewModel[] {
  const itemByEdition = new Map<string, SnapshotItem[]>();
  for (const item of matches) {
    const editionId = item.setEditionId;
    if (!editionId) continue;
    const rows = itemByEdition.get(editionId) ?? [];
    rows.push(item);
    itemByEdition.set(editionId, rows);
  }
  const sets = prepared.setById;
  const result: BrowseLocalizationViewModel[] = [];
  for (const localization of prepared.localizations) {
    if (criteria.localization && localization.localizationId !== criteria.localization) continue;
    const bySet = new Map<string, BrowseEditionViewModel[]>();
    for (const edition of prepared.editionsByLocalization.get(localization.localizationId) ?? []) {
      const set = sets.get(edition.localSetId);
      if (!set) continue;
      const editionItems = (itemByEdition.get(edition.setEditionId) ?? []).filter((item) => item.active);
      // A filtered/global search only displays groups containing a result. A plain
      // localization browse keeps empty editions visible as useful navigation.
      if (
        (criteria.edition || criteria.q || criteria.kind || criteria.research || criteria.status) &&
        editionItems.length === 0
      )
        continue;
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
