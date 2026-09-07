import type { SnapshotItem } from './catalogue.js';

/** Keep presentation text readable without turning producer labels into identities. */
export function presentText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return normalized || undefined;
}

export function collectorNumberLabel(item: SnapshotItem): string | undefined {
  const number = presentText(item.collectorNumber);
  const denominator = presentText(item.collectorNumberDenominator);
  if (!number) return undefined;
  return denominator ? `${number}/${denominator}` : number;
}

export function imageScopeLabel(item: SnapshotItem, placeholder: boolean): string {
  if (item.imageScope === 'exact-printing') {
    return placeholder ? 'Exact-printing placeholder' : 'Exact printing image';
  }
  if (item.imageScope === 'card-release') {
    return placeholder ? 'Card-release placeholder (broader release)' : 'Card-release image (broader release)';
  }
  return 'Authored placeholder (image scope unknown)';
}

export function itemKindLabel(item: SnapshotItem): string {
  if (item.itemKind === 'verified-printing') return 'Verified printing';
  if (item.itemKind === 'finish-candidate') return 'Finish candidate';
  if (item.itemKind === 'research-placeholder') return 'Research placeholder';
  return 'Catalogue item';
}

function recordValue(item: SnapshotItem, key: string): unknown {
  const value = item[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

export function finishCueLabel(item: SnapshotItem): string | undefined {
  const finish = presentText(item.finish);
  const family = presentText(item.finishFamily);
  if (finish && family && finish !== family) return `Finish: ${finish} · Finish family: ${family}`;
  if (finish) return `Finish: ${finish}`;
  if (family) return `Finish family: ${family}`;
  return undefined;
}

export function rarityLabel(item: SnapshotItem): string | undefined {
  const rarity = recordValue(item, 'rarity');
  return rarity === undefined ? undefined : presentText((rarity as Record<string, unknown>).display);
}

export function rarityEvidenceLabel(item: SnapshotItem): string | undefined {
  const rarity = recordValue(item, 'rarity');
  return rarity === undefined ? undefined : presentText((rarity as Record<string, unknown>).evidenceStatus);
}

type MarkingCuePart = readonly [string | null, string | null, string | null];

function markingCueParts(item: SnapshotItem): MarkingCuePart[] {
  if (!Array.isArray(item.markings)) return [];
  return item.markings
    .map((marking): MarkingCuePart | undefined => {
      if (typeof marking !== 'object' || marking === null || Array.isArray(marking)) return undefined;
      const row = marking as Record<string, unknown>;
      const kind = presentText(row.kind) ?? null;
      const role = presentText(row.role) ?? null;
      const value = presentText(row.text) ?? null;
      return kind === null && role === null && value === null ? undefined : [kind, role, value];
    })
    .filter((value): value is MarkingCuePart => value !== undefined);
}

function markingsCueLabel(item: SnapshotItem): string | undefined {
  const values = markingCueParts(item)
    .map(([kind, role, value]) => {
      const kindAndRole = [kind, role].filter((part): part is string => part !== null).join('/');
      return (
        [kindAndRole, value].filter((part): part is string => part !== null && part !== '').join(': ') || undefined
      );
    })
    .filter((value): value is string => Boolean(value));
  return values.length > 0 ? `Markings: ${values.join(', ')}` : undefined;
}

function identityPart(label: string, value: unknown): string | undefined {
  const normalized = presentText(value);
  return normalized ? `${label}: ${normalized}` : undefined;
}

/** Compact producer-backed cues that belong in the row's accessible identity. */
export function itemIdentityCueLabel(item: SnapshotItem): string {
  const parts = [
    identityPart('Edition', item.edition),
    finishCueLabel(item),
    identityPart('Foil', item.foilPattern),
    markingsCueLabel(item),
    identityPart('Size', item.cardSize),
    identityPart('Rarity', rarityLabel(item)),
    itemKindLabel(item),
  ].filter((value): value is string => value !== undefined);
  return parts.join(' · ');
}

/** Stable structured identity for collision handling; keep it separate from display formatting. */
export function itemIdentityCueKey(item: SnapshotItem): string {
  return JSON.stringify({
    edition: presentText(item.edition) ?? null,
    finish: presentText(item.finish) ?? null,
    finishFamily: presentText(item.finishFamily) ?? null,
    foilPattern: presentText(item.foilPattern) ?? null,
    markings: markingCueParts(item),
    cardSize: presentText(item.cardSize) ?? null,
    rarity: rarityLabel(item) ?? null,
    itemKind: presentText(item.itemKind) ?? null,
  });
}

export function itemCueLabel(item: SnapshotItem): string {
  return item.progressClass === 'research' ? 'Research · read-only' : 'Trackable';
}

export function evidenceCueLabel(item: SnapshotItem): string | undefined {
  const status = presentText(item.finishVerificationStatus);
  return status ? `Producer evidence: ${status}` : undefined;
}

export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (!url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function linkValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(safeExternalUrl).filter((url): url is string => url !== undefined);
}
