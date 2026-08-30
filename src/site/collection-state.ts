import type { PrivateStateRead } from './private-state.js';

type CollectionStatus = 'need' | 'ordered' | 'have' | 'skip';

interface PrivateItemState {
  readonly itemId: string;
  readonly status: CollectionStatus;
  readonly quantityOwned: number;
  readonly quantityOrdered: number;
  readonly note?: string;
}

interface PrivateState {
  readonly schema: 'snoredex-collection-state';
  readonly schemaVersion: '1.0.0';
  readonly datasetId: 'snoredex-data/snorlax-current-known';
  readonly catalogueFingerprint: string;
  readonly items: readonly PrivateItemState[];
}

interface PersistenceResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
}

interface OrderedStateStoreLike {
  read(): PersistenceResult<PrivateState | undefined>;
  unsaved(): PrivateState | undefined;
  readonly recoveryNeedsReview?: () => boolean;
  readonly reconcileUnsavedDraft?: (
    targetFingerprint: string,
    knownTargetItemIds: ReadonlySet<string>,
    reconciliation: CollectionReconciliationOptions,
  ) => PersistenceResult<void>;
  adoptUnsavedDraft(): PersistenceResult<PrivateState | undefined>;
  discardUnsavedDraft(): void;
  hasPendingNote(): boolean;
  saveImmediate(state: PrivateState): Promise<PersistenceResult<{ readonly skipped?: boolean }>>;
  scheduleNoteSave(state: PrivateState, scheduleFlush?: boolean): PersistenceResult<void>;
  flushNote(): Promise<PersistenceResult<{ readonly skipped?: boolean }>>;
}

interface StorageModule {
  readonly NOTE_AUTOSAVE_DELAY_MS: number;
  readonly getBrowserStorage: () => PersistenceResult<unknown>;
  readonly OrderedStateStore: new (storage: unknown) => OrderedStateStoreLike;
}

interface BrowserReconciliationModule {
  readonly reconcileBrowserState: (
    targetFingerprint: string,
    knownItemIds: ReadonlySet<string>,
    reconciliation: {
      readonly migrations: readonly unknown[];
      readonly knownSourceItemIds?: ReadonlySet<string>;
      readonly knownSourceItemIdsByFingerprint?: ReadonlyMap<string, ReadonlySet<string>>;
      readonly targetItemClasses?: ReadonlyMap<string, 'current-known' | 'research'>;
    },
  ) => Promise<{ readonly ok: boolean; readonly changed: boolean; readonly error?: string }>;
}

export interface CollectionReconciliationOptions {
  readonly migrations: readonly unknown[];
  readonly knownSourceItemIds?: ReadonlySet<string>;
  readonly knownSourceItemIdsByFingerprint?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly targetItemClasses?: ReadonlyMap<string, 'current-known' | 'research'>;
}

interface DomainModule {
  readonly applyStatusCommand: (
    itemId: string,
    current: PrivateItemState | undefined,
    status: CollectionStatus,
  ) => PersistenceResult<PrivateItemState | undefined>;
  readonly applyQuantityEdit: (
    itemId: string,
    current: PrivateItemState | undefined,
    quantityOwned: unknown,
    quantityOrdered: unknown,
  ) => PersistenceResult<PrivateItemState | undefined>;
  readonly applyNoteEdit: (
    itemId: string,
    current: PrivateItemState | undefined,
    note: unknown,
  ) => PersistenceResult<PrivateItemState | undefined>;
}

export type CollectionEditResult =
  | { readonly ok: true; readonly skipped?: boolean; readonly deferred?: boolean }
  | { readonly ok: false; readonly error: string; readonly deferred?: boolean };

export interface CollectionRecoverySummary {
  readonly itemIds: readonly string[];
  readonly noteItemIds: readonly string[];
}

export interface CollectionStateController {
  readonly available: true;
  readonly state: PrivateStateRead;
  readonly recovery: CollectionRecoverySummary | undefined;
  record(itemId: string): PrivateItemState | undefined;
  setStatus(itemId: string, status: CollectionStatus): Promise<CollectionEditResult>;
  setQuantities(itemId: string, quantityOwned: unknown, quantityOrdered: unknown): Promise<CollectionEditResult>;
  scheduleNote(itemId: string, note: string): CollectionEditResult;
  flushNote(): Promise<CollectionEditResult>;
  adoptRecovery(): Promise<CollectionEditResult>;
  discardRecovery(): CollectionEditResult;
  onChange(listener: () => void): () => void;
  onSave(listener: (itemId: string, result: CollectionEditResult) => void): () => void;
}

function emptyState(catalogueFingerprint: string): PrivateState {
  return {
    schema: 'snoredex-collection-state',
    schemaVersion: '1.0.0',
    datasetId: 'snoredex-data/snorlax-current-known',
    catalogueFingerprint,
    items: [],
  };
}

function failure(error: string): CollectionEditResult {
  return { ok: false, error };
}

function persistenceError(result: PersistenceResult<{ readonly skipped?: boolean }>): CollectionEditResult {
  return result.ok ? { ok: true, skipped: result.value?.skipped } : failure(result.error ?? 'STORAGE_WRITE_FAILED');
}

function deferredResult(result: CollectionEditResult): CollectionEditResult {
  return result.ok
    ? { ok: true, skipped: result.skipped, deferred: true }
    : { ok: false, error: result.error, deferred: true };
}

export class BrowserCollectionStateController implements CollectionStateController {
  public readonly available = true as const;
  private readonly store: OrderedStateStoreLike;
  private readonly domain: DomainModule;
  private readonly catalogueFingerprint: string;
  private readonly noteAutosaveDelay: number;
  private records = new Map<string, PrivateItemState>();
  private recoveryDraft: PrivateState | undefined;
  private hasActiveState = false;
  private listeners = new Set<() => void>();
  private saveListeners = new Set<(itemId: string, result: CollectionEditResult) => void>();
  private noteFlushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private noteFlushInFlight: Promise<CollectionEditResult> | undefined;
  private noteFlushInFlightGeneration: number | undefined;
  private noteFlushFollowUp: Promise<CollectionEditResult> | undefined;
  private pendingNoteItemId: string | undefined;
  private pendingNoteState: PrivateState | undefined;
  private pendingNoteGeneration: number | undefined;
  private noteGeneration = 0;
  private supersededNoteItemIds = new Set<string>();
  private immediateSaveGeneration = 0;
  private latestImmediateSaveGeneration = 0;
  private activeImmediateSaves = new Map<number, string>();
  private supersededImmediateItemIds = new Set<string>();

  public constructor(
    store: OrderedStateStoreLike,
    domain: DomainModule,
    noteAutosaveDelay: number,
    catalogueFingerprint: string,
    active: PrivateState | undefined,
  ) {
    this.store = store;
    this.domain = domain;
    this.noteAutosaveDelay = noteAutosaveDelay;
    this.catalogueFingerprint = catalogueFingerprint;
    this.hasActiveState = active !== undefined;
    this.recoveryDraft = store.unsaved();
    for (const record of active?.items ?? []) this.records.set(record.itemId, record);
  }

  public get state(): PrivateStateRead {
    const statuses = new Map<string, CollectionStatus>();
    for (const [itemId, record] of this.records) statuses.set(itemId, record.status);
    return { readable: true, hasActiveState: this.hasActiveState || this.records.size > 0, statuses };
  }

  public get recovery(): CollectionRecoverySummary | undefined {
    if (this.recoveryDraft === undefined) return undefined;
    const itemIds = this.recoveryDraft.items.map((record) => record.itemId);
    const noteItemIds = this.recoveryDraft.items
      .filter((record) => record.note !== undefined)
      .map((record) => record.itemId);
    return { itemIds, noteItemIds };
  }

  public record(itemId: string): PrivateItemState | undefined {
    return this.records.get(itemId);
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onSave(listener: (itemId: string, result: CollectionEditResult) => void): () => void {
    this.saveListeners.add(listener);
    return () => this.saveListeners.delete(listener);
  }

  public async setStatus(itemId: string, status: CollectionStatus): Promise<CollectionEditResult> {
    const result = this.domain.applyStatusCommand(itemId, this.records.get(itemId), status);
    if (!result.ok) return failure(result.error ?? 'IMPORT_INVALID_STATE_DATA');
    const pendingItemIds = new Set(this.supersededNoteItemIds);
    if (this.pendingNoteItemId !== undefined) pendingItemIds.add(this.pendingNoteItemId);
    this.setRecord(itemId, result.value);
    this.cancelNoteTimer();
    this.pendingNoteItemId = undefined;
    this.pendingNoteState = undefined;
    this.pendingNoteGeneration = undefined;
    this.supersededNoteItemIds.clear();
    const generation = this.beginImmediateSave(itemId, pendingItemIds);
    const outcome = persistenceError(await this.store.saveImmediate(this.stateForSave()));
    const settled = this.finishImmediateSave(generation, itemId, outcome);
    return settled ? outcome : deferredResult(outcome);
  }

  public async setQuantities(
    itemId: string,
    quantityOwned: unknown,
    quantityOrdered: unknown,
  ): Promise<CollectionEditResult> {
    const result = this.domain.applyQuantityEdit(itemId, this.records.get(itemId), quantityOwned, quantityOrdered);
    if (!result.ok) return failure(result.error ?? 'EDIT_INVALID_QUANTITY');
    const pendingItemIds = new Set(this.supersededNoteItemIds);
    if (this.pendingNoteItemId !== undefined) pendingItemIds.add(this.pendingNoteItemId);
    this.setRecord(itemId, result.value);
    this.cancelNoteTimer();
    this.pendingNoteItemId = undefined;
    this.pendingNoteState = undefined;
    this.pendingNoteGeneration = undefined;
    this.supersededNoteItemIds.clear();
    const generation = this.beginImmediateSave(itemId, pendingItemIds);
    const outcome = persistenceError(await this.store.saveImmediate(this.stateForSave()));
    const settled = this.finishImmediateSave(generation, itemId, outcome);
    return settled ? outcome : deferredResult(outcome);
  }

  public scheduleNote(itemId: string, note: string): CollectionEditResult {
    const result = this.domain.applyNoteEdit(itemId, this.records.get(itemId), note);
    if (!result.ok) return failure(result.error ?? 'EDIT_INVALID_NOTE');
    if (this.pendingNoteItemId !== undefined) this.supersededNoteItemIds.add(this.pendingNoteItemId);
    this.setRecord(itemId, result.value);
    const generation = ++this.noteGeneration;
    this.pendingNoteItemId = itemId;
    this.pendingNoteGeneration = generation;
    const pendingState = this.stateForSave();
    this.pendingNoteState = pendingState;
    const scheduled = this.store.scheduleNoteSave(pendingState, false);
    if (!scheduled.ok) {
      const outcome = failure(scheduled.error ?? 'STORAGE_WRITE_FAILED');
      this.notifySave(itemId, outcome);
      this.notifySuperseded(outcome, itemId);
    }
    this.cancelNoteTimer();
    this.noteFlushTimer = globalThis.setTimeout(() => {
      this.noteFlushTimer = undefined;
      void this.flushNote();
    }, this.noteAutosaveDelay + 10);
    return scheduled.ok ? { ok: true } : failure(scheduled.error ?? 'STORAGE_WRITE_FAILED');
  }

  public flushNote(): Promise<CollectionEditResult> {
    this.cancelNoteTimer();
    if (this.noteFlushInFlight !== undefined) {
      if (this.noteFlushInFlightGeneration === this.pendingNoteGeneration || this.pendingNoteGeneration === undefined) {
        return this.noteFlushInFlight;
      }
      if (this.noteFlushFollowUp === undefined) {
        const inFlight = this.noteFlushInFlight;
        this.noteFlushFollowUp = inFlight.then(() => {
          this.noteFlushFollowUp = undefined;
          return this.flushNote();
        });
      }
      return this.noteFlushFollowUp;
    }
    const generation = this.pendingNoteGeneration;
    const operation = this.flushNoteInternal();
    this.noteFlushInFlight = operation;
    this.noteFlushInFlightGeneration = generation;
    void operation.then(
      () => {
        if (this.noteFlushInFlight === operation) {
          this.noteFlushInFlight = undefined;
          this.noteFlushInFlightGeneration = undefined;
        }
      },
      () => {
        if (this.noteFlushInFlight === operation) {
          this.noteFlushInFlight = undefined;
          this.noteFlushInFlightGeneration = undefined;
        }
      },
    );
    return operation;
  }

  private async flushNoteInternal(): Promise<CollectionEditResult> {
    const itemId = this.pendingNoteItemId;
    const pendingState = this.pendingNoteState;
    if (this.pendingNoteState !== undefined && !this.store.hasPendingNote()) {
      const scheduled = this.store.scheduleNoteSave(this.pendingNoteState, false);
      if (!scheduled.ok) {
        const outcome = failure(scheduled.error ?? 'STORAGE_WRITE_FAILED');
        if (itemId !== undefined) this.notifySave(itemId, outcome);
        this.notifySuperseded(outcome, itemId);
        return outcome;
      }
    }
    const outcome = persistenceError(await this.store.flushNote());
    const isCurrent = this.pendingNoteItemId === itemId && this.pendingNoteState === pendingState;
    if (isCurrent) {
      const itemIds = new Set(this.supersededNoteItemIds);
      if (outcome.ok && !outcome.skipped) {
        this.supersededNoteItemIds.clear();
        for (const pendingItemId of this.supersededImmediateItemIds) itemIds.add(pendingItemId);
        this.supersededImmediateItemIds.clear();
        this.pendingNoteItemId = undefined;
        this.pendingNoteState = undefined;
        this.pendingNoteGeneration = undefined;
      }
      if (itemId !== undefined) itemIds.add(itemId);
      for (const pendingItemId of itemIds) this.notifySave(pendingItemId, outcome);
    } else if (itemId !== undefined && this.pendingNoteItemId === undefined && this.supersededNoteItemIds.has(itemId)) {
      this.supersededNoteItemIds.delete(itemId);
      this.notifySave(itemId, outcome);
    }
    return outcome;
  }

  public async adoptRecovery(): Promise<CollectionEditResult> {
    const current = this.recoveryDraft;
    if (current === undefined) return { ok: true, skipped: true };
    const adopted = this.store.adoptUnsavedDraft();
    if (!adopted.ok) return failure(adopted.error ?? 'LOCAL_STATE_UNREADABLE');
    const draft = adopted.value ?? current;
    const outcome = persistenceError(await this.store.saveImmediate(draft));
    if (!outcome.ok) return outcome;
    this.cancelNoteTimer();
    this.pendingNoteItemId = undefined;
    this.pendingNoteState = undefined;
    this.pendingNoteGeneration = undefined;
    this.supersededNoteItemIds.clear();
    this.records = new Map(draft.items.map((record) => [record.itemId, record]));
    this.hasActiveState = this.records.size > 0;
    this.recoveryDraft = undefined;
    this.notify();
    return outcome;
  }

  public discardRecovery(): CollectionEditResult {
    if (this.recoveryDraft === undefined) return { ok: true, skipped: true };
    this.store.discardUnsavedDraft();
    if (this.store.unsaved() !== undefined) return failure('STORAGE_WRITE_FAILED');
    this.recoveryDraft = undefined;
    this.notify();
    return { ok: true };
  }

  private notifySuperseded(result: CollectionEditResult, excludedItemId?: string): void {
    for (const itemId of this.supersededNoteItemIds) {
      if (itemId !== excludedItemId) this.notifySave(itemId, result);
    }
    if (result.ok) this.supersededNoteItemIds.clear();
  }

  private beginImmediateSave(itemId: string, additionalItemIds: Iterable<string> = []): number {
    const generation = ++this.immediateSaveGeneration;
    this.latestImmediateSaveGeneration = generation;
    for (const activeItemId of this.activeImmediateSaves.values()) this.supersededImmediateItemIds.add(activeItemId);
    for (const additionalItemId of additionalItemIds) {
      if (additionalItemId !== itemId) this.supersededImmediateItemIds.add(additionalItemId);
    }
    this.activeImmediateSaves.set(generation, itemId);
    return generation;
  }

  private finishImmediateSave(generation: number, itemId: string, result: CollectionEditResult): boolean {
    this.activeImmediateSaves.delete(generation);
    if (generation !== this.latestImmediateSaveGeneration) return false;
    if (result.ok && result.skipped) return true;
    const itemIds = new Set(this.supersededImmediateItemIds);
    itemIds.add(itemId);
    if (result.ok) this.supersededImmediateItemIds.clear();
    else {
      this.supersededImmediateItemIds.clear();
      for (const pendingItemId of itemIds) this.supersededImmediateItemIds.add(pendingItemId);
    }
    for (const pendingItemId of itemIds) this.notifySave(pendingItemId, result);
    return true;
  }

  private setRecord(itemId: string, record: PrivateItemState | undefined): void {
    if (record === undefined) this.records.delete(itemId);
    else this.records.set(itemId, record);
    this.hasActiveState = this.records.size > 0;
    this.notify();
  }

  private stateForSave(): PrivateState {
    return { ...emptyState(this.catalogueFingerprint), items: [...this.records.values()] };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private notifySave(itemId: string, result: CollectionEditResult): void {
    for (const listener of this.saveListeners) listener(itemId, result);
  }

  private cancelNoteTimer(): void {
    if (this.noteFlushTimer === undefined) return;
    globalThis.clearTimeout(this.noteFlushTimer);
    this.noteFlushTimer = undefined;
  }
}

/** Build a writable controller only when the browser exposes the ordered state authority. */
export async function createCollectionStateController(
  catalogueFingerprint: string,
  knownTrackableItemIds: ReadonlySet<string>,
  reconciliation?: CollectionReconciliationOptions,
): Promise<CollectionStateController | undefined> {
  try {
    if (reconciliation !== undefined) {
      const reconciliationModule =
        // @ts-expect-error The runtime-relative module is emitted by the separate state build.
        (await import('./state/browser-reconciliation.js')) as BrowserReconciliationModule;
      const migrated = await reconciliationModule.reconcileBrowserState(
        catalogueFingerprint,
        knownTrackableItemIds,
        reconciliation,
      );
      if (!migrated.ok) return undefined;
    }
    const [storageModule, domainModule] = await Promise.all([
      // @ts-expect-error The runtime-relative module is emitted by the separate state build.
      import('./state/storage.js') as Promise<StorageModule>,
      // @ts-expect-error The runtime-relative module is emitted by the separate state build.
      import('./state/domain.js') as Promise<DomainModule>,
    ]);
    const storage = storageModule.getBrowserStorage();
    if (!storage.ok) return undefined;
    const store = new storageModule.OrderedStateStore(storage.value);
    const persisted = store.read();
    if (!persisted.ok) return undefined;
    if (reconciliation !== undefined && store.reconcileUnsavedDraft !== undefined) {
      if (!store.reconcileUnsavedDraft(catalogueFingerprint, knownTrackableItemIds, reconciliation).ok)
        return undefined;
    }
    const active = persisted.value;
    if (active !== undefined && active.catalogueFingerprint !== catalogueFingerprint) return undefined;
    if (active !== undefined && active.items.some((item) => !knownTrackableItemIds.has(item.itemId))) return undefined;
    const recovery = store.unsaved();
    const recoveryNeedsReview = store.recoveryNeedsReview?.() ?? false;
    if (!recoveryNeedsReview && recovery !== undefined && recovery.catalogueFingerprint !== catalogueFingerprint)
      return undefined;
    if (
      !recoveryNeedsReview &&
      recovery !== undefined &&
      recovery.items.some((item) => !knownTrackableItemIds.has(item.itemId))
    )
      return undefined;
    return new BrowserCollectionStateController(
      store,
      domainModule,
      storageModule.NOTE_AUTOSAVE_DELAY_MS,
      catalogueFingerprint,
      active,
    );
  } catch {
    return undefined;
  }
}
