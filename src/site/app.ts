import { localizationLabel, validateProvenance, validateSnapshot, type CatalogueSnapshot, type SnapshotItem, type SnapshotLocalization } from "./catalogue.js";
import { matchesResearch } from "./filter.js";
import { readPrivateState, type PrivateStateRead } from "./private-state.js";
import { parseQuery, serializeQuery, type QueryCriteria } from "./query.js";
import { buildBrowseHierarchy, buildProgressViewModel, buildResultViewModel } from "./results.js";
import snapshot, { provenance } from "./snapshot.js";

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

function text(tag: string, value?: unknown, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.textContent = String(value);
  return element;
}

function link(href: string, label: string, className?: string): HTMLAnchorElement {
  const element = text("a", label, className) as HTMLAnchorElement;
  element.href = href;
  return element;
}

function enableThemeControl(): void {
  const button = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  if (!button) return;
  const update = (): void => {
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    button.textContent = "Dark theme";
    button.setAttribute("aria-pressed", String(theme === "dark"));
  };
  button.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("snoredex-theme", next); } catch { /* private state stays local */ }
    update();
  });
  update();
}

function renderProvenance(container: HTMLElement, catalogue: CatalogueSnapshot): void {
  const dl = text("dl", undefined, "provenance");
  const fields: readonly [string, unknown][] = [
    ["Data as of", catalogue.meta.dataAsOf ?? "Unknown"],
    ["Source", catalogue.meta.sourceRepository ?? "Unknown"],
    ["Contract", catalogue.meta.schemaVersion],
    ["Catalogue fingerprint", catalogue.meta.catalogueFingerprint],
    ["Build input", "synthetic-fixture"],
  ];
  for (const [label, value] of fields) {
    dl.append(text("dt", label), text("dd", value));
  }
  container.replaceChildren(dl);
}

function sortedLocalizations(catalogue: CatalogueSnapshot): SnapshotLocalization[] {
  return [...catalogue.localizations].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
}

function renderLocalizationLinks(container: HTMLElement, catalogue: CatalogueSnapshot, hrefPrefix = "collection/"): void {
  const list = text("ul", undefined, "link-list");
  for (const localization of sortedLocalizations(catalogue)) {
    const name = localizationLabel(localization);
    const suffix = localization.locality ? ` (${localization.locality})` : "";
    const li = text("li");
    li.append(link(`${hrefPrefix}${serializeQuery({ localization: localization.localizationId })}`, `${name}${suffix}`));
    list.append(li);
  }
  container.replaceChildren(list);
}

function renderBrowseNavigation(container: HTMLElement, catalogue: CatalogueSnapshot): void {
  const details = text("details", undefined, "browse-details") as HTMLDetailsElement;
  details.open = true;
  details.append(text("summary", "Browse sets"));
  const nav = text("nav", undefined, "browse-tree");
  nav.setAttribute("aria-label", "Locality, set and edition hierarchy");
  const localizations = text("ul", undefined, "link-list");
  const sets = new Map(catalogue.localSets.map((set) => [set.localSetId, set] as const));
  for (const localization of sortedLocalizations(catalogue)) {
    const localizationItem = text("li", undefined, "browse-localization");
    localizationItem.append(link(`./${serializeQuery({ localization: localization.localizationId })}`, `${localizationLabel(localization)}${localization.locality ? ` (${localization.locality})` : ""}`));
    const setList = text("ul", undefined, "link-list browse-nested");
    const seen = new Set<string>();
    for (const edition of catalogue.setEditions) {
      if (edition.localizationId !== localization.localizationId || seen.has(edition.localSetId)) continue;
      seen.add(edition.localSetId);
      const set = sets.get(edition.localSetId);
      if (!set) continue;
      const setItem = text("li");
      const setLabel = [set.localSetCode, set.localSetName].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · ") || set.localSetId;
      setItem.append(text("span", setLabel));
      const editionList = text("ul", undefined, "browse-nested");
      for (const row of catalogue.setEditions.filter((candidate) => candidate.localizationId === localization.localizationId && candidate.localSetId === set.localSetId)) {
        const editionItem = text("li");
        const editionLabel = [row.localSetCode, row.localSetName].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · ") || row.setEditionId;
        editionItem.append(text("span", editionLabel));
        editionList.append(editionItem);
      }
      setItem.append(editionList);
      setList.append(setItem);
    }
    localizationItem.append(setList);
    localizations.append(localizationItem);
  }
  nav.append(localizations);
  details.append(nav);
  container.replaceChildren(details);
}

function renderIndex(catalogue: CatalogueSnapshot): void {
  renderProvenance($("[data-provenance]"), catalogue);
  renderLocalizationLinks($("[data-localizations]"), catalogue);
}

function renderQueryForm(container: HTMLElement, criteria: QueryCriteria, catalogue: CatalogueSnapshot): void {
  const form = text("form", undefined, "query-form") as HTMLFormElement;
  form.method = "get";
  form.action = "./";
  const controls: HTMLSelectElement[] = [];
  const makeSelect = (labelText: string, name: string, options: readonly [string, string][], value?: string): HTMLLabelElement => {
    const label = text("label", labelText) as HTMLLabelElement;
    const select = document.createElement("select");
    select.name = name;
    for (const [optionValue, optionLabel] of options) {
      const option = text("option", optionLabel) as HTMLOptionElement;
      option.value = optionValue;
      option.selected = optionValue === (value ?? "");
      select.append(option);
    }
    controls.push(select);
    label.append(select);
    return label;
  };
  const localizationOptions: [string, string][] = [["", "All localizations"]];
  for (const row of sortedLocalizations(catalogue)) {
    localizationOptions.push([row.localizationId, `${localizationLabel(row)}${row.locality ? ` (${row.locality})` : ""}`]);
  }
  const localization = makeSelect("Localization", "localization", localizationOptions, criteria.localization);
  const query = text("label", "Search public catalogue text") as HTMLLabelElement;
  const input = document.createElement("input");
  input.type = "search"; input.name = "q"; input.maxLength = 120; input.value = criteria.q ?? "";
  query.append(input);
  const status = makeSelect("Status", "status", [["", "All statuses"], ["need", "Need"], ["ordered", "Ordered"], ["have", "Have"], ["skip", "Skip"]], criteria.status);
  const kind = makeSelect("Item class", "kind", [["", "All item classes"], ["verified-printing", "Verified printing"], ["finish-candidate", "Finish candidate"], ["research-placeholder", "Research placeholder"]], criteria.kind);
  const research = makeSelect("Research", "research", [["", "Current and research"], ["false", "Current-known only"], ["true", "Research only"]], criteria.research);
  const submit = text("button", "Apply criteria") as HTMLButtonElement; submit.type = "submit";
  form.addEventListener("submit", () => {
    // Empty optional controls are omitted; explicit empty URL values remain invalid.
    for (const control of controls) control.disabled = control.value === "";
    input.disabled = input.value === "";
  });
  window.addEventListener("pageshow", () => {
    // bfcache can restore the submitted DOM; controls must remain editable on Back.
    for (const control of controls) control.disabled = false;
    input.disabled = false;
  });
  form.append(localization, query, status, kind, research, submit);
  container.replaceChildren(form);
}

function renderInvalid(container: HTMLElement, recoverableLocalization?: string, failClosed = false): void {
  if (failClosed) {
    for (const element of document.querySelectorAll<HTMLElement>("[data-catalogue-dependent]")) element.hidden = true;
  }
  container.hidden = false;
  const section = text("section", undefined, "state-panel");
  section.setAttribute("aria-live", "polite");
  const stateMessage = failClosed
    ? "The complete link could not be validated. No catalogue or private collection state was read."
    : "The complete link could not be validated. No private collection state was read.";
  section.append(text("h2", "Invalid checklist link"), text("p", stateMessage));
  const actions = text("p");
  if (recoverableLocalization || window.location.search) {
    actions.append(link(recoverableLocalization ? `./${serializeQuery({ localization: recoverableLocalization })}` : "./", "Clear invalid criteria"));
  }
  const homeHref = document.body.dataset.page === "collection" ? "../" : "./";
  if (actions.childElementCount > 0) actions.append(" · ");
  actions.append(link(homeHref, "Home"));
  section.append(actions); container.replaceChildren(section);
}

function renderProgress(catalogue: CatalogueSnapshot, localizationId: string | undefined, state: PrivateStateRead): HTMLElement {
  const scope = catalogue.items.filter((item) => !localizationId || item.localizationId === localizationId);
  const progress = buildProgressViewModel(scope, state.readable ? state.statuses : undefined);
  const section = text("section", undefined, "progress-panel");
  const heading = text("h2", "Current-known progress");
  heading.id = "progress-title";
  section.setAttribute("aria-labelledby", heading.id);
  section.append(heading);
  if (!state.readable) {
    section.append(text("p", "Collection progress is temporarily unavailable because the local state could not be read. Public catalogue counts remain available."));
    const bar = document.createElement("progress");
    bar.max = 1;
    bar.removeAttribute("value");
    bar.setAttribute("aria-label", "Current-known progress unavailable");
    section.append(bar);
  } else {
    section.append(text("p", `${progress.ownedTotal} of ${progress.currentKnownTotal} current-known items owned · ${progress.securedTotal} secured (Have or Ordered)`));
    const bar = document.createElement("progress");
    bar.max = Math.max(1, progress.currentKnownTotal);
    bar.value = progress.ownedTotal;
    bar.setAttribute("aria-label", `Owned current-known items: ${progress.ownedTotal} of ${progress.currentKnownTotal}`);
    section.append(bar);
  }
  section.append(text("p", `Research: ${progress.researchTotal} read-only item${progress.researchTotal === 1 ? "" : "s"}. Research is not part of the progress denominator.`));
  return section;
}

function renderItemRow(item: SnapshotItem, inactive = false): HTMLLIElement {
  const row = text("li", undefined, "item-row") as HTMLLIElement;
  const identity = text("div", undefined, "item-identity");
  identity.append(text("strong", item.cardName ?? "Unnamed item"));
  if (item.localCardName && item.localCardName !== item.cardName) identity.append(text("span", ` · ${item.localCardName}`));
  const set = [item.localSetCode, item.localSetName, item.collectorNumber].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · ");
  if (set) identity.append(text("span", ` · ${set}`));
  row.append(identity);
  const cue = item.progressClass === "research"
    ? "Research · read-only"
    : item.itemKind === "verified-printing" ? "Current-known · verified printing" : "Current-known";
  row.append(text("span", cue, "item-cue"));
  if (inactive) row.append(text("span", "Inactive", "item-cue"));
  return row;
}

function renderResults(container: HTMLElement, criteria: QueryCriteria, catalogue: CatalogueSnapshot, state: PrivateStateRead): void {
  if (criteria.status && !state.readable) {
    const deferred = text("section", undefined, "state-panel");
    deferred.setAttribute("aria-live", "polite");
    deferred.append(text("h2", "Status filter unavailable"), text("p", "The local collection state could not be read, so this status filter was not applied. Reload the page or restore a valid local collection and try again."));
    container.replaceChildren(deferred);
    return;
  }
  const hasFilter = Boolean(criteria.q || criteria.kind || criteria.research || criteria.status);
  if (!criteria.localization && !hasFilter) {
    const summary = text("div", undefined, "state-panel");
    summary.append(text("h2", "Choose a localization or search"), text("p", "Browse one localization or search the public catalogue across set groups. The owning localization and set remain labelled on every result."));
    container.replaceChildren(summary);
    return;
  }
  const progress = renderProgress(catalogue, criteria.localization, state);
  const model = buildResultViewModel(criteria, catalogue, matchesResearch, state.readable ? state.statuses : undefined);
  const { activeItems: items, inactiveItems } = model;
  const content: Node[] = [progress, text("p", model.activeSummary)];
  const groups = buildBrowseHierarchy(criteria, catalogue, matchesResearch, state.readable ? state.statuses : undefined);
  const grouped = text("div", undefined, "browse-results");
  for (const localization of groups) {
    const localizationSection = text("section", undefined, "result-localization");
    localizationSection.append(text("h2", `${localization.localization.displayName ?? localization.localization.localizationId}${localization.localization.locality ? ` (${localization.localization.locality})` : ""}`));
    for (const set of localization.sets) {
      const setSection = text("section", undefined, "result-set");
      const setLabel = [set.set.localSetCode, set.set.localSetName].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · ") || set.set.localSetId;
      setSection.append(text("h3", setLabel));
      for (const edition of set.editions) {
        const editionSection = text("section", undefined, "result-edition");
        const editionLabel = [edition.edition.localSetCode, edition.edition.localSetName].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · ") || edition.edition.setEditionId;
        editionSection.append(text("h4", editionLabel));
        const list = text("ul", undefined, "item-list");
        for (const item of edition.items.filter((candidate) => candidate.active && candidate.progressClass !== "research")) list.append(renderItemRow(item));
        if (list.childElementCount > 0) editionSection.append(list);
        const research = edition.items.filter((item) => item.active && item.progressClass === "research");
        if (research.length > 0) {
          const researchSection = text("section", undefined, "research-section");
          researchSection.append(text("h5", "Research (read-only)"));
          const researchList = text("ul", undefined, "item-list");
          for (const item of research) researchList.append(renderItemRow(item));
          researchSection.append(researchList);
          editionSection.append(researchSection);
        }
        setSection.append(editionSection);
      }
      localizationSection.append(setSection);
    }
    grouped.append(localizationSection);
  }
  if (groups.length === 0 || items.length === 0) content.push(text("p", "No public catalogue items match these criteria.", "empty-state"));
  else content.push(grouped);
  if (inactiveItems.length > 0) {
    const inactive = text("section", undefined, "state-panel");
    inactive.append(text("h2", model.inactiveHeading), text("p", model.inactiveSummary));
    const inactiveList = text("ul", undefined, "item-list");
    for (const item of inactiveItems) inactiveList.append(renderItemRow(item, true));
    inactive.append(inactiveList);
    content.push(inactive);
  }
  container.replaceChildren(...content);
}

async function renderCollection(catalogue: CatalogueSnapshot): Promise<void> {
  const ids = new Set(sortedLocalizations(catalogue).map((row) => row.localizationId));
  const parsed = parseQuery(window.location.search, ids);
  renderProvenance($("[data-provenance]"), catalogue);
  renderBrowseNavigation($("[data-localizations]"), catalogue);
  if (!parsed.ok) {
    renderInvalid($("[data-view]"), parsed.recoverableLocalization);
    return;
  }
  const state = await readPrivateState();
  renderQueryForm($("[data-query]"), parsed.criteria, catalogue);
  renderResults($("[data-view]"), parsed.criteria, catalogue, state);
}

enableThemeControl();
const validated = await validateSnapshot(snapshot);
if (!validated.ok) {
  renderInvalid($("[data-view]"), undefined, true);
} else if (!validateProvenance(provenance, validated.snapshot)) {
  renderInvalid($("[data-view]"), undefined, true);
} else if (document.body.dataset.page === "collection") {
  await renderCollection(validated.snapshot);
} else {
  renderIndex(validated.snapshot);
}
