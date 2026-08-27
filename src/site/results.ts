import type { CatalogueSnapshot, SnapshotItem } from "./catalogue.js";
import type { ResearchCriterion } from "./filter.js";
import type { QueryCriteria } from "./query.js";

export interface ResultViewModel {
  readonly activeItems: SnapshotItem[];
  readonly inactiveItems: SnapshotItem[];
  readonly activeSummary: string;
  readonly inactiveHeading?: string;
  readonly inactiveSummary?: string;
}

function publicSearchText(item: SnapshotItem): string {
  return [item.cardName, item.localCardName, item.localSetName, item.localSetCode, item.collectorNumber]
    .filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
}

export function buildResultViewModel(
  criteria: QueryCriteria,
  catalogue: CatalogueSnapshot,
  matchesResearch: (progressClass: string, criterion?: ResearchCriterion) => boolean,
): ResultViewModel {
  const localizationIds = criteria.localization ? new Set([criteria.localization]) : undefined;
  const query = criteria.q?.toLowerCase();
  const filteredItems = catalogue.items.filter((item) => (!localizationIds || localizationIds.has(item.localizationId)) &&
    (!query || publicSearchText(item).includes(query)) && (!criteria.kind || item.itemKind === criteria.kind) &&
    matchesResearch(item.progressClass ?? "", criteria.research));
  const activeItems: SnapshotItem[] = [];
  const inactiveItems: SnapshotItem[] = [];
  for (const item of filteredItems) (item.active ? activeItems : inactiveItems).push(item);
  const activeSummary = `${activeItems.length} public catalogue item${activeItems.length === 1 ? "" : "s"}. Private progress is intentionally not part of this shell.`;
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
