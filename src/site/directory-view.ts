import { localizationLabel, type CatalogueSnapshot, type SnapshotLocalization } from './catalogue.js';
import { presentText } from './item-presentation.js';
import { serializeQuery } from './query.js';
import type { SiteProvenance } from './snapshot.js';

type DirectoryCatalogue = Pick<CatalogueSnapshot, 'meta' | 'localizations'>;

function text(tag: string, value?: unknown, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.textContent = String(value);
  return element;
}

function link(href: string, label: string): HTMLAnchorElement {
  const element = text('a', label) as HTMLAnchorElement;
  element.href = href;
  return element;
}

export function renderProvenance(
  container: HTMLElement,
  catalogue: DirectoryCatalogue,
  provenance: SiteProvenance,
): void {
  const details = text('details', undefined, 'provenance-disclosure') as HTMLDetailsElement;
  const dataAsOf = presentText(catalogue.meta.dataAsOf) ?? 'date unavailable';
  const summary = provenance.mode === 'pinned-snapshot' ? 'Catalogue verified' : 'Catalogue fixture';
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
  for (const [label, value] of fields) dl.append(text('dt', label), text('dd', value));
  details.append(text('summary', `${summary} · Data as of ${dataAsOf}`), dl);
  container.replaceChildren(details);
}

export function sortedLocalizations(catalogue: DirectoryCatalogue): SnapshotLocalization[] {
  return [...catalogue.localizations].sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
}

export function localizationDisplayLabel(
  localization: SnapshotLocalization,
  labelCounts: ReadonlyMap<string, number>,
): string {
  const label = localizationLabel(localization);
  const key = `${localization.locality ?? ''}\u0000${label}`;
  if ((labelCounts.get(key) ?? 0) <= 1) return label;
  return `${label} (${presentText(localization.languageTag) ?? 'variant'})`;
}

export function renderLocalizationLinks(
  container: HTMLElement,
  catalogue: DirectoryCatalogue,
  hrefPrefix = 'collection/',
): void {
  const groups = new Map<string, { label: string; localizations: SnapshotLocalization[] }>();
  for (const localization of sortedLocalizations(catalogue)) {
    const locality = presentText(localization.locality);
    const key = locality ?? localization.localizationId;
    const group = groups.get(key) ?? { label: locality ?? 'Unspecified locality', localizations: [] };
    group.localizations.push(localization);
    groups.set(key, group);
  }
  const labelCounts = new Map<string, number>();
  for (const localization of catalogue.localizations) {
    const label = localizationLabel(localization);
    const key = `${localization.locality ?? ''}\u0000${label}`;
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  const directory = text('div', undefined, 'localization-groups');
  for (const group of groups.values()) {
    const section = text('section', undefined, 'localization-group');
    section.append(text('h3', group.label));
    const list = text('ul', undefined, 'link-list');
    for (const localization of group.localizations) {
      const li = text('li');
      li.append(
        link(
          `${hrefPrefix}${serializeQuery({ localization: localization.localizationId })}`,
          localizationDisplayLabel(localization, labelCounts),
        ),
      );
      list.append(li);
    }
    section.append(list);
    directory.append(section);
  }
  container.replaceChildren(directory);
}
