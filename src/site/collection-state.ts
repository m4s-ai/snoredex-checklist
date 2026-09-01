import type { PrivateStateRead } from './private-state.js';

export type CollectionStatus = 'need' | 'ordered' | 'have' | 'skip';

export interface PrivateItemState {
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
  { readonly ok: true; readonly skipped?: boolean } | { readonly ok: false; readonly error: string };

export type CollectionSavePhase = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed' | 'conflict';

export interface CollectionItemEditSnapshot {
  readonly itemId: string;
  readonly revision: number;
  readonly editingBlocked: boolean;
  readonly confirmed: PrivateItemState | undefined;
  readonly status: CollectionStatus;
  readonly quantityOwned: string;
  readonly quantityOrdered: string;
  readonly note?: string;
  readonly invalidQuantityFields: readonly ('owned' | 'ordered')[];
  readonly validationError?: 'EDIT_INVALID_QUANTITY';
  readonly save: {
    readonly phase: CollectionSavePhase;
    readonly error?: string;
    readonly retryable: boolean;
  };
}

export interface CollectionRecoverySummary {
  readonly itemIds: readonly string[];
  readonly noteItemIds: readonly string[];
  readonly adoptable: boolean;
}

export interface CollectionStateController {
  readonly available: true;
  readonly state: PrivateStateRead;
  readonly recovery: CollectionRecoverySummary | undefined;
  item(itemId: string): CollectionItemEditSnapshot;
  setStatus(itemId: string, status: CollectionStatus): Promise<CollectionEditResult>;
  setQuantityDraft(itemId: string, quantityOwned: string, quantityOrdered: string): CollectionEditResult;
  commitQuantities(itemId: string): Promise<CollectionEditResult>;
  scheduleNote(itemId: string, note: string): CollectionEditResult;
  flushNote(): Promise<CollectionEditResult>;
  retry(itemId: string): Promise<CollectionEditResult>;
  adoptRecovery(): Promise<CollectionEditResult>;
  discardRecovery(): CollectionEditResult;
  onChange(listener: (itemId?: string) => void): () => void;
}

type EditField = 'collection' | 'note';

interface ItemVersions {
  collection: number;
  note: number;
}

interface FieldFailure {
  readonly error: string;
  readonly revision: number;
  readonly operationId: number;
}

interface ItemEditMeta {
  quantityOwned: string;
  quantityOrdered: string;
  noteDraft?: string;
  invalidQuantityFields: readonly ('owned' | 'ordered')[];
  versions: ItemVersions;
  failures: Partial<Record<EditField, FieldFailure>>;
  lastSavedOperation?: number;
}

interface SaveOperation {
  readonly id: number;
  readonly records: ReadonlyMap<string, PrivateItemState>;
  readonly state: PrivateState;
  readonly versions: ReadonlyMap<string, ItemVersions>;
  readonly affected: ReadonlyMap<string, ReadonlySet<EditField>>;
}

interface PendingNoteSave {
  readonly state: PrivateState;
  readonly records: ReadonlyMap<string, PrivateItemState>;
  readonly versions: ReadonlyMap<string, ItemVersions>;
  readonly affected: ReadonlyMap<string, ReadonlySet<EditField>>;
  readonly scheduled: boolean;
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

function persistenceResult(result: PersistenceResult<{ readonly skipped?: boolean }>): CollectionEditResult {
  return result.ok ? { ok: true, skipped: result.value?.skipped } : failure(result.error ?? 'STORAGE_WRITE_FAILED');
}

function expandedRecord(itemId: string, record: PrivateItemState | undefined): PrivateItemState {
  return record ?? { itemId, status: 'need', quantityOwned: 0, quantityOrdered: 0 };
}

function sameCollection(left: PrivateItemState, right: PrivateItemState): boolean {
  return (
    left.status === right.status &&
    left.quantityOwned === right.quantityOwned &&
    left.quantityOrdered === right.quantityOrdered
  );
}

function sameEditField(field: EditField, left: PrivateItemState, right: PrivateItemState): boolean {
  return field === 'collection' ? sameCollection(left, right) : left.note === right.note;
}

function parseQuantity(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 9_999 ? parsed : undefined;
}

function invalidQuantityFields(quantityOwned: string, quantityOrdered: string): readonly ('owned' | 'ordered')[] {
  const invalid: ('owned' | 'ordered')[] = [];
  if (parseQuantity(quantityOwned) === undefined) invalid.push('owned');
  if (parseQuantity(quantityOrdered) === undefined) invalid.push('ordered');
  return invalid;
}

export class BrowserCollectionStateController implements CollectionStateController {
  public readonly available = true as const;
  private readonly store: OrderedStateStoreLike;
  private readonly domain: DomainModule;
  private readonly catalogueFingerprint: string;
  private readonly noteAutosaveDelay: number;
  private records = new Map<string, PrivateItemState>();
  private confirmedRecords = new Map<string, PrivateItemState>();
  private edits = new Map<string, ItemEditMeta>();
  private recoveryDraft: PrivateState | undefined;
  private readonly recoveryIsReviewOnly: boolean;
  private hasActiveState = false;
  private listeners = new Set<(itemId?: string) => void>();
  private activeOperations = new Map<number, SaveOperation>();
  private pendingNote: PendingNoteSave | undefined;
  private noteFlushTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private nextRevision = 0;
  private nextOperationId = 0;
  private lastConfirmedOperationId = 0;
  private lastSettledOperationId = 0;
  private commitUncertain = false;
  private recoveryActionPending = false;

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
    this.recoveryIsReviewOnly = store.recoveryNeedsReview?.() ?? false;
    for (const record of active?.items ?? []) {
      this.records.set(record.itemId, record);
      this.confirmedRecords.set(record.itemId, record);
    }
  }

  public get state(): PrivateStateRead {
    const statuses = new Map<string, CollectionStatus>();
    for (const [itemId, record] of this.confirmedRecords) statuses.set(itemId, record.status);
    return { readable: true, hasActiveState: this.hasActiveState, statuses };
  }

  public get recovery(): CollectionRecoverySummary | undefined {
    if (this.recoveryDraft === undefined) return undefined;
    const itemIds = this.recoveryDraft.items.map((record) => record.itemId);
    const noteItemIds = this.recoveryDraft.items
      .filter((record) => record.note !== undefined)
      .map((record) => record.itemId);
    return { itemIds, noteItemIds, adoptable: !this.recoveryIsReviewOnly };
  }

  public item(itemId: string): CollectionItemEditSnapshot {
    const record = expandedRecord(itemId, this.records.get(itemId));
    const meta = this.editMeta(itemId);
    const failures = Object.values(meta.failures).filter((value): value is FieldFailure => value !== undefined);
    const conflict = this.commitUncertain
      ? 'STORAGE_COMMIT_UNCERTAIN'
      : failures.find((entry) => entry.error === 'STORAGE_COMMIT_UNCERTAIN')?.error;
    const latestFailure = failures.sort((left, right) => right.operationId - left.operationId)[0];
    const saving = this.isSaving(itemId, meta) || this.isPendingNote(itemId, meta);
    const dirty =
      meta.invalidQuantityFields.length > 0 ||
      meta.quantityOwned !== String(record.quantityOwned) ||
      meta.quantityOrdered !== String(record.quantityOrdered) ||
      meta.noteDraft !== record.note ||
      !sameCollection(record, expandedRecord(itemId, this.confirmedRecords.get(itemId))) ||
      record.note !== this.confirmedRecords.get(itemId)?.note;
    const phase: CollectionSavePhase = conflict
      ? 'conflict'
      : saving
        ? 'saving'
        : latestFailure
          ? 'failed'
          : dirty
            ? 'dirty'
            : meta.lastSavedOperation === undefined
              ? 'clean'
              : 'saved';
    const error = conflict ?? latestFailure?.error;
    return {
      itemId,
      revision: Math.max(meta.versions.collection, meta.versions.note),
      editingBlocked: this.editBlockError() !== undefined,
      confirmed: this.confirmedRecords.get(itemId),
      status: record.status,
      quantityOwned: meta.quantityOwned,
      quantityOrdered: meta.quantityOrdered,
      ...(meta.noteDraft === undefined ? {} : { note: meta.noteDraft }),
      invalidQuantityFields: meta.invalidQuantityFields,
      ...(meta.invalidQuantityFields.length === 0 ? {} : { validationError: 'EDIT_INVALID_QUANTITY' as const }),
      save: { phase, ...(error === undefined ? {} : { error }), retryable: phase === 'failed' },
    };
  }

  public onChange(listener: (itemId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async setStatus(itemId: string, status: CollectionStatus): Promise<CollectionEditResult> {
    const blocked = this.editBlockError();
    if (blocked !== undefined) {
      this.notify(itemId);
      return failure(blocked);
    }
    const result = this.domain.applyStatusCommand(itemId, this.records.get(itemId), status);
    if (!result.ok) return failure(result.error ?? 'IMPORT_INVALID_STATE_DATA');
    const meta = this.editMeta(itemId);
    this.setRecord(itemId, result.value);
    meta.versions.collection = ++this.nextRevision;
    this.clearFailureAfterEdit(meta, 'collection');
    const record = expandedRecord(itemId, result.value);
    if (!meta.invalidQuantityFields.includes('owned')) meta.quantityOwned = String(record.quantityOwned);
    if (!meta.invalidQuantityFields.includes('ordered')) meta.quantityOrdered = String(record.quantityOrdered);
    return this.saveImmediate();
  }

  public setQuantityDraft(itemId: string, quantityOwned: string, quantityOrdered: string): CollectionEditResult {
    const blocked = this.editBlockError();
    if (blocked !== undefined) {
      this.notify(itemId);
      return failure(blocked);
    }
    const meta = this.editMeta(itemId);
    if (meta.quantityOwned === quantityOwned && meta.quantityOrdered === quantityOrdered) {
      return meta.invalidQuantityFields.length === 0 ? { ok: true, skipped: true } : failure('EDIT_INVALID_QUANTITY');
    }
    meta.quantityOwned = quantityOwned;
    meta.quantityOrdered = quantityOrdered;
    meta.invalidQuantityFields = invalidQuantityFields(quantityOwned, quantityOrdered);
    meta.versions.collection = ++this.nextRevision;
    this.notify(itemId);
    return meta.invalidQuantityFields.length === 0 ? { ok: true } : failure('EDIT_INVALID_QUANTITY');
  }

  public async commitQuantities(itemId: string): Promise<CollectionEditResult> {
    const blocked = this.editBlockError();
    if (blocked !== undefined) {
      this.notify(itemId);
      return failure(blocked);
    }
    const meta = this.editMeta(itemId);
    const quantityOwned = parseQuantity(meta.quantityOwned);
    const quantityOrdered = parseQuantity(meta.quantityOrdered);
    if (quantityOwned === undefined || quantityOrdered === undefined) {
      const invalid = invalidQuantityFields(meta.quantityOwned, meta.quantityOrdered);
      if (invalid.join() !== meta.invalidQuantityFields.join()) {
        meta.invalidQuantityFields = invalid;
        this.notify(itemId);
      }
      return failure('EDIT_INVALID_QUANTITY');
    }
    const result = this.domain.applyQuantityEdit(itemId, this.records.get(itemId), quantityOwned, quantityOrdered);
    if (!result.ok) return failure(result.error ?? 'EDIT_INVALID_QUANTITY');
    const previous = expandedRecord(itemId, this.records.get(itemId));
    const next = expandedRecord(itemId, result.value);
    this.setRecord(itemId, result.value);
    meta.quantityOwned = String(next.quantityOwned);
    meta.quantityOrdered = String(next.quantityOrdered);
    meta.invalidQuantityFields = [];
    if (!sameCollection(previous, next)) meta.versions.collection = ++this.nextRevision;
    const confirmed = expandedRecord(itemId, this.confirmedRecords.get(itemId));
    if (!this.fieldNeedsPersistence(itemId, 'collection', next, confirmed, meta)) {
      this.clearFailureAfterEdit(meta, 'collection');
      this.notify(itemId);
      return { ok: true, skipped: true };
    }
    return this.saveImmediate();
  }

  public scheduleNote(itemId: string, note: string): CollectionEditResult {
    const blocked = this.editBlockError();
    if (blocked !== undefined) {
      this.notify(itemId);
      return failure(blocked);
    }
    const result = this.domain.applyNoteEdit(itemId, this.records.get(itemId), note);
    if (!result.ok) return failure(result.error ?? 'EDIT_INVALID_NOTE');
    const previousNote = this.records.get(itemId)?.note;
    this.setRecord(itemId, result.value);
    const meta = this.editMeta(itemId);
    meta.noteDraft = note;
    if (previousNote !== result.value?.note || meta.noteDraft !== previousNote) {
      meta.versions.note = ++this.nextRevision;
    }
    this.clearFailureAfterEdit(meta, 'note');
    const pending = this.pendingSnapshot();
    const scheduled = this.store.scheduleNoteSave(pending.state, false);
    this.pendingNote = { ...pending, scheduled: scheduled.ok };
    if (!scheduled.ok) {
      const error = scheduled.error ?? 'STORAGE_WRITE_FAILED';
      if (this.latchCommitUncertain(error)) {
        this.notify();
        return failure(error);
      }
      this.setFailure(itemId, 'note', error, meta.versions.note, ++this.nextOperationId);
    }
    this.scheduleNoteFlush();
    this.notifyAffected(pending.affected);
    return scheduled.ok ? { ok: true } : failure(scheduled.error ?? 'STORAGE_WRITE_FAILED');
  }

  public async flushNote(): Promise<CollectionEditResult> {
    this.cancelNoteTimer();
    const blocked = this.editBlockError();
    if (blocked !== undefined) {
      this.pendingNote = undefined;
      this.notify();
      return failure(blocked);
    }
    const pending = this.pendingNote;
    if (pending === undefined) return { ok: true, skipped: true };
    this.pendingNote = undefined;
    const operation = this.beginOperation(pending);
    if (!pending.scheduled || !this.store.hasPendingNote()) {
      const scheduled = this.store.scheduleNoteSave(pending.state, false);
      if (!scheduled.ok) {
        const outcome = failure(scheduled.error ?? 'STORAGE_WRITE_FAILED');
        this.finishOperation(operation, outcome);
        return outcome;
      }
    }
    const outcome = persistenceResult(await this.store.flushNote());
    this.finishOperation(operation, outcome);
    return outcome;
  }

  public retry(itemId: string): Promise<CollectionEditResult> {
    const blocked = this.editBlockError();
    if (blocked !== undefined) {
      this.notify(itemId);
      return Promise.resolve(failure(blocked));
    }
    const snapshot = this.item(itemId);
    if (!snapshot.save.retryable) return Promise.resolve({ ok: true, skipped: true });
    const meta = this.editMeta(itemId);
    const current = expandedRecord(itemId, this.records.get(itemId));
    const quantityOwned = parseQuantity(meta.quantityOwned);
    const quantityOrdered = parseQuantity(meta.quantityOrdered);
    const quantityChanged =
      meta.quantityOwned !== String(current.quantityOwned) || meta.quantityOrdered !== String(current.quantityOrdered);
    if (quantityChanged && quantityOwned !== undefined && quantityOrdered !== undefined) {
      const result = this.domain.applyQuantityEdit(itemId, this.records.get(itemId), quantityOwned, quantityOrdered);
      if (!result.ok) return Promise.resolve(failure(result.error ?? 'EDIT_INVALID_QUANTITY'));
      const next = expandedRecord(itemId, result.value);
      this.setRecord(itemId, result.value);
      meta.quantityOwned = String(next.quantityOwned);
      meta.quantityOrdered = String(next.quantityOrdered);
      if (!sameCollection(current, next)) meta.versions.collection = ++this.nextRevision;
    }
    return this.saveImmediate();
  }

  public async adoptRecovery(): Promise<CollectionEditResult> {
    if (this.commitUncertain) return failure('STORAGE_COMMIT_UNCERTAIN');
    if (this.recoveryActionPending) return failure('RECOVERY_ACTION_PENDING');
    const current = this.recoveryDraft;
    if (current === undefined) return { ok: true, skipped: true };
    this.recoveryActionPending = true;
    try {
      const adopted = this.store.adoptUnsavedDraft();
      if (!adopted.ok) {
        const error = adopted.error ?? 'LOCAL_STATE_UNREADABLE';
        this.latchCommitUncertain(error);
        this.notify();
        return failure(error);
      }
      const draft = adopted.value ?? current;
      const outcome = persistenceResult(await this.store.saveImmediate(draft));
      if (!outcome.ok) {
        this.latchCommitUncertain(outcome.error);
        this.notify();
        return outcome;
      }
      this.cancelNoteTimer();
      this.pendingNote = undefined;
      this.activeOperations.clear();
      this.records = new Map(draft.items.map((record) => [record.itemId, record]));
      this.confirmedRecords = new Map(this.records);
      this.edits.clear();
      this.hasActiveState = true;
      this.recoveryDraft = undefined;
      this.notify();
      return outcome;
    } finally {
      this.recoveryActionPending = false;
    }
  }

  public discardRecovery(): CollectionEditResult {
    if (this.commitUncertain) return failure('STORAGE_COMMIT_UNCERTAIN');
    if (this.recoveryActionPending) return failure('RECOVERY_ACTION_PENDING');
    if (this.recoveryDraft === undefined) return { ok: true, skipped: true };
    this.store.discardUnsavedDraft();
    if (this.store.unsaved() !== undefined) return failure('STORAGE_WRITE_FAILED');
    this.recoveryDraft = undefined;
    this.notify();
    return { ok: true };
  }

  private editMeta(itemId: string): ItemEditMeta {
    let meta = this.edits.get(itemId);
    if (meta !== undefined) return meta;
    const record = expandedRecord(itemId, this.records.get(itemId));
    meta = {
      quantityOwned: String(record.quantityOwned),
      quantityOrdered: String(record.quantityOrdered),
      ...(record.note === undefined ? {} : { noteDraft: record.note }),
      invalidQuantityFields: [],
      versions: { collection: 0, note: 0 },
      failures: {},
    };
    this.edits.set(itemId, meta);
    return meta;
  }

  private setRecord(itemId: string, record: PrivateItemState | undefined): void {
    if (record === undefined) this.records.delete(itemId);
    else this.records.set(itemId, record);
  }

  private clearFailureAfterEdit(meta: ItemEditMeta, field: EditField): void {
    if (meta.failures[field]?.error !== 'STORAGE_COMMIT_UNCERTAIN') delete meta.failures[field];
  }

  private editBlockError(): string | undefined {
    if (this.commitUncertain) return 'STORAGE_COMMIT_UNCERTAIN';
    return this.recoveryDraft === undefined ? undefined : 'RECOVERY_DECISION_REQUIRED';
  }

  private latchCommitUncertain(error: string): boolean {
    if (error !== 'STORAGE_COMMIT_UNCERTAIN' || this.commitUncertain) return false;
    this.commitUncertain = true;
    this.cancelNoteTimer();
    this.pendingNote = undefined;
    return true;
  }

  private setFailure(itemId: string, field: EditField, error: string, revision: number, operationId: number): void {
    const meta = this.editMeta(itemId);
    meta.failures[field] = { error, revision, operationId };
  }

  private saveImmediate(): Promise<CollectionEditResult> {
    this.cancelNoteTimer();
    this.pendingNote = undefined;
    if (this.commitUncertain) {
      this.notify();
      return Promise.resolve(failure('STORAGE_COMMIT_UNCERTAIN'));
    }
    const operation = this.beginOperation(this.pendingSnapshot());
    return this.store.saveImmediate(operation.state).then((result) => {
      const outcome = persistenceResult(result);
      this.finishOperation(operation, outcome);
      return outcome;
    });
  }

  private pendingSnapshot(): Omit<PendingNoteSave, 'scheduled'> {
    const records = new Map(this.records);
    const state = { ...emptyState(this.catalogueFingerprint), items: [...records.values()] };
    const versions = new Map<string, ItemVersions>();
    for (const [itemId, meta] of this.edits) versions.set(itemId, { ...meta.versions });
    const affected = this.affectedFields(records);
    return { state, records, versions, affected };
  }

  private affectedFields(records: ReadonlyMap<string, PrivateItemState>): ReadonlyMap<string, ReadonlySet<EditField>> {
    const affected = new Map<string, ReadonlySet<EditField>>();
    const itemIds = new Set([...records.keys(), ...this.confirmedRecords.keys(), ...this.edits.keys()]);
    for (const itemId of itemIds) {
      const fields = new Set<EditField>();
      const desired = expandedRecord(itemId, records.get(itemId));
      const confirmed = expandedRecord(itemId, this.confirmedRecords.get(itemId));
      const meta = this.editMeta(itemId);
      if (this.fieldNeedsPersistence(itemId, 'collection', desired, confirmed, meta)) fields.add('collection');
      if (this.fieldNeedsPersistence(itemId, 'note', desired, confirmed, meta)) fields.add('note');
      if (fields.size > 0) affected.set(itemId, fields);
    }
    return affected;
  }

  private fieldNeedsPersistence(
    itemId: string,
    field: EditField,
    desired: PrivateItemState,
    confirmed: PrivateItemState,
    meta: ItemEditMeta,
  ): boolean {
    if (
      !sameEditField(field, desired, confirmed) ||
      meta.failures[field] !== undefined ||
      (field === 'note' && meta.noteDraft !== desired.note)
    ) {
      return true;
    }
    for (const operation of this.activeOperations.values()) {
      if (!sameEditField(field, desired, expandedRecord(itemId, operation.records.get(itemId)))) return true;
    }
    return false;
  }

  private beginOperation(snapshot: Omit<PendingNoteSave, 'scheduled'>): SaveOperation {
    const operation = { id: ++this.nextOperationId, ...snapshot };
    this.activeOperations.set(operation.id, operation);
    this.notifyAffected(operation.affected);
    return operation;
  }

  private finishOperation(operation: SaveOperation, result: CollectionEditResult): void {
    this.activeOperations.delete(operation.id);
    const touched = new Set(operation.affected.keys());
    if (operation.id < this.lastSettledOperationId) {
      for (const itemId of touched) this.notify(itemId);
      return;
    }
    this.lastSettledOperationId = operation.id;
    const globallyChanged = !result.ok && this.latchCommitUncertain(result.error);
    if (result.ok && !result.skipped && operation.id > this.lastConfirmedOperationId) {
      this.lastConfirmedOperationId = operation.id;
      for (const itemId of this.confirmedRecords.keys()) touched.add(itemId);
      for (const itemId of operation.records.keys()) touched.add(itemId);
      this.confirmedRecords = new Map(operation.records);
      this.hasActiveState = true;
      for (const [itemId, fields] of operation.affected) {
        const meta = this.editMeta(itemId);
        const versions = operation.versions.get(itemId) ?? { collection: 0, note: 0 };
        for (const field of fields) {
          const existing = meta.failures[field];
          if (existing !== undefined && versions[field] >= existing.revision) delete meta.failures[field];
          if (field === 'note' && versions.note === meta.versions.note) {
            meta.noteDraft = operation.records.get(itemId)?.note;
          }
        }
        meta.lastSavedOperation = operation.id;
      }
    } else if (!result.ok) {
      for (const [itemId, fields] of operation.affected) {
        const meta = this.editMeta(itemId);
        const versions = operation.versions.get(itemId) ?? { collection: 0, note: 0 };
        for (const field of fields) {
          if (meta.versions[field] === versions[field]) {
            this.setFailure(itemId, field, result.error, versions[field], operation.id);
          }
        }
      }
    }
    if (globallyChanged) this.notify();
    else for (const itemId of touched) this.notify(itemId);
  }

  private isSaving(itemId: string, meta: ItemEditMeta): boolean {
    for (const operation of this.activeOperations.values()) {
      const fields = operation.affected.get(itemId);
      const versions = operation.versions.get(itemId);
      if (
        fields !== undefined &&
        versions !== undefined &&
        [...fields].some((field) => versions[field] === meta.versions[field])
      )
        return true;
    }
    return false;
  }

  private isPendingNote(itemId: string, meta: ItemEditMeta): boolean {
    const pending = this.pendingNote;
    const fields = pending?.affected.get(itemId);
    const versions = pending?.versions.get(itemId);
    return (
      pending?.scheduled === true &&
      fields?.has('note') === true &&
      versions !== undefined &&
      versions.note === meta.versions.note
    );
  }

  private scheduleNoteFlush(): void {
    this.cancelNoteTimer();
    this.noteFlushTimer = globalThis.setTimeout(() => {
      this.noteFlushTimer = undefined;
      void this.flushNote();
    }, this.noteAutosaveDelay + 10);
  }

  private cancelNoteTimer(): void {
    if (this.noteFlushTimer === undefined) return;
    globalThis.clearTimeout(this.noteFlushTimer);
    this.noteFlushTimer = undefined;
  }

  private notifyAffected(affected: ReadonlyMap<string, ReadonlySet<EditField>>): void {
    for (const itemId of affected.keys()) this.notify(itemId);
  }

  private notify(itemId?: string): void {
    for (const listener of this.listeners) listener(itemId);
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
