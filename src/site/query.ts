// `status` is a shareable criterion only; no private status values or records are serialized.
export const QUERY_KEYS = ['localization', 'edition', 'q', 'status', 'kind', 'research'] as const;
export type QueryKey = (typeof QUERY_KEYS)[number];

export interface QueryCriteria {
  readonly localization?: string;
  readonly edition?: string;
  readonly q?: string;
  readonly status?: 'need' | 'ordered' | 'have' | 'skip';
  readonly kind?: 'verified-printing' | 'finish-candidate' | 'research-placeholder';
  readonly research?: 'true' | 'false';
}

export type QueryParse =
  | { readonly ok: true; readonly criteria: QueryCriteria }
  | { readonly ok: false; readonly recoverableLocalization?: string };

const STATUS = new Set(['need', 'ordered', 'have', 'skip']);
const KIND = new Set(['verified-printing', 'finish-candidate', 'research-placeholder']);
const RESEARCH = new Set(['true', 'false']);
const MAX_QUERY_TEXT = 120;
const MAX_QUERY_TERMS = 12;
// Keep a bounded raw URL while applying the user-facing limit to decoded text below.
const MAX_QUERY_RAW = 4096;

function recoverableLocalization(params: URLSearchParams, ids: ReadonlySet<string>): string | undefined {
  const values = params.getAll('localization');
  return values.length === 1 && ids.has(values[0]) ? values[0] : undefined;
}

function invalidQuery(params: URLSearchParams, localizationIds: ReadonlySet<string>): QueryParse {
  const localization = recoverableLocalization(params, localizationIds);
  return localization ? { ok: false, recoverableLocalization: localization } : { ok: false };
}

function parseParameters(raw: string): URLSearchParams | undefined {
  try {
    // URLSearchParams replaces malformed UTF-8 with U+FFFD; reject it before parsing.
    decodeURIComponent(raw.replace(/\+/g, '%20'));
    return new URLSearchParams(raw);
  } catch {
    return undefined;
  }
}

function hasValidParameterShape(params: URLSearchParams): boolean {
  for (const key of params.keys()) {
    if (!(QUERY_KEYS as readonly string[]).includes(key)) return false;
  }
  for (const key of QUERY_KEYS) {
    const values = params.getAll(key);
    if (values.length > 1 || (values.length === 1 && values[0] === '')) return false;
  }
  return true;
}

function criteriaFromParameters(
  params: URLSearchParams,
  localizationIds: ReadonlySet<string>,
  editionIds: ReadonlySet<string>,
): QueryCriteria | undefined {
  const localization = params.get('localization') ?? undefined;
  const edition = params.get('edition') ?? undefined;
  const q = params.get('q') ?? undefined;
  const status = params.get('status') ?? undefined;
  const kind = params.get('kind') ?? undefined;
  const research = params.get('research') ?? undefined;
  const terms = q?.trim().split(/\s+/u).filter(Boolean) ?? [];
  if (localization && !localizationIds.has(localization)) return undefined;
  if (edition && !editionIds.has(edition)) return undefined;
  if (q && (q.length > MAX_QUERY_TEXT || terms.length > MAX_QUERY_TERMS || terms.length === 0)) return undefined;
  if (status && !STATUS.has(status)) return undefined;
  if (kind && !KIND.has(kind)) return undefined;
  if (research && !RESEARCH.has(research)) return undefined;

  const criteria: {
    localization?: string;
    edition?: string;
    q?: string;
    status?: QueryCriteria['status'];
    kind?: QueryCriteria['kind'];
    research?: QueryCriteria['research'];
  } = {};
  if (localization) criteria.localization = localization;
  if (edition) criteria.edition = edition;
  if (q) criteria.q = q.trim();
  if (status) criteria.status = status as QueryCriteria['status'];
  if (kind) criteria.kind = kind as QueryCriteria['kind'];
  if (research) criteria.research = research as QueryCriteria['research'];
  return criteria;
}

export function parseQuery(
  search: string,
  localizationIds: ReadonlySet<string>,
  editionIds: ReadonlySet<string> = new Set(),
): QueryParse {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (raw.length > MAX_QUERY_RAW || /%(?![0-9a-fA-F]{2})/.test(raw)) return { ok: false };
  const params = parseParameters(raw);
  if (!params) return { ok: false };
  if (!hasValidParameterShape(params)) return invalidQuery(params, localizationIds);
  const criteria = criteriaFromParameters(params, localizationIds, editionIds);
  return criteria ? { ok: true, criteria } : invalidQuery(params, localizationIds);
}

export function serializeQuery(criteria: QueryCriteria): string {
  const params = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const value = key === 'q' ? criteria.q?.trim() : criteria[key];
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}
