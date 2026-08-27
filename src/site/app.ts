import { localizationLabel, validateProvenance, validateSnapshot, type CatalogueSnapshot, type SnapshotItem, type SnapshotLocalSet, type SnapshotLocalization } from "./catalogue.js";
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

function presentationLabel(values: readonly (string | null | undefined)[], fallback: string): string {
  const parts: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim().replace(/\s+/gu, " ");
    if (trimmed) parts.push(trimmed);
  }
  return parts.join(" · ") || fallback;
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
  const tree = text("div", undefined, "browse-tree");
  const localities = text("ul", undefined, "link-list");
  const localizations = new Map(catalogue.localizations.map((localization) => [localization.localizationId, localization] as const));
  const setsByLocality = new Map<string, SnapshotLocalSet[]>();
  for (const set of catalogue.localSets) {
    const rows = setsByLocality.get(set.locality) ?? [];
    rows.push(set);
    setsByLocality.set(set.locality, rows);
  }
  for (const [locality, localitySets] of [...setsByLocality.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const localityItem = text("li", undefined, "browse-locality");
    localityItem.append(text("strong", locality));
    const setList = text("ul", undefined, "link-list browse-nested");
    const setLabelCounts = new Map<string, number>();
    for (const set of localitySets) {
      const setLabel = presentationLabel([set.localSetCode, set.localSetName], set.localSetId);
      setLabelCounts.set(setLabel, (setLabelCounts.get(setLabel) ?? 0) + 1);
    }
    for (const set of localitySets.sort((left, right) =>
      String(left.sortKey ?? "").localeCompare(String(right.sortKey ?? ""), "en", { numeric: true }) || left.localSetId.localeCompare(right.localSetId))) {
      const setItem = text("li", undefined, "browse-set");
      const setLabel = presentationLabel([set.localSetCode, set.localSetName], set.localSetId);
      const displaySetLabel = (setLabelCounts.get(setLabel) ?? 0) > 1 ? `${setLabel} · ${set.localSetId}` : setLabel;
      setItem.append(text("span", displaySetLabel));
      const editionList = text("ul", undefined, "browse-nested");
      const editions = catalogue.setEditions.filter((edition) => edition.localSetId === set.localSetId);
      const editionEntries = editions
        .sort((left, right) =>
          String(left.sortKey ?? "").localeCompare(String(right.sortKey ?? ""), "en", { numeric: true }) || left.setEditionId.localeCompare(right.setEditionId))
        .map((edition) => {
          const editionLabel = presentationLabel([edition.localSetCode, edition.localSetName], edition.setEditionId);
          const localization = localizations.get(edition.localizationId);
          const label = localization ? `${editionLabel} · ${localizationLabel(localization)}` : editionLabel;
          return { edition, label };
        });
      const labelCounts = new Map<string, number>();
      for (const { label } of editionEntries) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      for (const { edition, label } of editionEntries) {
        const editionItem = text("li", undefined, "browse-edition");
        const projectionLabel = (labelCounts.get(label) ?? 0) > 1 ? `${label} · ${edition.setEditionId}` : label;
        editionItem.append(link(`./${serializeQuery({ localization: edition.localizationId, edition: edition.setEditionId })}`, projectionLabel));
        editionList.append(editionItem);
      }
      setItem.append(editionList);
      setList.append(setItem);
    }
    localityItem.append(setList);
    localities.append(localityItem);
  }
  tree.append(localities);
  details.append(tree);
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
  const localizationSelect = localization.querySelector("select");
  const editionId = criteria.edition;
  const selectedEdition = editionId === undefined
    ? undefined
    : catalogue.setEditions.find((edition) => edition.setEditionId === editionId);
  const editionInput = editionId === undefined ? undefined : document.createElement("input");
  if (editionInput !== undefined) {
    editionInput.type = "hidden";
    editionInput.name = "edition";
    editionInput.value = editionId ?? "";
  }
  let localizationChanged = false;
  const syncEditionScope = (): void => {
    if (editionInput === undefined || !(localizationSelect instanceof HTMLSelectElement)) return;
    const explicitScopeChange = localizationChanged;
    editionInput.disabled = selectedEdition?.localizationId !== undefined &&
      explicitScopeChange && localizationSelect.value !== selectedEdition.localizationId;
  };
  localizationSelect?.addEventListener("change", () => {
    localizationChanged = true;
    syncEditionScope();
  });
  const query = text("label", "Search public catalogue text") as HTMLLabelElement;
  const input = document.createElement("input");
  input.type = "search"; input.name = "q"; input.maxLength = 120; input.value = criteria.q ?? "";
  const syncSearchValidity = (): void => {
    const terms = input.value.trim().split(/\s+/u).filter(Boolean);
    input.setCustomValidity(terms.length > 12 ? "Use at most 12 search terms." : "");
  };
  input.addEventListener("input", syncSearchValidity);
  syncSearchValidity();
  query.append(input);
  const status = makeSelect("Status", "status", [["", "All statuses"], ["need", "Need"], ["ordered", "Ordered"], ["have", "Have"], ["skip", "Skip"]], criteria.status);
  const kind = makeSelect("Item class", "kind", [["", "All item classes"], ["verified-printing", "Verified printing"], ["finish-candidate", "Finish candidate"], ["research-placeholder", "Research placeholder"]], criteria.kind);
  const research = makeSelect("Research", "research", [["", "Current and research"], ["false", "Current-known only"], ["true", "Research only"]], criteria.research);
  const submit = text("button", "Apply criteria") as HTMLButtonElement; submit.type = "submit";
  form.addEventListener("submit", (event) => {
    syncSearchValidity();
    if (!input.checkValidity()) {
      event.preventDefault();
      return;
    }
    // Empty optional controls are omitted; explicit empty URL values remain invalid.
    for (const control of controls) control.disabled = control.value === "";
    input.disabled = input.value.trim() === "";
    syncEditionScope();
  });
  window.addEventListener("pageshow", () => {
    // bfcache can restore the submitted DOM; controls must remain editable on Back.
    for (const control of controls) control.disabled = false;
    input.disabled = false;
    syncEditionScope();
  });
  if (editionInput !== undefined) form.append(editionInput);
  syncEditionScope();
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

function renderProgress(catalogue: CatalogueSnapshot, localizationId: string | undefined, editionId: string | undefined, state: PrivateStateRead): HTMLElement {
  const scope = catalogue.items.filter((item) =>
    (!localizationId || item.localizationId === localizationId) && (!editionId || item.setEditionId === editionId));
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

function renderItemRow(item: SnapshotItem, inactive = false, ownerLabel?: string): HTMLLIElement {
  const row = text("li", undefined, "item-row") as HTMLLIElement;
  const identity = text("div", undefined, "item-identity");
  identity.append(text("strong", item.cardName ?? "Unnamed item"));
  if (item.localCardName && item.localCardName !== item.cardName) identity.append(text("span", ` · ${item.localCardName}`));
  const set = presentationLabel([item.localSetCode, item.localSetName, item.collectorNumber], "");
  if (set) identity.append(text("span", ` · ${set}`));
  if (ownerLabel) identity.append(text("span", ` · ${ownerLabel}`));
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
  const hasFilter = Boolean(criteria.edition || criteria.q || criteria.kind || criteria.research || criteria.status);
  if (!criteria.localization && !hasFilter) {
    const summary = text("div", undefined, "state-panel");
    summary.append(text("h2", "Choose a localization or search"), text("p", "Browse one localization or search the public catalogue across set groups. The owning localization and set remain labelled on every result."));
    container.replaceChildren(summary);
    return;
  }
  const progress = renderProgress(catalogue, criteria.localization, criteria.edition, state);
  const model = buildResultViewModel(criteria, catalogue, matchesResearch, state.readable ? state.statuses : undefined);
  const { activeItems: items, inactiveItems } = model;
  const content: Node[] = [progress, text("p", model.activeSummary)];
  const groups = buildBrowseHierarchy(criteria, catalogue, matchesResearch, state.readable ? state.statuses : undefined);
  const grouped = text("div", undefined, "browse-results");
  for (const localization of groups) {
    const localizationSection = text("section", undefined, "result-localization");
    localizationSection.append(text("h2", `${localizationLabel(localization.localization)}${localization.localization.locality ? ` (${localization.localization.locality})` : ""}`));
    const setLabelCounts = new Map<string, number>();
    for (const candidate of catalogue.localSets) {
      if (localization.localization.locality !== undefined && candidate.locality !== localization.localization.locality) continue;
      const setLabel = presentationLabel([candidate.localSetCode, candidate.localSetName], candidate.localSetId);
      setLabelCounts.set(setLabel, (setLabelCounts.get(setLabel) ?? 0) + 1);
    }
    for (const set of localization.sets) {
      const setSection = text("section", undefined, "result-set");
      const setLabel = presentationLabel([set.set.localSetCode, set.set.localSetName], set.set.localSetId);
      const displaySetLabel = (setLabelCounts.get(setLabel) ?? 0) > 1 ? `${setLabel} · ${set.set.localSetId}` : setLabel;
      setSection.append(text("h3", displaySetLabel));
      const siblingEditionLabelCounts = new Map<string, number>();
      for (const sibling of catalogue.setEditions) {
        if (sibling.localSetId !== set.set.localSetId || sibling.localizationId !== localization.localization.localizationId) continue;
        const siblingLabel = presentationLabel([sibling.localSetCode, sibling.localSetName], sibling.setEditionId);
        siblingEditionLabelCounts.set(siblingLabel, (siblingEditionLabelCounts.get(siblingLabel) ?? 0) + 1);
      }
      for (const edition of set.editions) {
        const editionSection = text("section", undefined, "result-edition");
        const editionLabel = presentationLabel([edition.edition.localSetCode, edition.edition.localSetName], edition.edition.setEditionId);
        const headingLabel = (siblingEditionLabelCounts.get(editionLabel) ?? 0) > 1 ? `${editionLabel} · ${edition.edition.setEditionId}` : editionLabel;
        editionSection.append(text("h4", headingLabel));
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
    for (const item of inactiveItems) {
      const localization = catalogue.localizations.find((candidate) => candidate.localizationId === item.localizationId);
      const ownerLabel = localization
        ? `${localizationLabel(localization)}${localization.locality ? ` (${localization.locality})` : ""}`
        : item.localizationId;
      inactiveList.append(renderItemRow(item, true, ownerLabel));
    }
    inactive.append(inactiveList);
    content.push(inactive);
  }
  container.replaceChildren(...content);
}

async function renderCollection(catalogue: CatalogueSnapshot): Promise<void> {
  const ids = new Set(sortedLocalizations(catalogue).map((row) => row.localizationId));
  const editionIds = new Set(catalogue.setEditions.map((row) => row.setEditionId));
  const parsed = parseQuery(window.location.search, ids, editionIds);
  renderProvenance($("[data-provenance]"), catalogue);
  renderBrowseNavigation($("[data-localizations]"), catalogue);
  if (!parsed.ok) {
    renderInvalid($("[data-view]"), parsed.recoverableLocalization);
    return;
  }
  if (parsed.criteria.edition) {
    const edition = catalogue.setEditions.find((row) => row.setEditionId === parsed.criteria.edition);
    if (!edition || (parsed.criteria.localization && edition.localizationId !== parsed.criteria.localization)) {
      renderInvalid($("[data-view]"), parsed.criteria.localization);
      return;
    }
  }
  const knownTrackableItemIds = new Set(catalogue.items
    .filter((item) => item.active && item.progressClass === "current-known")
    .map((item) => item.itemId));
  const state = await readPrivateState(catalogue.meta.catalogueFingerprint, knownTrackableItemIds);
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
