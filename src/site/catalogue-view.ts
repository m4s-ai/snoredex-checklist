import type { CatalogueSnapshot, SnapshotLocalization } from './catalogue.js';
import type { SiteProvenance } from './snapshot.js';
import { presentText } from './item-presentation.js';
import { text, link } from './route-common.js';

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
    ['App revision', provenance.appRevision ?? 'Not recorded'],
    ['Publication', provenance.publicationId ?? 'Not recorded in this build'],
  ];
  if (provenance.mode === 'pinned-snapshot') fields.push(['Catalogue byte digest', provenance.catalogueByteSha256]);
  for (const [label, value] of fields) dl.append(text('dt', label), text('dd', value));
  const publication = /^pages-(\d+)-(\d+)$/u.exec(provenance.publicationId ?? '');
  if (publication) {
    const receipt = text('dd');
    const publicationLink = link(
      `https://github.com/m4s-ai/snoredex-checklist/actions/runs/${publication[1]}/attempts/${publication[2]}`,
      'View publication run (external site)',
    );
    publicationLink.rel = 'noopener noreferrer';
    receipt.append(publicationLink);
    dl.append(text('dt', 'Publication record'), receipt);
  }
  details.append(text('summary', `${summary} · Data as of ${dataAsOf}`), dl);
  details.append(text('p', 'Data as of describes the catalogue coverage date, not when this app was published.'));
  container.replaceChildren(details);
}

export function sortedLocalizations(catalogue: DirectoryCatalogue): SnapshotLocalization[] {
  return [...catalogue.localizations].sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0));
}
