// `status` is a shareable criterion only; no private status values or records are serialized.
export const QUERY_KEYS = ["localization", "q", "status", "kind", "research"] as const;
export type QueryKey = (typeof QUERY_KEYS)[number];

export interface QueryCriteria {
  readonly localization?: string;
  readonly q?: string;
  readonly status?: "need" | "ordered" | "have" | "skip";
  readonly kind?: "verified-printing" | "finish-candidate" | "research-placeholder";
  readonly research?: "true" | "false";
}

export type QueryParse =
  | { readonly ok: true; readonly criteria: QueryCriteria }
  | { readonly ok: false; readonly recoverableLocalization?: string };

const STATUS = new Set(["need", "ordered", "have", "skip"]);
const KIND = new Set(["verified-printing", "finish-candidate", "research-placeholder"]);
const RESEARCH = new Set(["true", "false"]);
const MAX_QUERY_TEXT = 120;
const MAX_QUERY_TERMS = 12;
// Keep a bounded raw URL while applying the user-facing limit to decoded text below.
const MAX_QUERY_RAW = 4096;

function recoverableLocalization(params: URLSearchParams, ids: ReadonlySet<string>): string | undefined {
  const values = params.getAll("localization");
  return values.length === 1 && ids.has(values[0]) ? values[0] : undefined;
}

export function parseQuery(search: string, localizationIds: ReadonlySet<string>): QueryParse {
  const invalid = (params: URLSearchParams): QueryParse => {
    const localization = recoverableLocalization(params, localizationIds);
    return localization ? { ok: false, recoverableLocalization: localization } : { ok: false };
  };
  let params: URLSearchParams;
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (raw.length > MAX_QUERY_RAW || /%(?![0-9a-fA-F]{2})/.test(raw)) return { ok: false };
  try {
    // URLSearchParams replaces malformed UTF-8 with U+FFFD; reject it before parsing.
    decodeURIComponent(raw.replace(/\+/g, "%20"));
  } catch {
    return { ok: false };
  }
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { ok: false };
  }
  for (const key of params.keys()) {
    if (!(QUERY_KEYS as readonly string[]).includes(key)) {
      return invalid(params);
    }
  }
  for (const key of QUERY_KEYS) {
    const values = params.getAll(key);
    if (values.length > 1 || (values.length === 1 && values[0] === "")) {
      return invalid(params);
    }
  }
  const localization = params.get("localization") ?? undefined;
  const q = params.get("q") ?? undefined;
  const status = params.get("status") ?? undefined;
  const kind = params.get("kind") ?? undefined;
  const research = params.get("research") ?? undefined;
  const terms = q?.trim().split(/\s+/u).filter(Boolean) ?? [];
  if ((localization && !localizationIds.has(localization)) || (q && (q.length > MAX_QUERY_TEXT || terms.length > MAX_QUERY_TERMS || terms.length === 0)) ||
      (status && !STATUS.has(status)) || (kind && !KIND.has(kind)) || (research && !RESEARCH.has(research))) {
    return invalid(params);
  }
  const criteria: { localization?: string; q?: string; status?: QueryCriteria["status"]; kind?: QueryCriteria["kind"]; research?: QueryCriteria["research"] } = {};
  if (localization) criteria.localization = localization;
  if (q) criteria.q = q.trim();
  if (status) criteria.status = status as QueryCriteria["status"];
  if (kind) criteria.kind = kind as QueryCriteria["kind"];
  if (research) criteria.research = research as QueryCriteria["research"];
  return { ok: true, criteria };
}

export function serializeQuery(criteria: QueryCriteria): string {
  const params = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const value = key === "q" ? criteria.q?.trim() : criteria[key];
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}
