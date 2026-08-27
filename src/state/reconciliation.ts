import {
  PRIVATE_DATASET_ID,
  PRIVATE_STATE_SCHEMA,
  PRIVATE_STATE_VERSION,
  validatePrivateState,
  type PrivateItemState,
  type PrivateState,
} from "./domain.ts";

const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ITEM_ID_PATTERN = /^item-[0-9a-f-]{36}$/;

export const RECONCILIATION_ERROR_CODES = [
  "STATE_FINGERPRINT_UNSUPPORTED",
  "STATE_RECONCILIATION_BLOCKED",
] as const;
export type ReconciliationErrorCode = (typeof RECONCILIATION_ERROR_CODES)[number];

export interface ReconciliationTransition {
  readonly fromItemId: string;
  readonly fromItemIds?: readonly string[];
  readonly toItemIds: readonly string[];
  readonly changeKind: string;
  readonly automaticStateAction: string;
  readonly reconciliation: string;
}

export interface ReconciliationMigration {
  readonly fromFingerprint: string;
  readonly toFingerprint: string;
  readonly transitions: readonly ReconciliationTransition[];
}

/** The producer manifest shape is accepted without coupling the browser to producer internals. */
export interface ReconciliationManifest {
  readonly meta?: {
    readonly fromFingerprint?: string;
    readonly toFingerprint?: string;
  };
  readonly catalogueTransitions: readonly ReconciliationMigration[];
}

export interface ReconciliationContext {
  readonly migrations: readonly ReconciliationMigration[] | ReconciliationManifest;
  /** Optional final-catalogue membership. If supplied, every mapped target must be present. */
  readonly knownTargetItemIds?: ReadonlySet<string>;
  readonly targetItemClasses?: ReadonlyMap<string, "current-known" | "research">;
}

export interface ReconciliationRecord {
  readonly fromItemIds: readonly string[];
  readonly toItemIds: readonly string[];
  readonly changeKind: string;
  readonly automaticStateAction: string;
  readonly resolution: "identity-retained" | "one-to-one-preserve" | "retire-to-orphan" | "requires-user-resolution";
  readonly disposition: "active" | "migrated" | "orphan" | "orphan-and-conflict";
}

export interface ReconciliationAccounting {
  readonly oldExplicitRecords: number;
  readonly retained: number;
  readonly migrated: number;
  readonly retiredOrphans: number;
  readonly conflicts: number;
  readonly unresolved: number;
  readonly newCurrentKnown: number;
  readonly newResearch: number;
  readonly accountedOldRecords: number;
  readonly conservationSatisfied: boolean;
}

/** This report contains only opaque IDs and bounded counts; private values stay in the candidate. */
export interface ReconciliationReport {
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly steps: number;
  readonly records: readonly ReconciliationRecord[];
  readonly accounting: ReconciliationAccounting;
}

export interface ReconciliationSuccess {
  readonly state: PrivateState;
  readonly report: ReconciliationReport;
  readonly orphans: readonly PrivateItemState[];
  readonly conflicts: readonly PrivateItemState[];
}

export type ReconciliationResult =
  | { readonly ok: true; readonly value: ReconciliationSuccess }
  | {
      readonly ok: false;
      readonly error: ReconciliationErrorCode;
      readonly report?: ReconciliationReport;
    };

interface WorkingRecord {
  readonly state: PrivateItemState;
  readonly itemId: string;
}

interface ClassifiedRecord {
  readonly record: ReconciliationRecord;
  readonly state: PrivateItemState;
  readonly kind: "active" | "orphan" | "conflict";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

function isItemId(value: unknown): value is string {
  return typeof value === "string" && ITEM_ID_PATTERN.test(value);
}

function fail(error: ReconciliationErrorCode, report?: ReconciliationReport): ReconciliationResult {
  return report === undefined ? { ok: false, error } : { ok: false, error, report };
}

function cloneItem(item: PrivateItemState, itemId = item.itemId): PrivateItemState {
  return { ...item, itemId };
}

function migrationList(context: ReconciliationContext): readonly ReconciliationMigration[] {
  const source = context?.migrations as unknown;
  if (Array.isArray(source)) return source as readonly ReconciliationMigration[];
  if (!isObjectRecord(source)) return [];
  const transitions = source.catalogueTransitions;
  return Array.isArray(transitions) ? transitions : [];
}

function transitionSources(transition: ReconciliationTransition): readonly string[] {
  return transition.fromItemIds === undefined ? [transition.fromItemId] : transition.fromItemIds;
}

function migrationIsStructurallyValid(input: unknown): input is ReconciliationMigration {
  if (!isObjectRecord(input)
    || !isFingerprint(input.fromFingerprint) || !isFingerprint(input.toFingerprint)
    || input.fromFingerprint === input.toFingerprint || !Array.isArray(input.transitions)) {
    return false;
  }
  const migration = input as unknown as ReconciliationMigration;
  if (migration.transitions.length === 0) return false;
  const sources = new Set<string>();
  const targets = new Map<string, string>();
  for (const candidate of migration.transitions) {
    if (!isObjectRecord(candidate)) return false;
    const transition = candidate as unknown as ReconciliationTransition;
    if (!isItemId(transition.fromItemId)
      || (transition.fromItemIds !== undefined && !Array.isArray(transition.fromItemIds))
      || !Array.isArray(transition.toItemIds) || transition.toItemIds.some((id: unknown) => !isItemId(id))
      || typeof transition.changeKind !== "string"
      || typeof transition.automaticStateAction !== "string"
      || typeof transition.reconciliation !== "string") {
      return false;
    }
    const fromIds = transitionSources(transition);
    if (fromIds.length === 0 || !fromIds.includes(transition.fromItemId)
      || fromIds.some((id) => !isItemId(id))
      || new Set(fromIds).size !== fromIds.length
      || new Set(transition.toItemIds).size !== transition.toItemIds.length
      || expectedForTransition(transition) === undefined) {
      return false;
    }
    for (const fromId of fromIds) {
      if (sources.has(fromId)) return false;
      sources.add(fromId);
    }
    for (const toId of transition.toItemIds) {
      const previous = targets.get(toId);
      if (previous !== undefined && previous !== transition.fromItemId) return false;
      targets.set(toId, transition.fromItemId);
    }
  }
  return true;
}

function findChain(
  sourceFingerprint: string,
  targetFingerprint: string,
  migrations: readonly ReconciliationMigration[],
): readonly ReconciliationMigration[] | "ambiguous" | undefined {
  if (sourceFingerprint === targetFingerprint) return [];
  const bySource = new Map<string, ReconciliationMigration[]>();
  for (const migration of migrations) {
    const entries = bySource.get(migration.fromFingerprint) ?? [];
    entries.push(migration);
    bySource.set(migration.fromFingerprint, entries);
  }
  for (const entries of bySource.values()) {
    entries.sort((left, right) => left.toFingerprint < right.toFingerprint ? -1 : left.toFingerprint > right.toFingerprint ? 1 : 0);
  }
  const visit = (
    fingerprint: string,
    visited: ReadonlySet<string>,
  ): readonly (readonly ReconciliationMigration[])[] => {
    const paths: (readonly ReconciliationMigration[])[] = [];
    for (const migration of bySource.get(fingerprint) ?? []) {
      if (visited.has(migration.toFingerprint)) continue;
      if (migration.toFingerprint === targetFingerprint) {
        paths.push([migration]);
      } else {
        for (const next of visit(migration.toFingerprint, new Set([...visited, migration.toFingerprint]))) {
          paths.push([migration, ...next]);
          if (paths.length > 1) return paths;
        }
      }
      if (paths.length > 1) return paths;
    }
    return paths;
  };
  const paths = visit(sourceFingerprint, new Set([sourceFingerprint]));
  return paths.length > 1 ? "ambiguous" : paths[0];
}

function expectedForTransition(
  transition: ReconciliationTransition,
): ClassifiedRecord["kind"] | undefined {
  const fromIds = transitionSources(transition);
  const targetCount = transition.toItemIds.length;
  if (fromIds.length === 1 && targetCount === 1
    && transition.automaticStateAction === "preserve"
    && (transition.changeKind === "retained" || transition.changeKind === "rekey-1:1")
    && (transition.reconciliation === "identity-retained" || transition.reconciliation === "one-to-one-preserve")) {
    return "active";
  }
  if (fromIds.length === 1 && targetCount === 0
    && transition.automaticStateAction === "none"
    && transition.changeKind === "retired-1:0"
    && transition.reconciliation === "retire-to-orphan") {
    return "orphan";
  }
  if (transition.automaticStateAction === "none"
    && ((fromIds.length === 1 && targetCount > 1)
      || (fromIds.length > 1 && targetCount === 1)
      || transition.changeKind === "unresolved")) {
    return "conflict";
  }
  return undefined;
}

function reportFor(
  sourceFingerprint: string,
  targetFingerprint: string,
  steps: number,
  records: readonly ReconciliationRecord[],
  oldExplicitRecords: number,
  targetItemClasses: ReadonlyMap<string, "current-known" | "research"> | undefined,
  mappedTargetIds: ReadonlySet<string>,
): ReconciliationReport {
  const retained = records.filter((record) => record.resolution === "identity-retained").length;
  const migrated = records.filter((record) => record.resolution === "one-to-one-preserve").length;
  const retiredOrphans = records.filter((record) => record.resolution === "retire-to-orphan").length;
  const conflicts = records.filter((record) => record.disposition === "orphan-and-conflict").length;
  const unresolved = records.filter((record) => record.resolution === "requires-user-resolution").length;
  let newCurrentKnown = 0;
  let newResearch = 0;
  if (targetItemClasses !== undefined) {
    for (const [itemId, itemClass] of targetItemClasses) {
      if (mappedTargetIds.has(itemId)) continue;
      if (itemClass === "current-known") newCurrentKnown += 1;
      else newResearch += 1;
    }
  }
  return {
    sourceFingerprint,
    targetFingerprint,
    steps,
    records,
    accounting: {
      oldExplicitRecords,
      retained,
      migrated,
      retiredOrphans,
      conflicts,
      unresolved,
      newCurrentKnown,
      newResearch,
      // Conflict records are already the unresolved-conflict bucket. Keep the
      // `unresolved` count as a diagnostic, but never double-count it in the
      // conservation equation.
      accountedOldRecords: retained + migrated + retiredOrphans + conflicts,
      conservationSatisfied: oldExplicitRecords === retained + migrated + retiredOrphans + conflicts,
    },
  };
}

function transitionRecord(
  transition: ReconciliationTransition,
  state: PrivateItemState,
  kind: ClassifiedRecord["kind"],
): ClassifiedRecord {
  const fromIds = [...transitionSources(transition)].sort();
  const toIds = [...transition.toItemIds].sort();
  const resolution = kind === "active"
    ? (transition.changeKind === "retained" ? "identity-retained" : "one-to-one-preserve")
    : kind === "orphan" ? "retire-to-orphan" : "requires-user-resolution";
  const disposition = kind === "active"
    ? (resolution === "identity-retained" ? "active" : "migrated")
    : kind === "orphan" ? "orphan" : "orphan-and-conflict";
  return {
    record: {
      fromItemIds: fromIds,
      toItemIds: toIds,
      changeKind: transition.changeKind,
      automaticStateAction: transition.automaticStateAction,
      resolution,
      disposition,
    },
    state,
    kind,
  };
}

function unsupportedSource(state: PrivateState, targetFingerprint: string): ReconciliationResult {
  return fail("STATE_FINGERPRINT_UNSUPPORTED", {
    sourceFingerprint: state.catalogueFingerprint,
    targetFingerprint,
    steps: 0,
    records: [],
    accounting: {
      oldExplicitRecords: state.items.length,
      retained: 0,
      migrated: 0,
      retiredOrphans: 0,
      conflicts: 0,
      unresolved: 0,
      newCurrentKnown: 0,
      newResearch: 0,
      accountedOldRecords: 0,
      conservationSatisfied: state.items.length === 0,
    },
  });
}

/**
 * Reconcile a validated private state through a complete, producer-declared chain.
 * The function is pure: it never mutates input state, storage or migration data.
 */
export function reconcilePrivateState(
  input: PrivateState,
  targetFingerprint: string,
  context: ReconciliationContext,
): ReconciliationResult {
  if (!isObjectRecord(context)
    || (context.knownTargetItemIds !== undefined && typeof context.knownTargetItemIds.has !== "function")
    || (context.targetItemClasses !== undefined && typeof context.targetItemClasses[Symbol.iterator] !== "function")) {
    return fail("STATE_RECONCILIATION_BLOCKED");
  }
  const validated = validatePrivateState(input);
  if (!validated.ok || !isFingerprint(targetFingerprint)) {
    return fail("STATE_RECONCILIATION_BLOCKED");
  }
  const state = validated.value;
  if (state.catalogueFingerprint === targetFingerprint) {
    if (context.knownTargetItemIds !== undefined
      && state.items.some((item) => !context.knownTargetItemIds?.has(item.itemId))) {
      return fail("STATE_RECONCILIATION_BLOCKED");
    }
    const mappedTargetIds = new Set(state.items.map((item) => item.itemId));
    const withRecords = reportFor(state.catalogueFingerprint, targetFingerprint, 0, state.items.map((item) => ({
      fromItemIds: [item.itemId],
      toItemIds: [item.itemId],
      changeKind: "retained",
      automaticStateAction: "preserve",
      resolution: "identity-retained" as const,
      disposition: "active" as const,
    })), state.items.length, context.targetItemClasses, mappedTargetIds);
    return {
      ok: true,
      value: { state: { ...state, items: state.items.map((item) => cloneItem(item)) }, report: withRecords, orphans: [], conflicts: [] },
    };
  }

  const migrations = migrationList(context);
  if (migrations.some((migration) => !migrationIsStructurallyValid(migration))) {
    return fail("STATE_RECONCILIATION_BLOCKED");
  }
  const chain = findChain(state.catalogueFingerprint, targetFingerprint, migrations);
  if (chain === "ambiguous") return fail("STATE_RECONCILIATION_BLOCKED");
  if (chain === undefined || chain.length === 0) return unsupportedSource(state, targetFingerprint);

  let working = new Map<string, WorkingRecord>(state.items.map((item) => [item.itemId, { state: cloneItem(item), itemId: item.itemId }]));
  const orphaned: PrivateItemState[] = [];
  const conflicted: PrivateItemState[] = [];
  const reports: ReconciliationRecord[] = [];
  let blocked = false;

  for (const [stepIndex, migration] of chain.entries()) {
    const isFinalStep = stepIndex === chain.length - 1;
    const transitionMap = new Map<string, ReconciliationTransition>();
    for (const transition of migration.transitions) {
      for (const sourceId of transitionSources(transition)) transitionMap.set(sourceId, transition);
    }
    const next = new Map<string, WorkingRecord>();
    for (const current of [...working.values()].sort((left, right) => left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0)) {
      const transition = transitionMap.get(current.itemId);
      if (transition === undefined) {
        blocked = true;
        continue;
      }
      const kind = expectedForTransition(transition);
      if (kind === undefined) {
        blocked = true;
        continue;
      }
      const fromIds = transitionSources(transition);
      if (fromIds.length > 1 && fromIds.some((id) => !working.has(id))) {
        const classified = transitionRecord(transition, current.state, "conflict");
        reports.push(classified.record);
        conflicted.push(cloneItem(current.state));
        blocked = true;
        continue;
      }
      if (fromIds.length > 1) {
        // A many-to-one transition is always a conflict, never a partial merge.
        const classified = transitionRecord(transition, current.state, "conflict");
        reports.push(classified.record);
        conflicted.push(cloneItem(current.state));
        blocked = true;
        continue;
      }
      const classified = transitionRecord(transition, current.state, kind);
      // Intermediate one-to-one hops are implementation details of a
      // multi-step chain. Account an original state record exactly once at
      // the final hop (or immediately when it becomes an orphan/conflict).
      if (isFinalStep || kind !== "active") reports.push(classified.record);
      if (kind === "active") {
        const targetId = transition.toItemIds[0];
        if (isFinalStep && context.knownTargetItemIds !== undefined && !context.knownTargetItemIds.has(targetId)) {
          blocked = true;
          continue;
        }
        if (next.has(targetId)) {
          blocked = true;
          continue;
        }
        next.set(targetId, { state: cloneItem(current.state, targetId), itemId: targetId });
      } else if (kind === "orphan") {
        orphaned.push(cloneItem(current.state));
      } else {
        conflicted.push(cloneItem(current.state));
        blocked = true;
      }
    }
    working = next;
  }

  const mappedTargetIds = new Set(working.keys());
  const report = reportFor(state.catalogueFingerprint, targetFingerprint, chain.length, reports, state.items.length, context.targetItemClasses, mappedTargetIds);
  if (blocked || !report.accounting.conservationSatisfied || conflicted.length > 0 || report.accounting.unresolved > 0) {
    return fail("STATE_RECONCILIATION_BLOCKED", report);
  }
  const candidate: PrivateState = {
    schema: PRIVATE_STATE_SCHEMA,
    schemaVersion: PRIVATE_STATE_VERSION,
    datasetId: PRIVATE_DATASET_ID,
    catalogueFingerprint: targetFingerprint,
    items: [...working.values()].map((entry) => cloneItem(entry.state)).sort((left, right) => left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0),
  };
  return { ok: true, value: { state: candidate, report, orphans: orphaned, conflicts: [] } };
}

/** Alias kept for callers that name the operation after the collection domain. */
export const reconcileCollectionState = reconcilePrivateState;
