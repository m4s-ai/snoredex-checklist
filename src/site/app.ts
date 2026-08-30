import {
  localizationLabel,
  validateProvenance,
  validateSnapshot,
  type CatalogueSnapshot,
  type SnapshotItem,
  type SnapshotLocalSet,
  type SnapshotLocalization,
} from './catalogue.js';
import { imageAssetUrl, resolveImageAsset } from './assets.js';
import {
  createCollectionStateController,
  type CollectionEditResult,
  type CollectionReconciliationOptions,
  type CollectionStateController,
} from './collection-state.js';
import { matchesResearch } from './filter.js';
import {
  collectorNumberLabel,
  evidenceCueLabel,
  imageScopeLabel,
  itemCueLabel,
  linkValues,
  presentText,
  safeExternalUrl,
} from './item-presentation.js';
import { readPrivateState, type PrivateStateRead } from './private-state.js';
import { parseQuery, serializeQuery, type QueryCriteria } from './query.js';
import { buildBrowseHierarchy, buildProgressViewModel, buildResultViewModel } from './results.js';
import { knownSourceItemIdsByFingerprint, migrationManifest } from './migrations.js';
import snapshot, { provenance } from './snapshot.js';

interface BackupExport {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

interface BackupPreview {
  readonly mode: 'create' | 'replace';
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly schemaVersion: string;
  readonly explicitRecordCount: number;
  readonly statusCounts: Readonly<Record<'need' | 'ordered' | 'have' | 'skip', number>>;
  readonly quantityOwned: number;
  readonly quantityOrdered: number;
  readonly noteCount: number;
  readonly recordsToReplace: number;
  readonly reconciliation?: Readonly<{
    readonly oldExplicitRecords: number;
    readonly retained: number;
    readonly migrated: number;
    readonly retiredOrphans: number;
    readonly conflicts: number;
    readonly unresolved: number;
    readonly newCurrentKnown: number;
    readonly newResearch: number;
    readonly accountedOldRecords: number;
    readonly conservationSatisfied: boolean;
  }>;
}

interface BackupPlan {
  readonly preview: BackupPreview;
  readonly candidate: unknown;
}

interface BackupReadState {
  readonly active: { readonly items: readonly unknown[] } | undefined;
  readonly recovery: { readonly items: readonly unknown[] } | undefined;
}

type BackupResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

interface BackupLifecycle {
  read(): BackupResult<BackupReadState>;
  exportActive(): BackupResult<BackupExport>;
  exportRecovery(): BackupResult<BackupExport>;
  prepareImport(
    bytes: Uint8Array,
    targetFingerprint: string,
    knownItemIds: ReadonlySet<string>,
  ): BackupResult<BackupPlan>;
  commitImport(plan: BackupPlan, confirmed: boolean): Promise<BackupResult<unknown>>;
  clear(confirmed: boolean): Promise<BackupResult<unknown>>;
  restore(
    confirmed: boolean,
    targetFingerprint: string,
    knownItemIds: ReadonlySet<string>,
  ): Promise<BackupResult<unknown>>;
}

interface BackupModule {
  readonly PrivateStateLifecycle: new (
    storage: unknown,
    options: { readonly appRevision: string; readonly reconciliation?: unknown },
  ) => BackupLifecycle;
}

interface BrowserStorageModule {
  readonly getBrowserStorage: () => BackupResult<unknown>;
}

const $ = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};

type Cleanup = () => void;
const resultCleanups = new WeakMap<HTMLElement, Set<Cleanup>>();

function text(tag: string, value?: unknown, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.textContent = String(value);
  return element;
}

function link(href: string, label: string, className?: string): HTMLAnchorElement {
  const element = text('a', label, className) as HTMLAnchorElement;
  element.href = href;
  return element;
}

function presentationLabel(values: readonly (string | null | undefined)[], fallback: string): string {
  const parts: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (trimmed) parts.push(trimmed);
  }
  return parts.join(' · ') || fallback;
}

function itemFinishCue(item: SnapshotItem): string | undefined {
  const finish = typeof item.finish === 'string' ? presentationLabel([item.finish], '') : '';
  const family = typeof item.finishFamily === 'string' ? presentationLabel([item.finishFamily], '') : '';
  if (finish && family && finish !== family) return `Finish: ${finish} · Finish family: ${family}`;
  if (finish) return `Finish: ${finish}`;
  if (family) return `Finish family: ${family}`;
  return undefined;
}

function itemCardLabel(item: SnapshotItem): string {
  const cardName = presentationLabel([item.cardName], 'Unnamed item');
  const localCardName = typeof item.localCardName === 'string' ? presentationLabel([item.localCardName], '') : '';
  return localCardName && localCardName !== cardName ? `${cardName} · ${localCardName}` : cardName;
}

function itemRowCollisionKey(item: SnapshotItem, includeEdition = true): string {
  const card = itemCardLabel(item);
  const set = presentationLabel([item.localSetCode, item.localSetName, item.collectorNumber], '');
  const visibleIdentity = [card, set, itemFinishCue(item)].filter(Boolean).join(' · ');
  return [item.localizationId, includeEdition ? (item.setEditionId ?? '') : '', visibleIdentity].join('\u0000');
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
  const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
  if (!button) return;
  const update = (): void => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    button.textContent = 'Dark theme';
    button.setAttribute('aria-pressed', String(theme === 'dark'));
  };
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('snoredex-theme', next);
    } catch {
      /* private state stays local */
    }
    update();
  });
  update();
}

function renderProvenance(container: HTMLElement, catalogue: CatalogueSnapshot): void {
  const dl = text('dl', undefined, 'provenance');
  const fields: [string, unknown][] = [
    ['Data as of', catalogue.meta.dataAsOf ?? 'Unknown'],
    ['Source', catalogue.meta.sourceRepository ?? 'Unknown'],
    ['Contract', catalogue.meta.schemaVersion],
    ['Catalogue fingerprint', catalogue.meta.catalogueFingerprint],
    ['Build input', provenance.mode],
    ['Producer revision', provenance.sourceCommit],
  ];
  if (provenance.mode === 'pinned-snapshot') {
    fields.push(['Catalogue byte digest', provenance.catalogueByteSha256]);
  }
  for (const [label, value] of fields) {
    dl.append(text('dt', label), text('dd', value));
  }
  container.replaceChildren(dl);
}

function sortedLocalizations(catalogue: CatalogueSnapshot): SnapshotLocalization[] {
  return [...catalogue.localizations].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
}

function renderLocalizationLinks(
  container: HTMLElement,
  catalogue: CatalogueSnapshot,
  hrefPrefix = 'collection/',
): void {
  const list = text('ul', undefined, 'link-list');
  for (const localization of sortedLocalizations(catalogue)) {
    const name = localizationLabel(localization);
    const suffix = localization.locality ? ` (${localization.locality})` : '';
    const li = text('li');
    li.append(
      link(`${hrefPrefix}${serializeQuery({ localization: localization.localizationId })}`, `${name}${suffix}`),
    );
    list.append(li);
  }
  container.replaceChildren(list);
}

function renderBrowseNavigation(container: HTMLElement, catalogue: CatalogueSnapshot): void {
  const details = text('details', undefined, 'browse-details') as HTMLDetailsElement;
  details.open = true;
  details.append(text('summary', 'Browse sets'));
  const tree = text('div', undefined, 'browse-tree');
  const localities = text('ul', undefined, 'link-list');
  const localizations = new Map(
    catalogue.localizations.map((localization) => [localization.localizationId, localization] as const),
  );
  const setsByLocality = new Map<string, SnapshotLocalSet[]>();
  for (const set of catalogue.localSets) {
    const rows = setsByLocality.get(set.locality) ?? [];
    rows.push(set);
    setsByLocality.set(set.locality, rows);
  }
  for (const [locality, localitySets] of [...setsByLocality.entries()].sort(([left], [right]) =>
    left.localeCompare(right, 'en'),
  )) {
    const localityItem = text('li', undefined, 'browse-locality');
    localityItem.append(text('strong', locality));
    const setList = text('ul', undefined, 'link-list browse-nested');
    const setLabelCounts = new Map<string, number>();
    for (const set of localitySets) {
      const setLabel = presentationLabel([set.localSetCode, set.localSetName], set.localSetId);
      setLabelCounts.set(setLabel, (setLabelCounts.get(setLabel) ?? 0) + 1);
    }
    for (const set of localitySets.sort(
      (left, right) =>
        String(left.sortKey ?? '').localeCompare(String(right.sortKey ?? ''), 'en', { numeric: true }) ||
        left.localSetId.localeCompare(right.localSetId),
    )) {
      const setItem = text('li', undefined, 'browse-set');
      const setLabel = presentationLabel([set.localSetCode, set.localSetName], set.localSetId);
      const displaySetLabel = (setLabelCounts.get(setLabel) ?? 0) > 1 ? `${setLabel} · ${set.localSetId}` : setLabel;
      setItem.append(text('span', displaySetLabel));
      const editionList = text('ul', undefined, 'browse-nested');
      const editions = catalogue.setEditions.filter((edition) => edition.localSetId === set.localSetId);
      const editionEntries = editions
        .sort(
          (left, right) =>
            String(left.sortKey ?? '').localeCompare(String(right.sortKey ?? ''), 'en', { numeric: true }) ||
            left.setEditionId.localeCompare(right.setEditionId),
        )
        .map((edition) => {
          const editionLabel = presentationLabel([edition.localSetCode, edition.localSetName], edition.setEditionId);
          const localization = localizations.get(edition.localizationId);
          const label = localization ? `${editionLabel} · ${localizationLabel(localization)}` : editionLabel;
          return { edition, label };
        });
      const labelCounts = new Map<string, number>();
      for (const { label } of editionEntries) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      for (const { edition, label } of editionEntries) {
        const editionItem = text('li', undefined, 'browse-edition');
        const projectionLabel = (labelCounts.get(label) ?? 0) > 1 ? `${label} · ${edition.setEditionId}` : label;
        editionItem.append(
          link(
            `./${serializeQuery({ localization: edition.localizationId, edition: edition.setEditionId })}`,
            projectionLabel,
          ),
        );
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
  renderProvenance($('[data-provenance]'), catalogue);
  renderLocalizationLinks($('[data-localizations]'), catalogue);
}

function renderQueryForm(container: HTMLElement, criteria: QueryCriteria, catalogue: CatalogueSnapshot): void {
  const form = text('form', undefined, 'query-form') as HTMLFormElement;
  form.method = 'get';
  form.action = './';
  const controls: HTMLSelectElement[] = [];
  const makeSelect = (
    labelText: string,
    name: string,
    options: readonly [string, string][],
    value?: string,
  ): HTMLLabelElement => {
    const label = text('label', labelText) as HTMLLabelElement;
    const select = document.createElement('select');
    select.name = name;
    for (const [optionValue, optionLabel] of options) {
      const option = text('option', optionLabel) as HTMLOptionElement;
      option.value = optionValue;
      option.selected = optionValue === (value ?? '');
      select.append(option);
    }
    controls.push(select);
    label.append(select);
    return label;
  };
  const localizationOptions: [string, string][] = [['', 'All localizations']];
  const localizationLabelCounts = new Map<string, number>();
  for (const row of catalogue.localizations) {
    const label = localizationLabel(row);
    const key = `${row.locality ?? ''}\u0000${label}`;
    localizationLabelCounts.set(key, (localizationLabelCounts.get(key) ?? 0) + 1);
  }
  for (const row of sortedLocalizations(catalogue)) {
    const label = localizationLabel(row);
    const key = `${row.locality ?? ''}\u0000${label}`;
    const displayLabel = (localizationLabelCounts.get(key) ?? 0) > 1 ? `${label} · ${row.localizationId}` : label;
    localizationOptions.push([row.localizationId, `${displayLabel}${row.locality ? ` (${row.locality})` : ''}`]);
  }
  const localization = makeSelect('Localization', 'localization', localizationOptions, criteria.localization);
  const localizationSelect = localization.querySelector('select');
  const editionId = criteria.edition;
  const selectedEdition =
    editionId === undefined ? undefined : catalogue.setEditions.find((edition) => edition.setEditionId === editionId);
  const editionInput = editionId === undefined ? undefined : document.createElement('input');
  if (editionInput !== undefined) {
    editionInput.type = 'hidden';
    editionInput.name = 'edition';
    editionInput.value = editionId ?? '';
  }
  let localizationChanged = false;
  const syncEditionScope = (): void => {
    if (editionInput === undefined || !(localizationSelect instanceof HTMLSelectElement)) return;
    const explicitScopeChange = localizationChanged;
    editionInput.disabled =
      selectedEdition?.localizationId !== undefined &&
      explicitScopeChange &&
      localizationSelect.value !== selectedEdition.localizationId;
  };
  localizationSelect?.addEventListener('change', () => {
    localizationChanged = true;
    syncEditionScope();
  });
  const query = text('label', 'Search public catalogue text') as HTMLLabelElement;
  const input = document.createElement('input');
  input.type = 'search';
  input.name = 'q';
  input.maxLength = 120;
  input.value = criteria.q ?? '';
  const syncSearchValidity = (): void => {
    const terms = input.value.trim().split(/\s+/u).filter(Boolean);
    input.setCustomValidity(terms.length > 12 ? 'Use at most 12 search terms.' : '');
  };
  input.addEventListener('input', syncSearchValidity);
  syncSearchValidity();
  query.append(input);
  const status = makeSelect(
    'Status',
    'status',
    [
      ['', 'All statuses'],
      ['need', 'Need'],
      ['ordered', 'Ordered'],
      ['have', 'Have'],
      ['skip', 'Skip'],
    ],
    criteria.status,
  );
  const kind = makeSelect(
    'Item class',
    'kind',
    [
      ['', 'All item classes'],
      ['verified-printing', 'Verified printing'],
      ['finish-candidate', 'Finish candidate'],
      ['research-placeholder', 'Research placeholder'],
    ],
    criteria.kind,
  );
  const research = makeSelect(
    'Research',
    'research',
    [
      ['', 'Current and research'],
      ['false', 'Current-known only'],
      ['true', 'Research only'],
    ],
    criteria.research,
  );
  const submit = text('button', 'Apply criteria') as HTMLButtonElement;
  submit.type = 'submit';
  form.addEventListener('submit', (event) => {
    syncSearchValidity();
    if (!input.checkValidity()) {
      event.preventDefault();
      return;
    }
    // Empty optional controls are omitted; explicit empty URL values remain invalid.
    for (const control of controls) control.disabled = control.value === '';
    input.disabled = input.value.trim() === '';
    syncEditionScope();
  });
  window.addEventListener('pageshow', () => {
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
    for (const element of document.querySelectorAll<HTMLElement>('[data-catalogue-dependent]')) element.hidden = true;
  }
  container.hidden = false;
  const section = text('section', undefined, 'state-panel');
  section.setAttribute('aria-live', 'polite');
  const stateMessage = failClosed
    ? 'The complete link could not be validated. No catalogue or private collection state was read.'
    : 'The complete link could not be validated. No private collection state was read.';
  section.append(text('h2', 'Invalid checklist link'), text('p', stateMessage));
  const actions = text('p');
  if (recoverableLocalization || window.location.search) {
    actions.append(
      link(
        recoverableLocalization ? `./${serializeQuery({ localization: recoverableLocalization })}` : './',
        'Clear invalid criteria',
      ),
    );
  }
  const homeHref = document.body.dataset.page === 'collection' ? '../' : './';
  if (actions.childElementCount > 0) actions.append(' · ');
  actions.append(link(homeHref, 'Home'));
  section.append(actions);
  container.replaceChildren(section);
}

function renderProgress(
  catalogue: CatalogueSnapshot,
  localizationId: string | undefined,
  editionId: string | undefined,
  state: PrivateStateRead,
): HTMLElement {
  const scope = catalogue.items.filter(
    (item) =>
      (!localizationId || item.localizationId === localizationId) && (!editionId || item.setEditionId === editionId),
  );
  const progress = buildProgressViewModel(scope, state.readable ? state.statuses : undefined);
  const section = text('section', undefined, 'progress-panel');
  section.tabIndex = -1;
  const heading = text('h2', 'Current-known progress');
  heading.id = 'progress-title';
  section.setAttribute('aria-labelledby', heading.id);
  section.append(heading);
  if (!state.readable) {
    section.append(
      text(
        'p',
        'Collection progress is temporarily unavailable because the local state could not be read. Public catalogue counts remain available.',
      ),
    );
    const bar = document.createElement('progress');
    bar.max = 1;
    bar.removeAttribute('value');
    bar.setAttribute('aria-label', 'Current-known progress unavailable');
    section.append(bar);
  } else {
    section.append(
      text(
        'p',
        `${progress.ownedTotal} of ${progress.currentKnownTotal} current-known items owned · ${progress.securedTotal} secured (Have or Ordered)`,
      ),
    );
    const bar = document.createElement('progress');
    if (progress.currentKnownTotal > 0) {
      bar.max = progress.currentKnownTotal;
      bar.value = progress.ownedTotal;
      bar.setAttribute(
        'aria-label',
        `Owned current-known items: ${progress.ownedTotal} of ${progress.currentKnownTotal}`,
      );
    } else {
      bar.setAttribute('aria-label', 'No current-known items to collect');
    }
    section.append(bar);
  }
  section.append(
    text(
      'p',
      `Research: ${progress.researchTotal} read-only item${progress.researchTotal === 1 ? '' : 's'}. Research is not part of the progress denominator.`,
    ),
  );
  return section;
}

function externalLink(href: unknown, label: string): HTMLAnchorElement | undefined {
  const safeHref = safeExternalUrl(href);
  if (!safeHref) return undefined;
  const anchor = link(safeHref, `${label} ↗`, 'external-link');
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.setAttribute('aria-label', `${label} (external site)`);
  return anchor;
}

function detailValue(value: unknown, fallback = 'Not recorded'): string {
  const normalized = presentText(value);
  if (normalized) return normalized;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function appendDetail(dl: HTMLElement, label: string, value: unknown, fallback = 'Not recorded'): void {
  dl.append(text('dt', label), text('dd', detailValue(value, fallback)));
}

function appendLinkDetails(dl: HTMLElement, label: string, values: unknown): void {
  const list = text('ul', undefined, 'item-detail-links');
  for (const [index, value] of linkValues(values).entries()) {
    const anchor = externalLink(value, `${label} ${index + 1}`);
    if (!anchor) continue;
    const li = text('li');
    li.append(anchor);
    list.append(li);
  }
  const dd = text('dd');
  dd.append(list.childElementCount > 0 ? list : text('span', 'No published links.'));
  dl.append(text('dt', label), dd);
}

function appendMarkingDetails(dl: HTMLElement, item: SnapshotItem): void {
  const markings = Array.isArray(item.markings) ? item.markings : [];
  const values = markings
    .map((marking) => {
      if (typeof marking !== 'object' || marking === null) return undefined;
      const row = marking as Record<string, unknown>;
      const kind = detailValue(row.kind, 'Unknown marking');
      const role = detailValue(row.role, 'Unknown role');
      const value = detailValue(row.text, 'Unspecified marking');
      return `${kind} · ${role}: ${value}`;
    })
    .filter((value): value is string => value !== undefined);
  appendDetail(dl, 'Markings', values.length > 0 ? values.join('; ') : undefined, 'None recorded');
}

function renderItemDetails(item: SnapshotItem, catalogue: CatalogueSnapshot, scopeLabel: string): HTMLDetailsElement {
  const details = text('details', undefined, 'item-details') as HTMLDetailsElement;
  details.append(text('summary', 'Details, evidence and sources'));
  const dl = text('dl', undefined, 'item-detail-list');
  const localization = catalogue.localizations.find((candidate) => candidate.localizationId === item.localizationId);
  appendDetail(dl, 'Item ID', item.itemId);
  appendDetail(dl, 'Set edition ID', item.setEditionId);
  appendDetail(dl, 'Local set ID', item.localSetId);
  appendDetail(dl, 'Card release ID', item.cardReleaseId);
  appendDetail(dl, 'Work ID', item.workId, 'No work mapping asserted');
  appendDetail(
    dl,
    'Physical printing ID',
    item.physicalPrintingId,
    'Not assigned; this row does not assert a verified printing',
  );
  appendDetail(dl, 'Source printing ID', item.sourcePrintingId, 'Not recorded');
  appendDetail(dl, 'Finish unit ID', item.finishUnitId, 'Not recorded');
  appendDetail(dl, 'Locality', localization?.locality ?? item.localizationId);
  appendDetail(dl, 'Language', localization?.languageTag ?? 'Not recorded');
  appendDetail(dl, 'Image scope', scopeLabel);
  appendDetail(dl, 'Item class', item.itemKind);
  appendDetail(dl, 'Producer evidence', item.finishVerificationStatus);
  appendDetail(dl, 'Completeness', item.completenessStatus);
  appendDetail(dl, 'Technical finish', item.finish, 'Not recorded');
  appendDetail(dl, 'Finish family', item.finishFamily, 'Not recorded');
  appendDetail(dl, 'Foil pattern', item.foilPattern, 'Not recorded');
  appendMarkingDetails(dl, item);
  const distribution = item.distribution;
  if (typeof distribution === 'object' && distribution !== null) {
    const row = distribution as Record<string, unknown>;
    appendDetail(
      dl,
      'Distribution',
      [row.kind, row.name, row.region, row.date, row.text]
        .map((value) => presentText(value))
        .filter((value): value is string => value !== undefined)
        .join(' · '),
      'Not recorded',
    );
  } else {
    appendDetail(dl, 'Distribution', undefined);
  }
  const releaseDate = detailValue(item.releaseDate, 'Not recorded');
  const precision = presentText(item.releaseDatePrecision);
  appendDetail(
    dl,
    'Release date',
    precision ? `${releaseDate} (${precision}${item.releaseApproximate === true ? ', approximate' : ''})` : releaseDate,
  );
  appendLinkDetails(dl, 'Source', item.sourceLinks);
  appendLinkDetails(dl, 'Evidence', item.evidenceLinks);
  const correction = externalLink(item.correctionLink, 'Submit evidence or correction');
  const correctionDd = text('dd');
  correctionDd.append(correction ?? text('span', 'Correction link unavailable.'));
  dl.append(text('dt', 'Producer correction'), correctionDd);
  details.append(dl);
  return details;
}

let imageDialogSequence = 0;

function renderItemImage(item: SnapshotItem, catalogue: CatalogueSnapshot): HTMLElement {
  const asset = resolveImageAsset(catalogue, item);
  const scopeLabel = imageScopeLabel(item, asset.placeholder);
  const alt = `${asset.placeholder ? 'Authored placeholder' : 'Catalogue image'} for ${itemCardLabel(item)} · ${scopeLabel}; no real card image is implied.`;
  const figure = text('figure', undefined, 'item-image');
  const image = document.createElement('img');
  image.src = imageAssetUrl(asset);
  image.alt = alt;
  image.loading = 'lazy';
  image.decoding = 'async';
  if (item.progressClass === 'research') {
    figure.classList.add('item-image-placeholder');
    figure.append(image, text('figcaption', scopeLabel));
    return figure;
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'image-button';
  button.setAttribute('aria-label', `Inspect image for ${itemCardLabel(item)} (${scopeLabel})`);
  button.append(image);
  const dialog = document.createElement('dialog');
  dialog.className = 'image-dialog';
  const dialogId = `item-image-dialog-${++imageDialogSequence}`;
  dialog.id = dialogId;
  const heading = text('h3', `Image preview · ${itemCardLabel(item)}`);
  heading.id = `${dialogId}-title`;
  dialog.setAttribute('aria-labelledby', heading.id);
  const largeImage = document.createElement('img');
  largeImage.src = image.src;
  largeImage.alt = alt;
  const close = text('button', 'Close image') as HTMLButtonElement;
  close.type = 'button';
  close.className = 'dialog-close';
  const closeDialog = (): void => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    button.focus();
  };
  close.addEventListener('click', closeDialog);
  dialog.addEventListener('close', () => button.focus());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog.append(heading, largeImage, text('p', scopeLabel), close);
  button.setAttribute('aria-controls', dialogId);
  button.addEventListener('click', () => {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    close.focus();
  });
  figure.append(button, text('figcaption', scopeLabel), dialog);
  return figure;
}

const STATUS_OPTIONS = [
  ['need', 'Need'],
  ['ordered', 'Ordered'],
  ['have', 'Have'],
  ['skip', 'Skip'],
] as const;
const MAX_NOTE_CODE_POINTS = 2_000;

function renderCollectionControls(
  item: SnapshotItem,
  controller: CollectionStateController,
  registerCleanup?: (cleanup: Cleanup) => void,
): HTMLElement {
  const record = controller.record(item.itemId);
  const wrapper = text('div', undefined, 'collection-controls');
  const feedback = text('span', undefined, 'state-feedback');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  const retry = text('button', 'Retry save', 'state-retry') as HTMLButtonElement;
  retry.type = 'button';
  retry.hidden = true;
  let retryAction: (() => Promise<CollectionEditResult>) | undefined;
  const showResult = (result: CollectionEditResult): void => {
    if (result.deferred) return;
    retry.textContent = 'Retry save';
    if (result.ok && !result.skipped) {
      feedback.textContent = 'Saved';
      retry.hidden = true;
    } else if (result.ok) {
      feedback.textContent = 'Saving…';
      retry.hidden = true;
    } else if (result.error === 'STORAGE_COMMIT_UNCERTAIN') {
      feedback.textContent = 'Save conflict detected. Reload to reconcile your collection.';
      retry.textContent = 'Reload to recover';
      retryAction = () => {
        globalThis.location?.reload();
        return Promise.resolve({ ok: true, skipped: true });
      };
      retry.hidden = false;
    } else {
      feedback.textContent = 'Save failed. Your draft is still visible; retry when ready.';
      retry.hidden = false;
    }
  };
  const runSave = (action: () => Promise<CollectionEditResult>): void => {
    retryAction = action;
    retry.hidden = true;
    feedback.textContent = 'Saving…';
    void action().then(showResult);
  };
  retry.addEventListener('click', () => {
    if (retryAction !== undefined) runSave(retryAction);
  });
  const stopSaveListener = controller.onSave((itemId, result) => {
    if (itemId === item.itemId) showResult(result);
  });
  registerCleanup?.(stopSaveListener);

  const fieldset = text('fieldset', undefined, 'status-controls') as HTMLFieldSetElement;
  fieldset.append(text('legend', 'Collection status'));
  const statusName = `status-${item.itemId}`;
  const statusInputs = new Map<string, HTMLInputElement>();
  for (const [value, label] of STATUS_OPTIONS) {
    const labelElement = text('label', undefined, 'status-option');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = statusName;
    input.value = value;
    input.checked = (record?.status ?? 'need') === value;
    statusInputs.set(value, input);
    input.addEventListener('change', () => {
      runSave(() => controller.setStatus(item.itemId, value));
    });
    labelElement.append(input, text('span', label));
    fieldset.append(labelElement);
  }

  const quantity = text('div', undefined, 'quantity-controls');
  const quantityHeading = text('span', 'Quantities', 'control-heading');
  const ownedLabel = text('label', 'Owned');
  const owned = document.createElement('input');
  owned.type = 'number';
  owned.min = '0';
  owned.max = '9999';
  owned.step = '1';
  owned.value = String(record?.quantityOwned ?? 0);
  owned.setAttribute('inputmode', 'numeric');
  ownedLabel.append(owned);
  const orderedLabel = text('label', 'Ordered');
  const ordered = document.createElement('input');
  ordered.type = 'number';
  ordered.min = '0';
  ordered.max = '9999';
  ordered.step = '1';
  ordered.value = String(record?.quantityOrdered ?? 0);
  ordered.setAttribute('inputmode', 'numeric');
  orderedLabel.append(ordered);
  const stopChangeListener = controller.onChange(() => {
    const latest = controller.record(item.itemId);
    const latestStatus = latest?.status ?? 'need';
    for (const [value, input] of statusInputs) input.checked = value === latestStatus;
    if (document.activeElement !== owned) owned.value = String(latest?.quantityOwned ?? 0);
    if (document.activeElement !== ordered) ordered.value = String(latest?.quantityOrdered ?? 0);
  });
  registerCleanup?.(stopChangeListener);
  const saveQuantities = (): void => {
    runSave(() => controller.setQuantities(item.itemId, Number(owned.value), Number(ordered.value)));
  };
  owned.addEventListener('change', saveQuantities);
  ordered.addEventListener('change', saveQuantities);
  quantity.append(quantityHeading, ownedLabel, orderedLabel);

  const note = text('div', undefined, 'note-control');
  const noteButton = text('button', 'Add note') as HTMLButtonElement;
  noteButton.type = 'button';
  noteButton.hidden = record?.note !== undefined;
  const textarea = document.createElement('textarea');
  textarea.rows = 3;
  textarea.placeholder = 'Private note';
  textarea.value = record?.note ?? '';
  textarea.hidden = record?.note === undefined;
  textarea.setAttribute('aria-label', `Private note for ${itemCardLabel(item)}`);
  const openNote = (): void => {
    textarea.hidden = false;
    noteButton.hidden = true;
    textarea.focus();
  };
  noteButton.addEventListener('click', openNote);
  textarea.addEventListener('input', () => {
    const codePoints = [...textarea.value];
    if (codePoints.length > MAX_NOTE_CODE_POINTS) textarea.value = codePoints.slice(0, MAX_NOTE_CODE_POINTS).join('');
    retryAction = () => controller.flushNote();
    retry.hidden = true;
    const scheduled = controller.scheduleNote(item.itemId, textarea.value);
    if (!scheduled.ok) showResult(scheduled);
    else feedback.textContent = 'Saving…';
  });
  textarea.addEventListener('focusout', () => {
    void controller.flushNote();
  });
  note.append(noteButton, textarea);
  wrapper.append(fieldset, quantity, note, feedback, retry);
  return wrapper;
}

function statusKey(state: PrivateStateRead): string {
  return [...state.statuses.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([itemId, status]) => `${itemId}:${status}`)
    .join('|');
}

function renderRecoveryPanel(
  controller: CollectionStateController,
  onResolved?: (announcement: string) => void,
  registerCleanup?: (cleanup: Cleanup) => void,
): HTMLElement | undefined {
  const recovery = controller.recovery;
  if (recovery === undefined) return undefined;
  const adoptable = recovery.adoptable;
  const panel = text('section', undefined, 'state-panel recovery-panel');
  const feedback = text('p', undefined, 'state-feedback');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  const actions = text('div', undefined, 'recovery-actions');
  const adopt = text('button', 'Adopt recovered changes') as HTMLButtonElement;
  adopt.type = 'button';
  adopt.disabled = !adoptable;
  const discard = text('button', 'Discard recovered changes') as HTMLButtonElement;
  discard.type = 'button';
  const reload = text('button', 'Reload to reconcile') as HTMLButtonElement;
  reload.type = 'button';
  reload.hidden = true;
  reload.addEventListener('click', () => {
    globalThis.location?.reload();
  });
  let completionAnnouncement = 'Collection recovery updated.';
  const run = (action: () => Promise<CollectionEditResult>): void => {
    adopt.disabled = true;
    discard.disabled = true;
    reload.hidden = true;
    feedback.textContent = 'Saving…';
    void action().then((result) => {
      if (result.ok) {
        feedback.textContent = 'Recovered changes saved.';
        onResolved?.(completionAnnouncement);
      } else {
        if (result.error === 'STORAGE_COMMIT_UNCERTAIN') {
          feedback.textContent = 'Recovery conflict detected. Reload to reconcile your collection.';
          reload.hidden = false;
        } else {
          feedback.textContent = 'Recovery action failed. The recovered draft is still available; retry when ready.';
        }
        adopt.disabled = !adoptable;
        discard.disabled = false;
      }
    });
  };
  adopt.addEventListener('click', () => {
    completionAnnouncement = 'Recovered changes saved.';
    run(() => controller.adoptRecovery());
  });
  discard.addEventListener('click', () => {
    completionAnnouncement = 'Recovered changes discarded.';
    run(async () => controller.discardRecovery());
  });
  actions.append(adopt, discard, reload);
  panel.append(
    text('h2', 'Recovered unsaved collection changes'),
    text(
      'p',
      adoptable
        ? `A private draft from an interrupted save is available (${recovery.itemIds.length} item${recovery.itemIds.length === 1 ? '' : 's'}${recovery.noteItemIds.length > 0 ? `, including ${recovery.noteItemIds.length} note${recovery.noteItemIds.length === 1 ? '' : 's'}` : ''}). Choose whether to adopt or discard it before editing.`
        : `A private draft from an interrupted save contains records the current catalogue cannot represent yet. Adoption is disabled to prevent data loss; discard it or wait for a producer-reviewed reconciliation.`,
    ),
    actions,
    feedback,
  );
  let stop: (() => void) | undefined;
  stop = controller.onChange(() => {
    if (controller.recovery === undefined) {
      stop?.();
      panel.remove();
    }
  });
  registerCleanup?.(() => stop?.());
  return panel;
}

function announceRecoveryResult(container: HTMLElement, announcement: string): void {
  const status = text('p', announcement, 'recovery-announcement');
  status.setAttribute('role', 'status');
  container.prepend(status);
  const target = container.querySelector<HTMLElement>('.progress-panel, h2') ?? container;
  target.tabIndex = -1;
  target.focus();
}

const RECOVERY_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  EXPORT_FAILED: 'No readable collection data is available to export.',
  IMPORT_FILE_TOO_LARGE: 'The selected file is larger than the 16 MiB safety limit.',
  IMPORT_FILE_READ_FAILED: 'The selected file could not be read.',
  IMPORT_INVALID_ENCODING: 'The selected file is not valid UTF-8 JSON.',
  IMPORT_INVALID_JSON: 'The selected file is not valid JSON.',
  IMPORT_UNSUPPORTED_STATE_SCHEMA: 'This backup uses an unsupported state format.',
  IMPORT_UNSUPPORTED_STATE_VERSION: 'This backup uses an unsupported state version.',
  IMPORT_UNKNOWN_FIELD: 'This backup contains unsupported fields.',
  IMPORT_INVALID_STATE_DATA: 'The backup contains invalid collection data.',
  IMPORT_DUPLICATE_ITEM_ID: 'The backup contains duplicate collection records.',
  STATE_FINGERPRINT_UNSUPPORTED: 'This backup cannot be reconciled with the current catalogue.',
  STATE_RECONCILIATION_BLOCKED: 'Reconciliation is blocked; your current collection was not changed.',
  STATE_PORTABLE_LIMIT_EXCEEDED: 'The backup exceeds the safety limit.',
  STATE_CHANGED_DURING_OPERATION: 'The collection changed while this operation was prepared. Please retry.',
  STORAGE_UNAVAILABLE: 'Browser storage is unavailable; the current collection was not changed.',
  STORAGE_QUOTA_EXCEEDED: 'Browser storage is full; the current collection was not changed.',
  STORAGE_WRITE_FAILED: 'The collection could not be saved; the current collection was not changed.',
  STORAGE_COMMIT_UNCERTAIN: 'The save result is uncertain. Reload to recover the last readable state.',
  LOCAL_STATE_UNSUPPORTED: 'The saved collection format is unsupported.',
  LOCAL_STATE_UNREADABLE: 'The saved collection could not be read. Import a valid backup to recover it.',
};

const MAX_RECOVERY_FILE_BYTES = 16 * 1024 * 1024;

function recoveryErrorMessage(error: string): string {
  return RECOVERY_ERROR_MESSAGES[error] ?? 'The collection operation failed; the current state was not changed.';
}

function appendRecoveryField(list: HTMLElement, label: string, value: unknown): void {
  list.append(text('dt', label), text('dd', value));
}

function confirmationDialog(title: string, message: string): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false);
  const dialog = document.createElement('dialog');
  dialog.className = 'recovery-confirmation';
  const heading = text('h3', title);
  heading.id = 'recovery-confirmation-title';
  dialog.setAttribute('aria-labelledby', heading.id);
  const body = text('p', message);
  const actions = text('div', undefined, 'recovery-preview-actions');
  const cancel = text('button', 'Cancel') as HTMLButtonElement;
  cancel.type = 'button';
  const confirm = text('button', 'Confirm') as HTMLButtonElement;
  confirm.type = 'button';
  actions.append(cancel, confirm);
  dialog.append(heading, body, actions);
  document.body.append(dialog);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', () => finish(false));
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    confirm.focus();
  });
}

function downloadBackup(backup: BackupExport): boolean {
  if (typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') return false;
  const bytes = backup.bytes.buffer.slice(
    backup.bytes.byteOffset,
    backup.bytes.byteOffset + backup.bytes.byteLength,
  ) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = backup.filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function renderImportPreview(
  container: HTMLElement,
  plan: BackupPlan,
  onConfirm: () => void,
  onCancel: () => void,
): void {
  const preview = text('div', undefined, 'recovery-preview');
  const heading = text('h3', plan.preview.mode === 'replace' ? 'Replace preview' : 'Import preview');
  const details = text('dl');
  appendRecoveryField(details, 'Schema version', plan.preview.schemaVersion);
  appendRecoveryField(details, 'Source fingerprint', plan.preview.sourceFingerprint);
  appendRecoveryField(details, 'Target fingerprint', plan.preview.targetFingerprint);
  appendRecoveryField(details, 'Records in backup', plan.preview.explicitRecordCount);
  appendRecoveryField(details, 'Records replaced', plan.preview.recordsToReplace);
  appendRecoveryField(
    details,
    'Need / Ordered / Have / Skip',
    `${plan.preview.statusCounts.need} / ${plan.preview.statusCounts.ordered} / ${plan.preview.statusCounts.have} / ${plan.preview.statusCounts.skip}`,
  );
  appendRecoveryField(
    details,
    'Owned / Ordered quantity',
    `${plan.preview.quantityOwned} / ${plan.preview.quantityOrdered}`,
  );
  appendRecoveryField(details, 'Records with notes', plan.preview.noteCount);
  const reconciliation = plan.preview.reconciliation;
  if (reconciliation !== undefined) {
    appendRecoveryField(
      details,
      'Reconciliation',
      reconciliation.conservationSatisfied ? 'Conservation satisfied' : 'Blocked',
    );
    appendRecoveryField(details, 'Retained / migrated', `${reconciliation.retained} / ${reconciliation.migrated}`);
    appendRecoveryField(
      details,
      'New current-known / research',
      `${reconciliation.newCurrentKnown} / ${reconciliation.newResearch}`,
    );
    appendRecoveryField(
      details,
      'Retired orphans / conflicts',
      `${reconciliation.retiredOrphans} / ${reconciliation.conflicts}`,
    );
    appendRecoveryField(details, 'Unresolved', reconciliation.unresolved);
  }
  const warning = text(
    'p',
    'This is a non-mutating preview. Applying it replaces the current collection after an explicit confirmation and creates a recovery backup first.',
  );
  const actions = text('div', undefined, 'recovery-preview-actions');
  const apply = text(
    'button',
    plan.preview.mode === 'replace' ? 'Replace collection' : 'Import collection',
  ) as HTMLButtonElement;
  apply.type = 'button';
  const cancel = text('button', 'Cancel preview') as HTMLButtonElement;
  cancel.type = 'button';
  apply.addEventListener('click', onConfirm);
  cancel.addEventListener('click', onCancel);
  actions.append(apply, cancel);
  preview.append(heading, warning, details, actions);
  container.replaceChildren(preview);
  container.hidden = false;
}

async function createBackupLifecycle(
  reconciliation: CollectionReconciliationOptions,
): Promise<BackupLifecycle | undefined> {
  try {
    const [storageModule, backupModule] = await Promise.all([
      // @ts-expect-error The runtime-relative module is emitted by the separate state build.
      import('./state/storage.js') as Promise<BrowserStorageModule>,
      // @ts-expect-error The runtime-relative module is emitted by the separate state build.
      import('./state/backup.js') as Promise<BackupModule>,
    ]);
    const storage = storageModule.getBrowserStorage();
    if (!storage.ok) return undefined;
    return new backupModule.PrivateStateLifecycle(storage.value, {
      appRevision: provenance.appRevision ?? provenance.sourceCommit,
      reconciliation,
    });
  } catch {
    return undefined;
  }
}

function renderRecoveryTools(
  container: HTMLElement,
  lifecycle: BackupLifecycle | undefined,
  targetFingerprint: string,
  knownItemIds: ReadonlySet<string>,
): void {
  const actionsContainer = container.querySelector<HTMLElement>('[data-recovery-actions]');
  const previewContainer = container.querySelector<HTMLElement>('[data-recovery-preview]');
  const status = container.querySelector<HTMLElement>('[data-recovery-status]');
  if (!actionsContainer || !previewContainer || !status) return;
  actionsContainer.replaceChildren();
  previewContainer.replaceChildren();
  previewContainer.hidden = true;
  const setStatus = (value: string): void => {
    status.textContent = value;
  };
  if (lifecycle === undefined) {
    const unavailable = text('p', 'Recovery controls are unavailable because browser storage could not be opened.');
    actionsContainer.append(unavailable);
    setStatus('');
    return;
  }
  const exportButton = text('button', 'Export collection') as HTMLButtonElement;
  const exportRecoveryButton = text('button', 'Export recovery snapshot') as HTMLButtonElement;
  const importButton = text('button', 'Choose backup to preview') as HTMLButtonElement;
  const clearButton = text('button', 'Clear collection') as HTMLButtonElement;
  const restoreButton = text('button', 'Restore previous snapshot') as HTMLButtonElement;
  for (const button of [exportButton, exportRecoveryButton, importButton, clearButton, restoreButton])
    button.type = 'button';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = ['.snoredex-', 'private.json'].join('') + ',application/json';
  fileInput.hidden = true;
  importButton.addEventListener('click', () => fileInput.click());
  let plan: BackupPlan | undefined;
  let selectionGeneration = 0;
  const clearPreview = (): void => {
    plan = undefined;
    previewContainer.replaceChildren();
    previewContainer.hidden = true;
  };
  const refresh = (): void => {
    const current = lifecycle.read();
    if (!current.ok) {
      for (const button of [exportButton, exportRecoveryButton, clearButton, restoreButton]) button.disabled = true;
      setStatus(recoveryErrorMessage(current.error));
      return;
    }
    const activeCount = current.value.active?.items.length ?? 0;
    exportButton.disabled = activeCount === 0;
    clearButton.disabled = activeCount === 0;
    exportRecoveryButton.disabled = current.value.recovery === undefined;
    restoreButton.disabled = current.value.recovery === undefined;
  };
  exportButton.addEventListener('click', () => {
    const result = lifecycle.exportActive();
    if (!result.ok) return setStatus(recoveryErrorMessage(result.error));
    setStatus(
      downloadBackup(result.value)
        ? 'Private collection backup downloaded.'
        : 'Backup download is unavailable in this browser.',
    );
  });
  exportRecoveryButton.addEventListener('click', () => {
    const result = lifecycle.exportRecovery();
    if (!result.ok) return setStatus(recoveryErrorMessage(result.error));
    setStatus(
      downloadBackup(result.value)
        ? 'Recovery snapshot downloaded.'
        : 'Backup download is unavailable in this browser.',
    );
  });
  clearButton.addEventListener('click', () => {
    void confirmationDialog(
      'Clear collection?',
      'A private backup is retained in the recovery slot before the active collection is cleared.',
    ).then((confirmed) => {
      if (!confirmed) return;
      setStatus('Clearing collection…');
      void lifecycle.clear(true).then((result) => {
        if (!result.ok) return setStatus(recoveryErrorMessage(result.error));
        setStatus('Collection cleared. Reloading…');
        globalThis.location?.reload();
      });
    });
  });
  restoreButton.addEventListener('click', () => {
    void confirmationDialog(
      'Restore previous snapshot?',
      'The current collection will be retained as the recovery snapshot before restore.',
    ).then((confirmed) => {
      if (!confirmed) return;
      setStatus('Restoring collection…');
      void lifecycle.restore(true, targetFingerprint, knownItemIds).then((result) => {
        if (!result.ok) return setStatus(recoveryErrorMessage(result.error));
        setStatus('Previous snapshot restored. Reloading…');
        globalThis.location?.reload();
      });
    });
  });
  fileInput.addEventListener('change', () => {
    const generation = ++selectionGeneration;
    const file = fileInput.files?.[0];
    fileInput.value = '';
    clearPreview();
    if (!file) return;
    setStatus('Validating backup…');
    if (file.size > MAX_RECOVERY_FILE_BYTES) {
      setStatus(recoveryErrorMessage('IMPORT_FILE_TOO_LARGE'));
      return;
    }
    void file
      .arrayBuffer()
      .then((buffer) => {
        if (generation !== selectionGeneration) return;
        const result = lifecycle.prepareImport(new Uint8Array(buffer), targetFingerprint, knownItemIds);
        if (!result.ok) {
          clearPreview();
          setStatus(recoveryErrorMessage(result.error));
          return;
        }
        plan = result.value;
        renderImportPreview(
          previewContainer,
          plan,
          () => {
            if (plan === undefined) return;
            void confirmationDialog(
              plan.preview.mode === 'replace' ? 'Replace collection?' : 'Import collection?',
              'The preview is valid. Confirm to create a recovery backup and atomically apply this collection.',
            ).then((confirmed) => {
              if (!confirmed || plan === undefined) return;
              setStatus('Applying collection…');
              void lifecycle.commitImport(plan, true).then((commit) => {
                if (!commit.ok) {
                  setStatus(recoveryErrorMessage(commit.error));
                  return;
                }
                setStatus('Collection imported. Reloading…');
                globalThis.location?.reload();
              });
            });
          },
          () => {
            clearPreview();
            setStatus('Import preview cancelled.');
          },
        );
        setStatus('Review the backup preview before applying it.');
      })
      .catch(() => {
        if (generation !== selectionGeneration) return;
        clearPreview();
        setStatus(recoveryErrorMessage('IMPORT_FILE_READ_FAILED'));
      });
  });
  actionsContainer.append(exportButton, exportRecoveryButton, importButton, clearButton, restoreButton, fileInput);
  refresh();
}

function renderItemRow(
  item: SnapshotItem,
  catalogue: CatalogueSnapshot,
  inactive = false,
  ownerLabel?: string,
  setIdentity?: string,
  stateController?: CollectionStateController,
  registerCleanup?: (cleanup: Cleanup) => void,
): HTMLLIElement {
  const row = text('li', undefined, 'item-row') as HTMLLIElement;
  row.dataset.itemId = item.itemId;
  if (item.progressClass === 'research') row.classList.add('item-row-research');
  const asset = resolveImageAsset(catalogue, item);
  const scopeLabel = imageScopeLabel(item, asset.placeholder);
  row.append(renderItemImage(item, catalogue));
  const content = text('div', undefined, 'item-content');
  const identity = text('div', undefined, 'item-identity');
  identity.append(text('strong', presentText(item.cardName) ?? 'Unnamed item'));
  const localCardName = presentText(item.localCardName);
  if (localCardName || item.progressClass === 'research') {
    identity.append(
      text('span', localCardName ?? 'Local name not recorded', localCardName ? 'item-local-name' : 'item-muted'),
    );
  }
  const set = presentationLabel([item.localSetCode, item.localSetName], '');
  const setDisplay = [set, setIdentity].filter(Boolean).join(' · ');
  if (setDisplay) identity.append(text('span', ` · ${setDisplay}`));
  if (ownerLabel) identity.append(text('span', ` · ${ownerLabel}`));
  content.append(identity);
  const metadata = text('div', undefined, 'item-meta');
  const localization = catalogue.localizations.find((candidate) => candidate.localizationId === item.localizationId);
  const locale = localization
    ? `${localizationLabel(localization)}${localization.locality ? ` (${localization.locality})` : ''}`
    : item.localizationId;
  metadata.textContent = [
    collectorNumberLabel(item) ?? 'Collector number not recorded',
    locale,
    itemFinishCue(item) ?? 'Physical variation not recorded',
  ].join(' · ');
  content.append(metadata);
  const tags = text('div', undefined, 'item-tags');
  tags.append(text('span', itemCueLabel(item), 'item-cue'), text('span', scopeLabel, 'item-scope'));
  const evidence = evidenceCueLabel(item);
  if (evidence) tags.append(text('span', evidence, 'item-cue'));
  if (inactive) tags.append(text('span', 'Inactive', 'item-cue'));
  content.append(tags);
  if (
    !inactive &&
    item.active &&
    item.progressClass === 'current-known' &&
    stateController !== undefined &&
    stateController.recovery === undefined
  ) {
    content.append(renderCollectionControls(item, stateController, registerCleanup));
  }
  content.append(renderItemDetails(item, catalogue, scopeLabel));
  row.append(content);
  return row;
}

function renderResults(
  container: HTMLElement,
  criteria: QueryCriteria,
  catalogue: CatalogueSnapshot,
  state: PrivateStateRead,
  stateController?: CollectionStateController,
): void {
  resultCleanups.get(container)?.forEach((cleanup) => cleanup());
  const cleanups = new Set<Cleanup>();
  resultCleanups.set(container, cleanups);
  const registerCleanup = (cleanup: Cleanup): void => {
    cleanups.add(cleanup);
  };
  const recoveryPanel =
    stateController === undefined
      ? undefined
      : renderRecoveryPanel(
          stateController,
          (announcement) => {
            renderResults(container, criteria, catalogue, stateController.state, stateController);
            announceRecoveryResult(container, announcement);
          },
          registerCleanup,
        );
  if (criteria.status && !state.readable) {
    const deferred = text('section', undefined, 'state-panel');
    deferred.setAttribute('aria-live', 'polite');
    deferred.append(
      text('h2', 'Status filter unavailable'),
      text(
        'p',
        'The local collection state could not be read, so this status filter was not applied. Reload the page or restore a valid local collection and try again.',
      ),
    );
    container.replaceChildren(...(recoveryPanel === undefined ? [deferred] : [recoveryPanel, deferred]));
    return;
  }
  const hasFilter = Boolean(criteria.edition || criteria.q || criteria.kind || criteria.research || criteria.status);
  if (!criteria.localization && !hasFilter) {
    const summary = text('div', undefined, 'state-panel');
    summary.append(
      text('h2', 'Choose a localization or search'),
      text(
        'p',
        'Browse one localization or search the public catalogue across set groups. The owning localization and set remain labelled on every result.',
      ),
    );
    container.replaceChildren(...(recoveryPanel === undefined ? [summary] : [recoveryPanel, summary]));
    return;
  }
  const progress = renderProgress(catalogue, criteria.localization, criteria.edition, state);
  let previousProgressStatusKey = stateController === undefined ? '' : statusKey(stateController.state);
  const stopProgressListener = stateController?.onChange(() => {
    const nextStatusKey = statusKey(stateController.state);
    if (nextStatusKey === previousProgressStatusKey) return;
    previousProgressStatusKey = nextStatusKey;
    const updated = renderProgress(catalogue, criteria.localization, criteria.edition, stateController.state);
    progress.replaceChildren(...updated.childNodes);
  });
  if (stopProgressListener !== undefined) registerCleanup(stopProgressListener);
  if (criteria.status && stateController !== undefined) {
    let previousStatusKey = statusKey(stateController.state);
    let stopStatusListener: (() => void) | undefined;
    stopStatusListener = stateController.onSave((_itemId, result) => {
      if (!result.ok || result.skipped) return;
      const nextStatusKey = statusKey(stateController.state);
      if (nextStatusKey === previousStatusKey) return;
      previousStatusKey = nextStatusKey;
      stopStatusListener?.();
      renderResults(container, criteria, catalogue, stateController.state, stateController);
    });
    registerCleanup(() => stopStatusListener?.());
  }
  const model = buildResultViewModel(criteria, catalogue, matchesResearch, state.readable ? state.statuses : undefined);
  const { activeItems: items, inactiveItems } = model;
  const content: Node[] = [];
  if (recoveryPanel !== undefined) content.push(recoveryPanel);
  content.push(progress, text('p', model.activeSummary));
  const groups = buildBrowseHierarchy(
    criteria,
    catalogue,
    matchesResearch,
    state.readable ? state.statuses : undefined,
  );
  const grouped = text('div', undefined, 'browse-results');
  const localizationLabelCounts = new Map<string, number>();
  for (const candidate of catalogue.localizations) {
    const label = localizationLabel(candidate);
    const key = `${candidate.locality ?? ''}\u0000${label}`;
    localizationLabelCounts.set(key, (localizationLabelCounts.get(key) ?? 0) + 1);
  }
  for (const localization of groups) {
    const localizationSection = text('section', undefined, 'result-localization');
    const localizationLabelValue = localizationLabel(localization.localization);
    const localizationKey = `${localization.localization.locality ?? ''}\u0000${localizationLabelValue}`;
    const displayLocalizationLabel =
      (localizationLabelCounts.get(localizationKey) ?? 0) > 1
        ? `${localizationLabelValue} · ${localization.localization.localizationId}`
        : localizationLabelValue;
    localizationSection.append(
      text(
        'h2',
        `${displayLocalizationLabel}${localization.localization.locality ? ` (${localization.localization.locality})` : ''}`,
      ),
    );
    const setLabelCounts = new Map<string, number>();
    for (const candidate of catalogue.localSets) {
      if (localization.localization.locality !== undefined && candidate.locality !== localization.localization.locality)
        continue;
      const setLabel = presentationLabel([candidate.localSetCode, candidate.localSetName], candidate.localSetId);
      setLabelCounts.set(setLabel, (setLabelCounts.get(setLabel) ?? 0) + 1);
    }
    for (const set of localization.sets) {
      const setSection = text('section', undefined, 'result-set');
      const setLabel = presentationLabel([set.set.localSetCode, set.set.localSetName], set.set.localSetId);
      const displaySetLabel =
        (setLabelCounts.get(setLabel) ?? 0) > 1 ? `${setLabel} · ${set.set.localSetId}` : setLabel;
      setSection.append(text('h3', displaySetLabel));
      const siblingEditionLabelCounts = new Map<string, number>();
      for (const sibling of catalogue.setEditions) {
        if (
          sibling.localSetId !== set.set.localSetId ||
          sibling.localizationId !== localization.localization.localizationId
        )
          continue;
        const siblingLabel = presentationLabel([sibling.localSetCode, sibling.localSetName], sibling.setEditionId);
        siblingEditionLabelCounts.set(siblingLabel, (siblingEditionLabelCounts.get(siblingLabel) ?? 0) + 1);
      }
      for (const edition of set.editions) {
        const editionSection = text('section', undefined, 'result-edition');
        const editionLabel = presentationLabel(
          [edition.edition.localSetCode, edition.edition.localSetName],
          edition.edition.setEditionId,
        );
        const headingLabel =
          (siblingEditionLabelCounts.get(editionLabel) ?? 0) > 1
            ? `${editionLabel} · ${edition.edition.setEditionId}`
            : editionLabel;
        editionSection.append(text('h4', headingLabel));
        const list = text('ul', undefined, 'item-list');
        const currentItems = edition.items.filter(
          (candidate) => candidate.active && candidate.progressClass !== 'research',
        );
        const currentCollisionCounts = itemRowCollisionCounts(
          catalogue.items.filter(
            (candidate) =>
              candidate.setEditionId === edition.edition.setEditionId &&
              candidate.active &&
              candidate.progressClass !== 'research',
          ),
        );
        for (const item of currentItems) {
          const itemIdentity =
            (currentCollisionCounts.get(itemRowCollisionKey(item)) ?? 0) > 1 ? item.itemId : undefined;
          list.append(renderItemRow(item, catalogue, false, undefined, itemIdentity, stateController, registerCleanup));
        }
        if (list.childElementCount > 0) editionSection.append(list);
        const research = edition.items.filter((item) => item.active && item.progressClass === 'research');
        if (research.length > 0) {
          const researchSection = text('section', undefined, 'research-section');
          researchSection.append(text('h5', 'Research (read-only)'));
          const researchList = text('ul', undefined, 'item-list');
          const researchCollisionCounts = itemRowCollisionCounts(
            catalogue.items.filter(
              (candidate) =>
                candidate.setEditionId === edition.edition.setEditionId &&
                candidate.active &&
                candidate.progressClass === 'research',
            ),
          );
          for (const item of research) {
            const itemIdentity =
              (researchCollisionCounts.get(itemRowCollisionKey(item)) ?? 0) > 1 ? item.itemId : undefined;
            researchList.append(
              renderItemRow(item, catalogue, false, undefined, itemIdentity, stateController, registerCleanup),
            );
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
  else if (inactiveItems.length === 0)
    content.push(text('p', 'No public catalogue items match these criteria.', 'empty-state'));
  if (inactiveItems.length > 0) {
    const inactive = text('section', undefined, 'state-panel');
    inactive.append(text('h2', model.inactiveHeading), text('p', model.inactiveSummary));
    const inactiveList = text('ul', undefined, 'item-list');
    const inactiveSetIdentityCounts = new Map<string, Set<string>>();
    for (const item of catalogue.items) {
      const setLabel = presentationLabel([item.localSetCode, item.localSetName, item.collectorNumber], '');
      const key = `${item.localizationId}\u0000${setLabel}`;
      const identities = inactiveSetIdentityCounts.get(key) ?? new Set<string>();
      identities.add(item.setEditionId ?? item.itemId);
      inactiveSetIdentityCounts.set(key, identities);
    }
    const inactiveCollisionCounts = itemRowCollisionCounts(
      catalogue.items.filter((candidate) => !candidate.active),
      false,
    );
    for (const item of inactiveItems) {
      const localization = catalogue.localizations.find(
        (candidate) => candidate.localizationId === item.localizationId,
      );
      let ownerLabel = item.localizationId;
      if (localization) {
        const label = localizationLabel(localization);
        const key = `${localization.locality ?? ''}\u0000${label}`;
        const displayLabel =
          (localizationLabelCounts.get(key) ?? 0) > 1 ? `${label} · ${localization.localizationId}` : label;
        ownerLabel = `${displayLabel}${localization.locality ? ` (${localization.locality})` : ''}`;
      }
      const setLabel = presentationLabel([item.localSetCode, item.localSetName, item.collectorNumber], '');
      const setKey = `${item.localizationId}\u0000${setLabel}`;
      const setIdentity = !setLabel
        ? (item.setEditionId ?? item.itemId)
        : (inactiveSetIdentityCounts.get(setKey)?.size ?? 0) > 1
          ? item.setEditionId
          : undefined;
      const itemIdentity =
        (inactiveCollisionCounts.get(itemRowCollisionKey(item, false)) ?? 0) > 1 ? item.itemId : undefined;
      const identitySuffix = [setIdentity, itemIdentity].filter(Boolean).join(' · ') || undefined;
      inactiveList.append(
        renderItemRow(item, catalogue, true, ownerLabel, identitySuffix, stateController, registerCleanup),
      );
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
  renderProvenance($('[data-provenance]'), catalogue);
  renderBrowseNavigation($('[data-localizations]'), catalogue);
  if (!parsed.ok) {
    renderInvalid($('[data-view]'), parsed.recoverableLocalization);
    return;
  }
  if (parsed.criteria.edition) {
    const edition = catalogue.setEditions.find((row) => row.setEditionId === parsed.criteria.edition);
    if (!edition || (parsed.criteria.localization && edition.localizationId !== parsed.criteria.localization)) {
      renderInvalid($('[data-view]'), parsed.criteria.localization);
      return;
    }
  }
  const knownTrackableItemIds = new Set(
    catalogue.items.filter((item) => item.active && item.progressClass === 'current-known').map((item) => item.itemId),
  );
  const targetItemClasses = new Map(
    catalogue.items
      .filter((item) => item.active)
      .map((item) => [item.itemId, item.progressClass === 'current-known' ? 'current-known' : 'research'] as const),
  );
  const state = await readPrivateState(catalogue.meta.catalogueFingerprint, knownTrackableItemIds);
  const reconciliation = {
    migrations: migrationManifest.catalogueTransitions,
    knownSourceItemIdsByFingerprint,
    targetItemClasses,
  };
  const stateController = await createCollectionStateController(
    catalogue.meta.catalogueFingerprint,
    knownTrackableItemIds,
    reconciliation,
  );
  const renderState = stateController?.state.readable === true ? stateController.state : state;
  renderQueryForm($('[data-query]'), parsed.criteria, catalogue);
  renderResults($('[data-view]'), parsed.criteria, catalogue, renderState, stateController);
  const recoveryTools = document.querySelector<HTMLElement>('[data-recovery-tools]');
  if (recoveryTools) {
    const lifecycle = await createBackupLifecycle(reconciliation);
    renderRecoveryTools(recoveryTools, lifecycle, catalogue.meta.catalogueFingerprint, knownTrackableItemIds);
  }
}

enableThemeControl();
const validated = await validateSnapshot(snapshot);
if (!validated.ok) {
  renderInvalid($('[data-view]'), undefined, true);
} else if (!validateProvenance(provenance, validated.snapshot)) {
  renderInvalid($('[data-view]'), undefined, true);
} else if (document.body.dataset.page === 'collection') {
  await renderCollection(validated.snapshot);
} else {
  renderIndex(validated.snapshot);
}
