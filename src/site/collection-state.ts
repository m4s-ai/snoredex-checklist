import type { PrivateStateRead } from "./private-state.js";

type CollectionStatus = "need" | "ordered" | "have" | "skip";

interface PrivateItemState {
  readonly itemId: string;
  readonly status: CollectionStatus;
  readonly quantityOwned: number;
  readonly quantityOrdered: number;
  readonly note?: string;
}

interface PrivateState {
  readonly schema: "snoredex-collection-state";
  readonly schemaVersion: "1.0.0";
  readonly datasetId: "snoredex-data/snorlax-current-known";
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
  saveImmediate(state: PrivateState): Promise<PersistenceResult<{ readonly skipped?: boolean }>>;
  scheduleNoteSave(state: PrivateState): PersistenceResult<void>;
  flushNote(): Promise<PersistenceResult<{ readonly skipped?: boolean }>>;
}

interface StorageModule {
  readonly NOTE_AUTOSAVE_DELAY_MS: number;
  readonly getBrowserStorage: () => PersistenceResult<unknown>;
  readonly OrderedStateStore: new (storage: unknown) => OrderedStateStoreLike;
}

interface DomainModule {
  readonly applyStatusCommand: (itemId: string, current: PrivateItemState | undefined, status: CollectionStatus) => PersistenceResult<PrivateItemState | undefined>;
  readonly applyQuantityEdit: (itemId: string, current: PrivateItemState | undefined, quantityOwned: unknown, quantityOrdered: unknown) => PersistenceResult<PrivateItemState | undefined>;
  readonly applyNoteEdit: (itemId: string, current: PrivateItemState | undefined, note: unknown) => PersistenceResult<PrivateItemState | undefined>;
}

const STORAGE_MODULE = "./state/storage.js";
const DOMAIN_MODULE = "./state/domain.js";

export type CollectionEditResult =
  | { readonly ok: true; readonly skipped?: boolean }
  | { readonly ok: false; readonly error: string };

export interface CollectionStateController {
  readonly available: true;
  readonly state: PrivateStateRead;
  record(itemId: string): PrivateItemState | undefined;
  setStatus(itemId: string, status: CollectionStatus): Promise<CollectionEditResult>;
  setQuantities(itemId: string, quantityOwned: unknown, quantityOrdered: unknown): Promise<CollectionEditResult>;
  scheduleNote(itemId: string, note: string): CollectionEditResult;
  flushNote(): Promise<CollectionEditResult>;
  onChange(listener: () => void): () => void;
  onSave(listener: (itemId: string, result: CollectionEditResult) => void): () => void;
}

function emptyState(catalogueFingerprint: string): PrivateState {
  return {
    schema: "snoredex-collection-state",
    schemaVersion: "1.0.0",
    datasetId: "snoredex-data/snorlax-current-known",
    catalogueFingerprint,
    items: [],
  };
}

function failure(error: string): CollectionEditResult {
  return { ok: false, error };
}

function persistenceError(result: PersistenceResult<{ readonly skipped?: boolean }>): CollectionEditResult {
  return result.ok ? { ok: true, skipped: result.value?.skipped } : failure(result.error ?? "STORAGE_WRITE_FAILED");
}

class BrowserCollectionStateController implements CollectionStateController {
  public readonly available = true as const;
  private readonly store: OrderedStateStoreLike;
  private readonly domain: DomainModule;
  private readonly catalogueFingerprint: string;
  private readonly noteAutosaveDelay: number;
  private records = new Map<string, PrivateItemState>();
  private hasActiveState = false;
  private listeners = new Set<() => void>();
  private saveListeners = new Set<(itemId: string, result: CollectionEditResult) => void>();
  private noteFlushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private pendingNoteItemId: string | undefined;

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
    for (const record of active?.items ?? []) this.records.set(record.itemId, record);
  }

  public get state(): PrivateStateRead {
    const statuses = new Map<string, CollectionStatus>();
    for (const [itemId, record] of this.records) statuses.set(itemId, record.status);
    return { readable: true, hasActiveState: this.hasActiveState || this.records.size > 0, statuses };
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
    if (!result.ok) return failure(result.error ?? "IMPORT_INVALID_STATE_DATA");
    this.setRecord(itemId, result.value);
    this.cancelNoteTimer();
    this.pendingNoteItemId = undefined;
    const outcome = persistenceError(await this.store.saveImmediate(this.stateForSave()));
    this.notifySave(itemId, outcome);
    return outcome;
  }

  public async setQuantities(itemId: string, quantityOwned: unknown, quantityOrdered: unknown): Promise<CollectionEditResult> {
    const result = this.domain.applyQuantityEdit(itemId, this.records.get(itemId), quantityOwned, quantityOrdered);
    if (!result.ok) return failure(result.error ?? "EDIT_INVALID_QUANTITY");
    this.setRecord(itemId, result.value);
    this.cancelNoteTimer();
    this.pendingNoteItemId = undefined;
    const outcome = persistenceError(await this.store.saveImmediate(this.stateForSave()));
    this.notifySave(itemId, outcome);
    return outcome;
  }

  public scheduleNote(itemId: string, note: string): CollectionEditResult {
    const result = this.domain.applyNoteEdit(itemId, this.records.get(itemId), note);
    if (!result.ok) return failure(result.error ?? "EDIT_INVALID_NOTE");
    this.setRecord(itemId, result.value);
    this.pendingNoteItemId = itemId;
    const scheduled = this.store.scheduleNoteSave(this.stateForSave());
    if (!scheduled.ok) {
      this.pendingNoteItemId = undefined;
      const outcome = failure(scheduled.error ?? "STORAGE_WRITE_FAILED");
      this.notifySave(itemId, outcome);
      return outcome;
    }
    this.cancelNoteTimer();
    this.noteFlushTimer = globalThis.setTimeout(() => {
      this.noteFlushTimer = undefined;
      void this.flushNote();
    }, this.noteAutosaveDelay + 10);
    return { ok: true };
  }

  public async flushNote(): Promise<CollectionEditResult> {
    this.cancelNoteTimer();
    const itemId = this.pendingNoteItemId;
    const outcome = persistenceError(await this.store.flushNote());
    this.pendingNoteItemId = undefined;
    if (itemId !== undefined) this.notifySave(itemId, outcome);
    return outcome;
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
): Promise<CollectionStateController | undefined> {
  try {
    const [storageModule, domainModule] = await Promise.all([
      import(STORAGE_MODULE) as Promise<StorageModule>,
      import(DOMAIN_MODULE) as Promise<DomainModule>,
    ]);
    const storage = storageModule.getBrowserStorage();
    if (!storage.ok) return undefined;
    const store = new storageModule.OrderedStateStore(storage.value);
    const persisted = store.read();
    if (!persisted.ok) return undefined;
    const active = persisted.value;
    if (active !== undefined && active.catalogueFingerprint !== catalogueFingerprint) return undefined;
    if (active !== undefined && active.items.some((item) => !knownTrackableItemIds.has(item.itemId))) return undefined;
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
