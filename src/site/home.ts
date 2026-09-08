import {
  localizationLabel,
  localizationDisplayLabel,
  validateSnapshot,
  validateProvenance,
  type SnapshotLocalization,
} from './catalogue.js';
import type { SiteProvenance } from './snapshot.js';
import { presentText } from './item-presentation.js';
import { serializeQuery } from './query.js';
import { $, text, link, shellAppRevision, matchesShellRevision, renderInvalid } from './route-common.js';
import { renderProvenance, sortedLocalizations, type DirectoryCatalogue } from './catalogue-view.js';

function renderLocalizationLinks(container: HTMLElement, catalogue: DirectoryCatalogue): void {
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
      const item = text('li');
      item.append(
        link(
          `collection/${serializeQuery({ localization: localization.localizationId })}`,
          localizationDisplayLabel(localization, labelCounts),
        ),
      );
      list.append(item);
    }
    section.append(list);
    directory.append(section);
  }
  container.replaceChildren(directory);
}

function renderIndex(catalogue: DirectoryCatalogue, provenance: SiteProvenance): void {
  renderProvenance($('[data-provenance]'), catalogue, provenance);
  renderLocalizationLinks($('[data-localizations]'), catalogue);
}

async function renderFullSnapshotHome(appRevision: string): Promise<void> {
  const snapshotModule = await import('./snapshot.js');
  const validated = await validateSnapshot(snapshotModule.default);
  if (
    !validated.ok ||
    !matchesShellRevision(snapshotModule.provenance, appRevision) ||
    !validateProvenance(snapshotModule.provenance, validated.snapshot)
  ) {
    renderInvalid($('[data-view]'), undefined, true);
    return;
  }
  renderIndex(validated.snapshot, snapshotModule.provenance);
}

function canonicalizeDirectoryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeDirectoryValue);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalizeDirectoryValue(record[key])]),
  );
}

async function canonicalDirectoryDigest(value: unknown): Promise<string | undefined> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalizeDirectoryValue(value)));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return undefined;
  }
}

async function matchesPinnedDirectoryEnvelopeDigest(
  value: unknown,
  provenance: unknown,
  expectedDigest: string,
): Promise<boolean> {
  if (!/^sha256:[0-9a-f]{64}$/u.test(expectedDigest)) return false;
  return (await canonicalDirectoryDigest({ directory: value, provenance })) === expectedDigest;
}

export async function renderHome(): Promise<void> {
  const appRevision = shellAppRevision();
  if (!appRevision) {
    renderInvalid($('[data-view]'), undefined, true);
    return;
  }
  const expectedDigest = document.querySelector<HTMLMetaElement>('meta[name="snoredex-directory-sha256"]')?.content;
  if (!expectedDigest) {
    await renderFullSnapshotHome(appRevision);
    return;
  }
  let directoryModule: typeof import('./directory.js');
  let snapshotModule: typeof import('./directory-snapshot.js');
  try {
    [directoryModule, snapshotModule] = await Promise.all([
      import('./directory.js'),
      import('./directory-snapshot.js'),
    ]);
  } catch {
    // A shell that pins a directory must not treat an integrity rejection as
    // permission to load different data. Only the legacy no-digest shell falls back.
    renderInvalid($('[data-view]'), undefined, true);
    return;
  }
  const projectionDigest = await canonicalDirectoryDigest(snapshotModule.default);
  if (
    !projectionDigest ||
    !(await matchesPinnedDirectoryEnvelopeDigest(snapshotModule.default, snapshotModule.provenance, expectedDigest)) ||
    !(await directoryModule.validateDirectorySnapshot(snapshotModule.default, projectionDigest)) ||
    !matchesShellRevision(snapshotModule.provenance, appRevision) ||
    !validateProvenance(snapshotModule.provenance, snapshotModule.default)
  ) {
    renderInvalid($('[data-view]'), undefined, true);
    return;
  }
  renderIndex(snapshotModule.default, snapshotModule.provenance);
}
