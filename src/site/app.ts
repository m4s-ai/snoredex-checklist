import { localizationLabel, validateProvenance, validateSnapshot, type CatalogueSnapshot, type SnapshotItem, type SnapshotLocalSet, type SnapshotLocalization } from "./catalogue.js";
import { imageAssetUrl, resolveImageAsset } from "./assets.js";
import { matchesResearch } from "./filter.js";
import { collectorNumberLabel, evidenceCueLabel, imageScopeLabel, itemCueLabel, linkValues, presentText, safeExternalUrl } from "./item-presentation.js";
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
    const trimmed = value.normalize("NFC").trim().replace(/\s+/gu, " ");
    if (trimmed) parts.push(trimmed);
  }
  return parts.join(" · ") || fallback;
}

function itemFinishCue(item: SnapshotItem): string | undefined {
  const finish = typeof item.finish === "string" ? presentationLabel([item.finish], "") : "";
  const family = typeof item.finishFamily === "string" ? presentationLabel([item.finishFamily], "") : "";
  if (finish && family && finish !== family) return `Finish: ${finish} · Finish family: ${family}`;
  if (finish) return `Finish: ${finish}`;
  if (family) return `Finish family: ${family}`;
  return undefined;
}

function itemCardLabel(item: SnapshotItem): string {
  const cardName = presentationLabel([item.cardName], "Unnamed item");
  const localCardName = typeof item.localCardName === "string" ? presentationLabel([item.localCardName], "") : "";
  return localCardName && localCardName !== cardName ? `${cardName} · ${localCardName}` : cardName;
}

function itemRowCollisionKey(item: SnapshotItem, includeEdition = true): string {
  const card = itemCardLabel(item);
  const set = presentationLabel([item.localSetCode, item.localSetName, item.collectorNumber], "");
  const visibleIdentity = [card, set, itemFinishCue(item)].filter(Boolean).join(" · ");
  return [item.localizationId, includeEdition ? item.setEditionId ?? "" : "", visibleIdentity].join("\u0000");
}

function itemRowCollisionCounts(items: readonly SnapshotItem[], includeEdition = true): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = itemRowCollisionKey(item, includeEdition);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
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
  const localizationLabelCounts = new Map<string, number>();
  for (const row of catalogue.localizations) {
    const label = localizationLabel(row);
    const key = `${row.locality ?? ""}\u0000${label}`;
    localizationLabelCounts.set(key, (localizationLabelCounts.get(key) ?? 0) + 1);
  }
  for (const row of sortedLocalizations(catalogue)) {
    const label = localizationLabel(row);
    const key = `${row.locality ?? ""}\u0000${label}`;
    const displayLabel = (localizationLabelCounts.get(key) ?? 0) > 1 ? `${label} · ${row.localizationId}` : label;
    localizationOptions.push([row.localizationId, `${displayLabel}${row.locality ? ` (${row.locality})` : ""}`]);
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
    if (progress.currentKnownTotal > 0) {
      bar.max = progress.currentKnownTotal;
      bar.value = progress.ownedTotal;
      bar.setAttribute("aria-label", `Owned current-known items: ${progress.ownedTotal} of ${progress.currentKnownTotal}`);
    } else {
      bar.setAttribute("aria-label", "No current-known items to collect");
    }
    section.append(bar);
  }
  section.append(text("p", `Research: ${progress.researchTotal} read-only item${progress.researchTotal === 1 ? "" : "s"}. Research is not part of the progress denominator.`));
  return section;
}

function externalLink(href: unknown, label: string): HTMLAnchorElement | undefined {
  const safeHref = safeExternalUrl(href);
  if (!safeHref) return undefined;
  const anchor = link(safeHref, `${label} ↗`, "external-link");
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.setAttribute("aria-label", `${label} (external site)`);
  return anchor;
}

function detailValue(value: unknown, fallback = "Not recorded"): string {
  const normalized = presentText(value);
  if (normalized) return normalized;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function appendDetail(dl: HTMLElement, label: string, value: unknown, fallback = "Not recorded"): void {
  dl.append(text("dt", label), text("dd", detailValue(value, fallback)));
}

function appendLinkDetails(dl: HTMLElement, label: string, values: unknown): void {
  const list = text("ul", undefined, "item-detail-links");
  for (const [index, value] of linkValues(values).entries()) {
    const anchor = externalLink(value, `${label} ${index + 1}`);
    if (!anchor) continue;
    const li = text("li");
    li.append(anchor);
    list.append(li);
  }
  const dd = text("dd");
  dd.append(list.childElementCount > 0 ? list : text("span", "No published links."));
  dl.append(text("dt", label), dd);
}

function appendMarkingDetails(dl: HTMLElement, item: SnapshotItem): void {
  const markings = Array.isArray(item.markings) ? item.markings : [];
  const values = markings.map((marking) => {
    if (typeof marking !== "object" || marking === null) return undefined;
    const row = marking as Record<string, unknown>;
    const kind = detailValue(row.kind, "Unknown marking");
    const role = detailValue(row.role, "Unknown role");
    const value = detailValue(row.text, "Unspecified marking");
    return `${kind} · ${role}: ${value}`;
  }).filter((value): value is string => value !== undefined);
  appendDetail(dl, "Markings", values.length > 0 ? values.join("; ") : undefined, "None recorded");
}

function renderItemDetails(item: SnapshotItem, catalogue: CatalogueSnapshot, scopeLabel: string): HTMLDetailsElement {
  const details = text("details", undefined, "item-details") as HTMLDetailsElement;
  details.append(text("summary", "Details, evidence and sources"));
  const dl = text("dl", undefined, "item-detail-list");
  const localization = catalogue.localizations.find((candidate) => candidate.localizationId === item.localizationId);
  appendDetail(dl, "Item ID", item.itemId);
  appendDetail(dl, "Set edition ID", item.setEditionId);
  appendDetail(dl, "Local set ID", item.localSetId);
  appendDetail(dl, "Card release ID", item.cardReleaseId);
  appendDetail(dl, "Work ID", item.workId, "No work mapping asserted");
  appendDetail(dl, "Physical printing ID", item.physicalPrintingId, "Not assigned; this row does not assert a verified printing");
  appendDetail(dl, "Source printing ID", item.sourcePrintingId, "Not recorded");
  appendDetail(dl, "Finish unit ID", item.finishUnitId, "Not recorded");
  appendDetail(dl, "Locality", localization?.locality ?? item.localizationId);
  appendDetail(dl, "Language", localization?.languageTag ?? "Not recorded");
  appendDetail(dl, "Image scope", scopeLabel);
  appendDetail(dl, "Item class", item.itemKind);
  appendDetail(dl, "Producer evidence", item.finishVerificationStatus);
  appendDetail(dl, "Completeness", item.completenessStatus);
  appendDetail(dl, "Technical finish", item.finish, "Not recorded");
  appendDetail(dl, "Finish family", item.finishFamily, "Not recorded");
  appendDetail(dl, "Foil pattern", item.foilPattern, "Not recorded");
  appendMarkingDetails(dl, item);
  const distribution = item.distribution;
  if (typeof distribution === "object" && distribution !== null) {
    const row = distribution as Record<string, unknown>;
    appendDetail(dl, "Distribution", [row.kind, row.name, row.region, row.date, row.text]
      .map((value) => presentText(value)).filter((value): value is string => value !== undefined).join(" · "), "Not recorded");
  } else {
    appendDetail(dl, "Distribution", undefined);
  }
  const releaseDate = detailValue(item.releaseDate, "Not recorded");
  const precision = presentText(item.releaseDatePrecision);
  appendDetail(dl, "Release date", precision ? `${releaseDate} (${precision}${item.releaseApproximate === true ? ", approximate" : ""})` : releaseDate);
  appendLinkDetails(dl, "Source", item.sourceLinks);
  appendLinkDetails(dl, "Evidence", item.evidenceLinks);
  const correction = externalLink(item.correctionLink, "Submit evidence or correction");
  const correctionDd = text("dd");
  correctionDd.append(correction ?? text("span", "Correction link unavailable."));
  dl.append(text("dt", "Producer correction"), correctionDd);
  details.append(dl);
  return details;
}

let imageDialogSequence = 0;

function renderItemImage(item: SnapshotItem, catalogue: CatalogueSnapshot): HTMLElement {
  const asset = resolveImageAsset(catalogue, item);
  const scopeLabel = imageScopeLabel(item, asset.placeholder);
  const alt = `${asset.placeholder ? "Authored placeholder" : "Catalogue image"} for ${itemCardLabel(item)} · ${scopeLabel}; no real card image is implied.`;
  const figure = text("figure", undefined, "item-image");
  const image = document.createElement("img");
  image.src = imageAssetUrl(asset);
  image.alt = alt;
  image.loading = "lazy";
  image.decoding = "async";
  if (item.progressClass === "research") {
    figure.classList.add("item-image-placeholder");
    figure.append(image, text("figcaption", scopeLabel));
    return figure;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "image-button";
  button.setAttribute("aria-label", `Inspect image for ${itemCardLabel(item)} (${scopeLabel})`);
  button.append(image);
  const dialog = document.createElement("dialog");
  dialog.className = "image-dialog";
  const dialogId = `item-image-dialog-${++imageDialogSequence}`;
  dialog.id = dialogId;
  const heading = text("h3", `Image preview · ${itemCardLabel(item)}`);
  heading.id = `${dialogId}-title`;
  dialog.setAttribute("aria-labelledby", heading.id);
  const largeImage = document.createElement("img");
  largeImage.src = image.src;
  largeImage.alt = alt;
  const close = text("button", "Close image") as HTMLButtonElement;
  close.type = "button";
  close.className = "dialog-close";
  const closeDialog = (): void => {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
    button.focus();
  };
  close.addEventListener("click", closeDialog);
  dialog.addEventListener("close", () => button.focus());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog.append(heading, largeImage, text("p", scopeLabel), close);
  button.setAttribute("aria-controls", dialogId);
  button.addEventListener("click", () => {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    close.focus();
  });
  figure.append(button, text("figcaption", scopeLabel), dialog);
  return figure;
}

function renderItemRow(item: SnapshotItem, catalogue: CatalogueSnapshot, inactive = false, ownerLabel?: string, setIdentity?: string): HTMLLIElement {
  const row = text("li", undefined, "item-row") as HTMLLIElement;
  row.dataset.itemId = item.itemId;
  if (item.progressClass === "research") row.classList.add("item-row-research");
  const asset = resolveImageAsset(catalogue, item);
  const scopeLabel = imageScopeLabel(item, asset.placeholder);
  row.append(renderItemImage(item, catalogue));
  const content = text("div", undefined, "item-content");
  const identity = text("div", undefined, "item-identity");
  identity.append(text("strong", presentText(item.cardName) ?? "Unnamed item"));
  const localCardName = presentText(item.localCardName);
  if (localCardName || item.progressClass === "research") {
    identity.append(text("span", localCardName ?? "Local name not recorded", localCardName ? "item-local-name" : "item-muted"));
  }
  const set = presentationLabel([item.localSetCode, item.localSetName], "");
  const setDisplay = [set, setIdentity].filter(Boolean).join(" · ");
  if (setDisplay) identity.append(text("span", ` · ${setDisplay}`));
  if (ownerLabel) identity.append(text("span", ` · ${ownerLabel}`));
  content.append(identity);
  const metadata = text("div", undefined, "item-meta");
  const localization = catalogue.localizations.find((candidate) => candidate.localizationId === item.localizationId);
  const locale = localization ? `${localizationLabel(localization)}${localization.locality ? ` (${localization.locality})` : ""}` : item.localizationId;
  metadata.textContent = [collectorNumberLabel(item) ?? "Collector number not recorded", locale, itemFinishCue(item) ?? "Physical variation not recorded"].join(" · ");
  content.append(metadata);
  const tags = text("div", undefined, "item-tags");
  tags.append(text("span", itemCueLabel(item), "item-cue"), text("span", scopeLabel, "item-scope"));
  const evidence = evidenceCueLabel(item);
  if (evidence) tags.append(text("span", evidence, "item-cue"));
  if (inactive) tags.append(text("span", "Inactive", "item-cue"));
  content.append(tags, renderItemDetails(item, catalogue, scopeLabel));
  row.append(content);
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
  const localizationLabelCounts = new Map<string, number>();
  for (const candidate of catalogue.localizations) {
    const label = localizationLabel(candidate);
    const key = `${candidate.locality ?? ""}\u0000${label}`;
    localizationLabelCounts.set(key, (localizationLabelCounts.get(key) ?? 0) + 1);
  }
  for (const localization of groups) {
    const localizationSection = text("section", undefined, "result-localization");
    const localizationLabelValue = localizationLabel(localization.localization);
    const localizationKey = `${localization.localization.locality ?? ""}\u0000${localizationLabelValue}`;
    const displayLocalizationLabel = (localizationLabelCounts.get(localizationKey) ?? 0) > 1
      ? `${localizationLabelValue} · ${localization.localization.localizationId}`
      : localizationLabelValue;
    localizationSection.append(text("h2", `${displayLocalizationLabel}${localization.localization.locality ? ` (${localization.localization.locality})` : ""}`));
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
        const currentItems = edition.items.filter((candidate) => candidate.active && candidate.progressClass !== "research");
        const currentCollisionCounts = itemRowCollisionCounts(catalogue.items.filter((candidate) =>
          candidate.setEditionId === edition.edition.setEditionId && candidate.active && candidate.progressClass !== "research"));
        for (const item of currentItems) {
          const itemIdentity = (currentCollisionCounts.get(itemRowCollisionKey(item)) ?? 0) > 1 ? item.itemId : undefined;
          list.append(renderItemRow(item, catalogue, false, undefined, itemIdentity));
        }
        if (list.childElementCount > 0) editionSection.append(list);
        const research = edition.items.filter((item) => item.active && item.progressClass === "research");
        if (research.length > 0) {
          const researchSection = text("section", undefined, "research-section");
          researchSection.append(text("h5", "Research (read-only)"));
          const researchList = text("ul", undefined, "item-list");
          const researchCollisionCounts = itemRowCollisionCounts(catalogue.items.filter((candidate) =>
            candidate.setEditionId === edition.edition.setEditionId && candidate.active && candidate.progressClass === "research"));
          for (const item of research) {
            const itemIdentity = (researchCollisionCounts.get(itemRowCollisionKey(item)) ?? 0) > 1 ? item.itemId : undefined;
            researchList.append(renderItemRow(item, catalogue, false, undefined, itemIdentity));
          }
          researchSection.append(researchList);
          editionSection.append(researchSection);
        }
        setSection.append(editionSection);
      }
      localizationSection.append(setSection);
    }
    grouped.append(localizationSection);
  }
  if (items.length > 0) content.push(grouped);
  else if (inactiveItems.length === 0) content.push(text("p", "No public catalogue items match these criteria.", "empty-state"));
  if (inactiveItems.length > 0) {
    const inactive = text("section", undefined, "state-panel");
    inactive.append(text("h2", model.inactiveHeading), text("p", model.inactiveSummary));
    const inactiveList = text("ul", undefined, "item-list");
    const inactiveSetIdentityCounts = new Map<string, Set<string>>();
    for (const item of catalogue.items) {
      const setLabel = presentationLabel([item.localSetCode, item.localSetName, item.collectorNumber], "");
      const key = `${item.localizationId}\u0000${setLabel}`;
      const identities = inactiveSetIdentityCounts.get(key) ?? new Set<string>();
      identities.add(item.setEditionId ?? item.itemId);
      inactiveSetIdentityCounts.set(key, identities);
    }
    const inactiveCollisionCounts = itemRowCollisionCounts(catalogue.items.filter((candidate) => !candidate.active), false);
    for (const item of inactiveItems) {
      const localization = catalogue.localizations.find((candidate) => candidate.localizationId === item.localizationId);
      let ownerLabel = item.localizationId;
      if (localization) {
        const label = localizationLabel(localization);
        const key = `${localization.locality ?? ""}\u0000${label}`;
        const displayLabel = (localizationLabelCounts.get(key) ?? 0) > 1 ? `${label} · ${localization.localizationId}` : label;
        ownerLabel = `${displayLabel}${localization.locality ? ` (${localization.locality})` : ""}`;
      }
      const setLabel = presentationLabel([item.localSetCode, item.localSetName, item.collectorNumber], "");
      const setKey = `${item.localizationId}\u0000${setLabel}`;
      const setIdentity = !setLabel
        ? (item.setEditionId ?? item.itemId)
        : (inactiveSetIdentityCounts.get(setKey)?.size ?? 0) > 1 ? item.setEditionId : undefined;
      const itemIdentity = (inactiveCollisionCounts.get(itemRowCollisionKey(item, false)) ?? 0) > 1 ? item.itemId : undefined;
      const identitySuffix = [setIdentity, itemIdentity].filter(Boolean).join(" · ") || undefined;
      inactiveList.append(renderItemRow(item, catalogue, true, ownerLabel, identitySuffix));
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
