export interface PrivateStateRead {
  readonly readable: boolean;
  readonly hasActiveState: boolean;
  readonly statuses: ReadonlyMap<string, 'need' | 'ordered' | 'have' | 'skip'>;
}

type AuthorityResult =
  | {
      readonly ok: true;
      readonly active:
        | {
            readonly catalogueFingerprint: string;
            readonly items: readonly {
              readonly itemId: string;
              readonly status: 'need' | 'ordered' | 'have' | 'skip';
            }[];
          }
        | undefined;
    }
  | { readonly ok: false };

type AuthorityReader = (raw: string | null, recovery: string | null) => AuthorityResult;

const ACTIVE_KEY = 'snoredex-checklist.private-state';
const RECOVERY_KEY = 'snoredex-checklist.private-state.recovery';

/** Read the shared browser-local authority without ever placing private values in the URL or DOM. */
export async function readPrivateState(
  expectedCatalogueFingerprint: string,
  knownTrackableItemIds: ReadonlySet<string>,
  // Keep the trust-boundary adapter directly testable without importing the
  // generated, runtime-relative authority bundle in source tests.
  authorityReader?: AuthorityReader,
): Promise<PrivateStateRead> {
  try {
    if (typeof localStorage === 'undefined') return { readable: true, hasActiveState: false, statuses: new Map() };
    const raw = localStorage.getItem(ACTIVE_KEY);
    const recovery = localStorage.getItem(RECOVERY_KEY);
    if (raw === null && recovery === null) return { readable: true, hasActiveState: false, statuses: new Map() };
    const result =
      authorityReader === undefined
        ? // @ts-expect-error The runtime-relative module is emitted by the separate state build.
          (await import('./state/authority.js')).readStateAuthority(raw, recovery)
        : authorityReader(raw, recovery);
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
    if (
      active !== undefined &&
      active.items.some((item: { readonly itemId: string }) => !knownTrackableItemIds.has(item.itemId))
    ) {
      return { readable: false, hasActiveState: true, statuses: new Map() };
    }
    const statuses = new Map<string, 'need' | 'ordered' | 'have' | 'skip'>();
    for (const item of active?.items ?? []) statuses.set(item.itemId, item.status);
    return { readable: true, hasActiveState: active !== undefined, statuses };
  } catch {
    // A denied/unavailable storage or missing optional browser bundle must not block public browsing.
    return { readable: false, hasActiveState: false, statuses: new Map() };
  }
}
