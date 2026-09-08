import { canonicalize as canonicalizeDirectoryValue } from './canonical-json.ts';
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
import {
  $,
  text,
  link,
  shellAppRevision,
  matchesShellRevision,
  renderUnavailable,
  finishStartup,
  isRuntimeRecord,
} from './route-common.js';
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
  finishStartup();
  renderProvenance($('[data-provenance]'), catalogue, provenance);
  renderLocalizationLinks($('[data-localizations]'), catalogue);
}

async function renderFullSnapshotHome(appRevision: string): Promise<void> {
  let snapshotModule: typeof import('./snapshot.js');
  try {
    snapshotModule = await import('./snapshot.js');
  } catch {
    renderUnavailable($('[data-view]'));
    return;
  }
  const validated = await validateSnapshot(snapshotModule.default);
  if (!validated.ok) {
    renderUnavailable($('[data-view]'), validated.reason === 'unsupported');
    return;
  }
  if (
    !matchesShellRevision(snapshotModule.provenance, appRevision) ||
    !validateProvenance(snapshotModule.provenance, validated.snapshot)
  ) {
    renderUnavailable($('[data-view]'));
    return;
  }
  renderIndex(validated.snapshot, snapshotModule.provenance);
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
    renderUnavailable($('[data-view]'));
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
    renderUnavailable($('[data-view]'));
    return;
  }
  const projectionDigest = await canonicalDirectoryDigest(snapshotModule.default);
  if (
    !projectionDigest ||
    !(await matchesPinnedDirectoryEnvelopeDigest(snapshotModule.default, snapshotModule.provenance, expectedDigest))
  ) {
    renderUnavailable($('[data-view]'));
    return;
  }
  if (
    isRuntimeRecord(snapshotModule.default) &&
    isRuntimeRecord(snapshotModule.default.meta) &&
    (snapshotModule.default.meta.schema !== 'snoredex-collector-catalogue' ||
      snapshotModule.default.meta.schemaVersion !== '1.0.0')
  ) {
    renderUnavailable($('[data-view]'), true);
    return;
  }
  if (
    !(await directoryModule.validateDirectorySnapshot(snapshotModule.default, projectionDigest)) ||
    !matchesShellRevision(snapshotModule.provenance, appRevision) ||
    !validateProvenance(snapshotModule.provenance, snapshotModule.default)
  ) {
    renderUnavailable($('[data-view]'));
    return;
  }
  renderIndex(snapshotModule.default, snapshotModule.provenance);
}
