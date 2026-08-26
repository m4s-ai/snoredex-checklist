import { validateSnapshot, type CatalogueSnapshot, type SnapshotItem, type SnapshotLocalization } from "./catalogue.js";
import { parseQuery, serializeQuery, type QueryCriteria } from "./query.js";
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
    button.textContent = theme === "dark" ? "Use light theme" : "Use dark theme";
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
    ["Contract", provenance.contractVersion ?? catalogue.meta.schemaVersion],
    ["Catalogue fingerprint", catalogue.meta.catalogueFingerprint],
    ["Build input", provenance.mode],
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
    const name = localization.displayName ?? localization.languageTag ?? localization.localizationId;
    const suffix = localization.locality ? ` (${localization.locality})` : "";
    const li = text("li");
    li.append(link(`${hrefPrefix}${serializeQuery({ localization: localization.localizationId })}`, `${name}${suffix}`));
    list.append(li);
  }
  container.replaceChildren(list);
}

function renderIndex(catalogue: CatalogueSnapshot): void {
  renderProvenance($("[data-provenance]"), catalogue);
  renderLocalizationLinks($("[data-localizations]"), catalogue);
}

function publicSearchText(item: SnapshotItem): string {
  return [item.cardName, item.localCardName, item.localSetName, item.localSetCode, item.collectorNumber]
    .filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase();
}

function renderQueryForm(container: HTMLElement, criteria: QueryCriteria, catalogue: CatalogueSnapshot): void {
  const form = text("form", undefined, "query-form") as HTMLFormElement;
  form.method = "get";
  form.action = "./";
  const localization = text("label", "Localization") as HTMLLabelElement;
  const select = document.createElement("select");
  select.name = "localization";
  const home = text("option", "All localizations") as HTMLOptionElement;
  home.value = ""; select.append(home);
  for (const row of sortedLocalizations(catalogue)) {
    const option = text("option", row.displayName ?? row.localizationId) as HTMLOptionElement;
    option.value = row.localizationId; option.selected = row.localizationId === criteria.localization; select.append(option);
  }
  localization.append(select);
  const query = text("label", "Search public catalogue text") as HTMLLabelElement;
  const input = document.createElement("input");
  input.type = "search"; input.name = "q"; input.maxLength = 120; input.value = criteria.q ?? "";
  query.append(input);
  const submit = text("button", "Apply criteria") as HTMLButtonElement; submit.type = "submit";
  form.addEventListener("submit", () => {
    // Empty optional controls are omitted; explicit empty URL values remain invalid.
    select.disabled = select.value === "";
    input.disabled = input.value === "";
  });
  form.append(localization, query, submit);
  container.replaceChildren(form);
}

function renderInvalid(container: HTMLElement, recoverableLocalization?: string): void {
  container.hidden = false;
  const section = text("section", undefined, "state-panel");
  section.setAttribute("aria-live", "polite");
  section.append(text("h2", "Invalid checklist link"), text("p", "The complete link could not be validated. No catalogue or private collection state was read."));
  const actions = text("p");
  actions.append(link(recoverableLocalization ? `./${serializeQuery({ localization: recoverableLocalization })}` : "./", "Clear invalid criteria"), " · ", link("../", "Home"));
  section.append(actions); container.replaceChildren(section);
}

function renderResults(container: HTMLElement, criteria: QueryCriteria, catalogue: CatalogueSnapshot): void {
  if (criteria.status) {
    const deferred = text("section", undefined, "state-panel");
    deferred.setAttribute("aria-live", "polite");
    deferred.append(text("h2", "Status filter pending"), text("p", "This public criterion is preserved in the link, but private progress is not available to the static shell yet. The collection state layer will apply it without exposing private values in the URL."));
    container.replaceChildren(deferred);
    return;
  }
  if (!criteria.localization) {
    const summary = text("div", undefined, "state-panel");
    summary.append(text("h2", "Choose a localization"), text("p", "The home view shows public summaries only. Choose a localization to open its checklist and keep the URL shareable."));
    container.replaceChildren(summary);
    return;
  }
  const localizationIds = criteria.localization ? new Set([criteria.localization]) : undefined;
  const query = criteria.q?.toLocaleLowerCase();
  const items = catalogue.items.filter((item) => (!localizationIds || localizationIds.has(item.localizationId)) &&
    (!query || publicSearchText(item).includes(query)) && (!criteria.kind || item.itemKind === criteria.kind) &&
    (!criteria.research || (criteria.research === "true") === (item.progressClass === "research")));
  const list = text("ul", undefined, "item-list");
  for (const item of items.slice(0, 50)) {
    const row = text("li", undefined, "item-row");
    row.append(text("strong", item.cardName ?? "Unnamed item"), text("span", ` · ${item.localSetCode ?? "Unknown set"} ${item.collectorNumber ?? ""}`));
    if (item.localCardName) row.append(text("span", ` · ${item.localCardName}`));
    list.append(row);
  }
  container.replaceChildren(text("p", `${items.length} public catalogue item${items.length === 1 ? "" : "s"}. Private progress is intentionally not part of this shell.`), list);
}

function renderCollection(catalogue: CatalogueSnapshot): void {
  const ids = new Set(sortedLocalizations(catalogue).map((row) => row.localizationId));
  const parsed = parseQuery(window.location.search, ids);
  renderProvenance($("[data-provenance]"), catalogue);
  renderLocalizationLinks($("[data-localizations]"), catalogue, "");
  if (!parsed.ok) {
    renderInvalid($("[data-view]"), parsed.recoverableLocalization);
    return;
  }
  renderQueryForm($("[data-query]"), parsed.criteria, catalogue);
  renderResults($("[data-view]"), parsed.criteria, catalogue);
}

enableThemeControl();
const validated = validateSnapshot(snapshot);
if (!validated.ok) {
  renderInvalid($("[data-view]"));
} else if (document.body.dataset.page === "collection") {
  renderCollection(validated.snapshot);
} else {
  renderIndex(validated.snapshot);
}
