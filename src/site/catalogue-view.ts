import type { CatalogueSnapshot, SnapshotLocalization } from './catalogue.js';
import type { SiteProvenance } from './snapshot.js';
import { presentText } from './item-presentation.js';
import { text } from './route-common.js';

export type DirectoryCatalogue = Pick<CatalogueSnapshot, 'meta' | 'localizations'>;

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
  if (provenance.mode === 'pinned-snapshot') fields.push(['Catalogue byte digest', provenance.catalogueByteSha256]);
  for (const [label, value] of fields) dl.append(text('dt', label), text('dd', value));
  details.append(text('summary', `${summary} · Data as of ${dataAsOf}`), dl);
  container.replaceChildren(details);
}

export function sortedLocalizations(catalogue: DirectoryCatalogue): SnapshotLocalization[] {
  return [...catalogue.localizations].sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0));
}
