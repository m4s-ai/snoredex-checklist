interface MigrationTransition {
  readonly fromItemId?: unknown;
  readonly fromItemIds?: unknown;
  readonly toItemIds?: unknown;
  readonly changeKind?: unknown;
  readonly automaticStateAction?: unknown;
  readonly reconciliation?: unknown;
}

interface MigrationRoute {
  readonly fromFingerprint?: unknown;
  readonly toFingerprint?: unknown;
  readonly sourceItemIds?: unknown;
  readonly transitions?: unknown;
}

interface MigrationManifest {
  readonly catalogueTransitions?: unknown;
}

interface Catalogue {
  readonly meta?: { readonly catalogueFingerprint?: unknown };
  readonly items?: readonly { readonly itemId?: unknown }[];
}

function asItemIdSet(value: unknown, label: string): Set<string> {
  if (!Array.isArray(value) || value.some((itemId) => typeof itemId !== 'string' || itemId.length === 0)) {
    throw new Error(`BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID: ${label}`);
  }
  const itemIds = new Set(value);
  if (itemIds.size !== value.length) {
    throw new Error(`BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID: duplicate ${label}`);
  }
  return itemIds;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function transitionItemIds(
  transition: MigrationTransition,
  key: 'fromItemIds' | 'toItemIds',
  label: string,
): Set<string> {
  const value = transition[key];
  if (key === 'fromItemIds' && value === undefined) {
    return asItemIdSet([transition.fromItemId], `${label}.fromItemId`);
  }
  return asItemIdSet(value, `${label}.${key}`);
}

function isIdentityTransition(transition: MigrationTransition): boolean {
  const from = transitionItemIds(transition, 'fromItemIds', 'transition');
  const to = transitionItemIds(transition, 'toItemIds', 'transition');
  return (
    from.size === 1 &&
    to.size === 1 &&
    [...from][0] === [...to][0] &&
    transition.changeKind === 'retained' &&
    transition.automaticStateAction === 'preserve' &&
    transition.reconciliation === 'identity-retained'
  );
}

/**
 * Build the runtime source-membership index only after an independent contract
 * check. A transition list is not allowed to define its own completeness.
 * Identity-preserving routes to the committed catalogue can be checked against
 * that catalogue; other routes must publish an explicit sourceItemIds set.
 */
export function buildValidatedSourceMembershipIndex(
  migrationManifest: MigrationManifest | null | undefined,
  catalogue: Catalogue | null | undefined,
): Map<string, Set<string>> {
  const routes = migrationManifest?.catalogueTransitions;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error('BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID: routes');
  }
  const targetFingerprint = catalogue?.meta?.catalogueFingerprint;
  const targetItemIds = asItemIdSet(
    Array.isArray(catalogue?.items) ? catalogue.items.map((item) => item.itemId) : undefined,
    'catalogue.items',
  );
  const byFingerprint = new Map<string, Set<string>>();
  for (const route of routes) {
    if (typeof route !== 'object' || route === null) {
      throw new Error('BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID: route');
    }
    const migration = route as MigrationRoute;
    const fromFingerprint = migration.fromFingerprint;
    if (typeof fromFingerprint !== 'string' || fromFingerprint.length === 0 || byFingerprint.has(fromFingerprint)) {
      throw new Error('BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID: route fingerprint');
    }
    if (!Array.isArray(migration.transitions) || migration.transitions.length === 0) {
      throw new Error(`BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID: ${fromFingerprint} transitions`);
    }
    const sourceItemIds = new Set<string>();
    const targetRouteItemIds = new Set<string>();
    for (const [index, candidate] of migration.transitions.entries()) {
      if (typeof candidate !== 'object' || candidate === null) {
        throw new Error(`BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID: transition ${index}`);
      }
      const transition = candidate as MigrationTransition;
      for (const itemId of transitionItemIds(transition, 'fromItemIds', `transition ${index}`))
        sourceItemIds.add(itemId);
      for (const itemId of transitionItemIds(transition, 'toItemIds', `transition ${index}`))
        targetRouteItemIds.add(itemId);
    }
    const transitions = migration.transitions as readonly MigrationTransition[];
    let expectedSourceItemIds: Set<string>;
    if (migration.sourceItemIds !== undefined) {
      expectedSourceItemIds = asItemIdSet(migration.sourceItemIds, `${fromFingerprint}.sourceItemIds`);
    } else if (migration.toFingerprint === targetFingerprint && transitions.every(isIdentityTransition)) {
      expectedSourceItemIds = targetItemIds;
    } else {
      throw new Error(`BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID: ${fromFingerprint} needs sourceItemIds`);
    }
    if (!sameSet(sourceItemIds, expectedSourceItemIds)) {
      throw new Error(`BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID: ${fromFingerprint} source set`);
    }
    if (
      migration.toFingerprint === targetFingerprint &&
      ![...targetRouteItemIds].every((itemId) => targetItemIds.has(itemId))
    ) {
      throw new Error(`BUILD_MIGRATION_SOURCE_MEMBERSHIP_INVALID: ${fromFingerprint} target set`);
    }
    byFingerprint.set(fromFingerprint, expectedSourceItemIds);
  }
  return byFingerprint;
}
