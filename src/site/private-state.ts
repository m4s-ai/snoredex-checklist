export interface PrivateStateRead {
  readonly readable: boolean;
  readonly hasActiveState: boolean;
  readonly statuses: ReadonlyMap<string, "need" | "ordered" | "have" | "skip">;
}

// Keep the import runtime-relative so the site compiler does not need the
// state authority in its source root; build-site emits it beside this module.
const AUTHORITY_MODULE: string = "./state/authority.js";
const ACTIVE_KEY = "snoredex-checklist.private-state";
const RECOVERY_KEY = "snoredex-checklist.private-state.recovery";

/** Read the shared browser-local authority without ever placing private values in the URL or DOM. */
export async function readPrivateState(
  expectedCatalogueFingerprint: string,
  knownTrackableItemIds: ReadonlySet<string>,
): Promise<PrivateStateRead> {
  try {
    if (typeof localStorage === "undefined") return { readable: true, hasActiveState: false, statuses: new Map() };
    const raw = localStorage.getItem(ACTIVE_KEY);
    const recovery = localStorage.getItem(RECOVERY_KEY);
    if (raw === null && recovery === null) return { readable: true, hasActiveState: false, statuses: new Map() };
    const authority = await import(AUTHORITY_MODULE);
    const result = authority.readStateAuthority(raw, recovery);
    if (!result.ok) return { readable: false, hasActiveState: false, statuses: new Map() };
    const active = result.active;
    // A state envelope belongs to one exact catalogue revision. Defer it to
    // the reconciliation owner instead of silently projecting stale IDs into
    // the current snapshot (which would lose old records and invent Need rows).
    if (active !== undefined && active.catalogueFingerprint !== expectedCatalogueFingerprint) {
      return { readable: false, hasActiveState: true, statuses: new Map() };
    }
    // Do not silently drop records that the current trusted catalogue cannot
    // resolve. Reconciliation owns explicit migrations; this shell defers
    // the whole state rather than inventing Need defaults for a partial view.
    if (active !== undefined && active.items.some((item: { readonly itemId: string }) => !knownTrackableItemIds.has(item.itemId))) {
      return { readable: false, hasActiveState: true, statuses: new Map() };
    }
    const statuses = new Map<string, "need" | "ordered" | "have" | "skip">();
    for (const item of active?.items ?? []) statuses.set(item.itemId, item.status);
    return { readable: true, hasActiveState: active !== undefined, statuses };
  } catch {
    // A denied/unavailable storage or missing optional browser bundle must not block public browsing.
    return { readable: false, hasActiveState: false, statuses: new Map() };
  }
}
