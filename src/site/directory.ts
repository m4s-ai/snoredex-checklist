import type { SnapshotLocalization, SnapshotMeta } from './catalogue.js';

export interface DirectorySnapshot {
  readonly meta: SnapshotMeta;
  readonly localizations: readonly SnapshotLocalization[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

async function canonicalDigest(value: unknown): Promise<string | undefined> {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return undefined;
  }
}

export function directoryProjectionDigest(value: unknown): Promise<string | undefined> {
  return canonicalDigest(value);
}

export function directoryEnvelopeDigest(value: unknown, provenance: unknown): Promise<string | undefined> {
  return canonicalDigest({ directory: value, provenance });
}

export async function validateDirectorySnapshot(value: unknown, expectedDigest: string): Promise<boolean> {
  if (!/^sha256:[0-9a-f]{64}$/u.test(expectedDigest)) return false;
  if (!isRecord(value) || !isRecord(value.meta) || !Array.isArray(value.localizations)) return false;
  const meta = value.meta;
  if (
    meta.schema !== 'snoredex-collector-catalogue' ||
    meta.schemaVersion !== '1.0.0' ||
    typeof meta.catalogueFingerprint !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(meta.catalogueFingerprint) ||
    typeof meta.sourceRepository !== 'string' ||
    typeof meta.dataAsOf !== 'string' ||
    value.localizations.length === 0
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const localization of value.localizations) {
    if (
      !isRecord(localization) ||
      typeof localization.localizationId !== 'string' ||
      localization.localizationId.length === 0 ||
      ids.has(localization.localizationId) ||
      !isOptionalString(localization.locality) ||
      !isOptionalString(localization.languageTag) ||
      !isOptionalString(localization.displayName) ||
      (localization.displayOrder !== undefined && !Number.isSafeInteger(localization.displayOrder))
    ) {
      return false;
    }
    ids.add(localization.localizationId);
  }
  return (await directoryProjectionDigest(value)) === expectedDigest;
}
