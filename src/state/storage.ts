import {
  serializePrivateState,
  validatePrivateState,
  type PrivateState,
  type StateErrorCode,
} from "./domain.ts";

export const PRIVATE_STATE_STORAGE_KEY = "snoredex-checklist.private-state";
export const PRIVATE_STATE_LOCK_NAME = "snoredex-checklist.private-state-write";
export const PRIVATE_STATE_NOTE_DRAFT_KEY = "snoredex-checklist.private-state.note-draft";
export const NOTE_AUTOSAVE_DELAY_MS = 3_000;
const DRAFT_OWNER_HEARTBEAT_MS = 5_000;

const PRIVATE_STATE_NOTE_DRAFT_SCHEMA = "snoredex-checklist.pending-note";
const PRIVATE_STATE_NOTE_DRAFT_VERSION = 1;
const PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX = `${PRIVATE_STATE_NOTE_DRAFT_KEY}:`;
const PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_SCHEMA = "snoredex-checklist.pending-note-tombstone";
const PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_VERSION = 1;
const PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_KEY_PREFIX = `${PRIVATE_STATE_NOTE_DRAFT_KEY}:tombstone:`;

export const PERSISTENCE_ERROR_CODES = [
  "LOCAL_STATE_UNSUPPORTED",
  "LOCAL_STATE_UNREADABLE",
  "STORAGE_UNAVAILABLE",
  "STORAGE_QUOTA_EXCEEDED",
  "STORAGE_WRITE_FAILED",
  "STORAGE_COMMIT_UNCERTAIN",
] as const;
export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

export type PersistenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PersistenceErrorCode };

export interface StorageLockLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface DraftStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly listKeys?: (prefix: string) => readonly string[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  readonly withLock?: <T>(callback: () => Promise<T>) => Promise<T>;
  readonly draftStorage?: DraftStorageLike;
  readonly draftId?: string;
  readonly registerDraftLifecycle?: (
    onInactive: () => void,
    onActive: () => void,
  ) => () => void;
}

export interface TimerClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SaveSuccess {
  readonly state: PrivateState | undefined;
  readonly skipped?: boolean;
}

export type SaveResult = PersistenceResult<SaveSuccess>;

interface PendingNote {
  readonly state: PrivateState;
  readonly generation: number;
  readonly timer: unknown;
  readonly draftToken: number;
  readonly draftStorageReference: DraftReference | undefined;
  readonly supersededDraftReference: DraftReference | undefined;
  readonly recoveryDraftReference: DraftReference | undefined;
}

interface SaveOperation {
  readonly kind: "immediate" | "note";
  readonly generation: number;
  readonly draftToken: number;
  readonly draftStorageReference: DraftReference | undefined;
  readonly supersededDraftReference: DraftReference | undefined;
  readonly recoveryDraftReference: DraftReference | undefined;
}

interface PendingNoteDraftRecord {
  readonly schema: typeof PRIVATE_STATE_NOTE_DRAFT_SCHEMA;
  readonly schemaVersion: typeof PRIVATE_STATE_NOTE_DRAFT_VERSION;
  readonly draftId: string;
  readonly state: unknown;
  readonly revision: string;
  readonly hasObservedRaw: boolean;
  readonly observedRaw: string | null;
  readonly updatedAt: number;
  readonly ownerState: "active" | "inactive" | "consumed";
}

interface ConsumedDraftRecord {
  readonly schema: typeof PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_SCHEMA;
  readonly schemaVersion: typeof PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_VERSION;
  readonly sourceKey: string;
  readonly sourceDraftId: string;
  readonly sourceRevision: string;
  readonly consumedAt: number;
}

interface DraftReference {
  readonly key: string;
  readonly value: string;
  readonly draftId: string;
  readonly revision?: string;
}

export function getPendingNoteDraftKey(draftId: string): string {
  return `${PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX}${draftId}`;
}

function getConsumedDraftKey(draftId: string, sourceKey?: string, sourceRevision?: string): string {
  if (sourceKey === undefined) {
    return `${PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_KEY_PREFIX}${draftId}`;
  }
  return `${PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_KEY_PREFIX}${encodeURIComponent(draftId)}:${encodeURIComponent(sourceKey)}:${encodeURIComponent(sourceRevision ?? "legacy")}`;
}

let generatedDraftId = 0;
let generatedDraftRevision = 0;
let generatedDraftStorageKey = 0;

function createDraftId(): string {
  generatedDraftId += 1;
  const cryptoValue = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const randomId = cryptoValue?.randomUUID?.();
  if (randomId !== undefined) {
    return `store-${randomId}`;
  }
  return `store-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${generatedDraftId.toString(36)}`;
}

function createDraftRevision(draftId: string): string {
  generatedDraftRevision += 1;
  return `${draftId}:${Date.now().toString(36)}-${generatedDraftRevision.toString(36)}`;
}

function createRotatedDraftStorageKey(draftId: string): string {
  generatedDraftStorageKey += 1;
  return `${PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX}${draftId}:rotated:${Date.now().toString(36)}-${generatedDraftStorageKey.toString(36)}`;
}

const browserClock: TimerClock = {
  setTimeout: (callback, delayMs) => {
    const handle = globalThis.setTimeout(callback, delayMs);
    // Do not keep non-browser runtimes alive solely for a recovery lease heartbeat.
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

function cloneState(state: PrivateState): PrivateState {
  return {
    schema: state.schema,
    schemaVersion: state.schemaVersion,
    datasetId: state.datasetId,
    catalogueFingerprint: state.catalogueFingerprint,
    items: state.items.map((item) => ({ ...item })),
  };
}

function sameState(left: PrivateState, right: PrivateState): boolean {
  const leftSerialized = serializePrivateState(left);
  const rightSerialized = serializePrivateState(right);
  return leftSerialized.ok && rightSerialized.ok && leftSerialized.value === rightSerialized.value;
}

function error<T>(code: PersistenceErrorCode): PersistenceResult<T> {
  return { ok: false, error: code };
}

function success<T>(value: T): PersistenceResult<T> {
  return { ok: true, value };
}

function isQuotaError(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("name" in value)) {
    return false;
  }
  const name = (value as { name?: unknown }).name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function classifyStateError(code: StateErrorCode): PersistenceErrorCode {
  return code === "IMPORT_UNSUPPORTED_STATE_SCHEMA" || code === "IMPORT_UNSUPPORTED_STATE_VERSION"
    ? "LOCAL_STATE_UNSUPPORTED"
    : "LOCAL_STATE_UNREADABLE";
}

export function getBrowserStorage(): PersistenceResult<StorageLike> {
  try {
    if (typeof globalThis.localStorage === "undefined") {
      return error("STORAGE_UNAVAILABLE");
    }
    const locks = getBrowserLockManager();
    if (locks === undefined) {
      return error("STORAGE_UNAVAILABLE");
    }
    const storage = globalThis.localStorage;
    return success({
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value),
      draftId: createDraftId(),
      withLock: (callback) => locks.request(PRIVATE_STATE_LOCK_NAME, callback),
      draftStorage: {
        getItem: (key) => storage.getItem(key),
        setItem: (key, value) => storage.setItem(key, value),
        removeItem: (key) => storage.removeItem(key),
        listKeys: (prefix) => {
          const keys: string[] = [];
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key !== null && key.startsWith(prefix)) {
              keys.push(key);
            }
          }
          return keys;
        },
      },
      registerDraftLifecycle: (onInactive, onActive) => {
        const target = globalThis as typeof globalThis & {
          addEventListener?: (type: string, listener: () => void) => void;
          removeEventListener?: (type: string, listener: () => void) => void;
        };
        if (target.addEventListener === undefined || target.removeEventListener === undefined) {
          return () => undefined;
        }
        target.addEventListener("beforeunload", onInactive);
        target.addEventListener("pageshow", onActive);
        return () => {
          target.removeEventListener?.("beforeunload", onInactive);
          target.removeEventListener?.("pageshow", onActive);
        };
      },
    });
  } catch {
    return error("STORAGE_UNAVAILABLE");
  }
}

function getBrowserLockManager(): StorageLockLike | undefined {
  const navigatorValue = (globalThis as { navigator?: { locks?: unknown } }).navigator;
  const locks = navigatorValue?.locks;
  if (typeof locks !== "object" || locks === null) {
    return undefined;
  }
  const request = (locks as { request?: unknown }).request;
  if (typeof request !== "function") {
    return undefined;
  }
  return {
    request: <T>(name: string, callback: () => Promise<T>): Promise<T> =>
      (request as (lockName: string, lockCallback: () => Promise<T>) => Promise<T>).call(
        locks,
        name,
        callback,
      ),
  };
}

/**
 * The sole v1 browser-local state authority. All writes pass through one queue;
 * callers never write the namespaced key directly.
 */
export class OrderedStateStore {
  private readonly storage: StorageLike;
  private readonly clock: TimerClock;
  private readonly draftId: string;
  private queue: Promise<void> = Promise.resolve();
  private immediateGeneration = 0;
  private noteGeneration = 0;
  private nextDraftToken = 0;
  private latestDraftToken = 0;
  private latestDraftRevision: string | undefined;
  private lastKnownGood: PrivateState | undefined;
  private unsavedDraft: PrivateState | undefined;
  private pendingNote: PendingNote | undefined;
  private draftHeartbeatTimer: unknown;
  private readonly unregisterDraftLifecycle: (() => void) | undefined;
  private activeDraftReference: DraftReference | undefined;
  private activeDraftOwned = false;
  private recoveredForeignReference: DraftReference | undefined;
  private recoveredDraftPresented = false;
  private draftPersistenceError: PersistenceErrorCode | undefined;
  private supersededDraftReference: DraftReference | undefined;
  private observedRaw: string | null | undefined;
  private hasObservedRaw = false;

  public constructor(storage: StorageLike, clock: TimerClock = browserClock) {
    this.storage = storage;
    this.clock = clock;
    this.draftId = storage.draftId ?? createDraftId();
    this.unregisterDraftLifecycle = storage.registerDraftLifecycle?.(
      () => this.markDraftOwnerInactive(),
      () => this.markDraftOwnerActive(),
    );
  }

  public read(): PersistenceResult<PrivateState | undefined> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(PRIVATE_STATE_STORAGE_KEY);
    } catch {
      return error("STORAGE_UNAVAILABLE");
    }
    this.observedRaw = raw;
    this.hasObservedRaw = true;
    if (raw === null) {
      this.lastKnownGood = undefined;
      this.restorePendingNoteDraft();
      return success(undefined);
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw) as unknown;
    } catch {
      this.restorePendingNoteDraft(false);
      return error("LOCAL_STATE_UNREADABLE");
    }
    const validated = validatePrivateState(candidate);
    if (!validated.ok) {
      this.restorePendingNoteDraft(false);
      return error(classifyStateError(validated.error));
    }
    this.lastKnownGood = cloneState(validated.value);
    this.restorePendingNoteDraft();
    return success(cloneState(validated.value));
  }

  public lastReadable(): PrivateState | undefined {
    return this.lastKnownGood === undefined ? undefined : cloneState(this.lastKnownGood);
  }

  public unsaved(): PrivateState | undefined {
    return this.unsavedDraft === undefined ? undefined : cloneState(this.unsavedDraft);
  }

  /** Explicitly accept the currently presented recovery draft for the next save. */
  public adoptUnsavedDraft(): PersistenceResult<PrivateState | undefined> {
    if (this.unsavedDraft === undefined) {
      return success(undefined);
    }
    this.recoveredDraftPresented = true;
    return success(cloneState(this.unsavedDraft));
  }

  /**
   * Return the canonical state observed when the recovered draft was written.
   *
   * The current canonical envelope may have changed in another tab since the
   * draft was created.  It is therefore not a safe baseline for deciding
   * whether a direct save adopted a recovered note change.
   */
  private recoveredDraftBaseline(): PrivateState | undefined | null {
    const reference = this.recoveredForeignReference;
    if (reference === undefined) {
      return null;
    }
    try {
      const record = JSON.parse(reference.value) as Partial<PendingNoteDraftRecord>;
      if (record.hasObservedRaw === false) {
        return undefined;
      }
      if (record.hasObservedRaw !== true) {
        return null;
      }
      if (record.observedRaw === null) {
        return undefined;
      }
      if (typeof record.observedRaw !== "string") {
        return null;
      }
      const candidate = JSON.parse(record.observedRaw) as unknown;
      const validated = validatePrivateState(candidate);
      return validated.ok ? validated.value : null;
    } catch {
      // A malformed recovery baseline must never cause us to consume a
      // foreign draft implicitly.
      return null;
    }
  }

  private isRecoveredDraftReplacement(state: PrivateState): boolean {
    if (this.recoveredForeignReference === undefined || this.unsavedDraft === undefined) {
      return false;
    }
    if (this.recoveredDraftPresented) {
      return true;
    }
    // A direct caller that submits an edited recovered draft without first
    // reading unsaved() still demonstrates adoption only when every recovered
    // note change, including deletions, is represented in the submitted state.
    const baseline = this.recoveredDraftBaseline();
    if (baseline === null || baseline === undefined) {
      return false;
    }
    const baselineItems = new Map(baseline.items.map((item) => [item.itemId, item]));
    const recoveredItems = new Map(this.unsavedDraft.items.map((item) => [item.itemId, item]));
    const submittedItems = new Map(state.items.map((item) => [item.itemId, item]));
    const itemIds = new Set([...baselineItems.keys(), ...recoveredItems.keys()]);
    let hasRecoveredNoteChange = false;
    for (const itemId of itemIds) {
      const baselineNote = baselineItems.get(itemId)?.note;
      const recoveredNote = recoveredItems.get(itemId)?.note;
      if (baselineNote === recoveredNote) {
        continue;
      }
      hasRecoveredNoteChange = true;
      if (submittedItems.get(itemId)?.note !== recoveredNote) {
        return false;
      }
    }
    return hasRecoveredNoteChange;
  }

  /** Explicitly rebase a recovered draft onto the currently stored canonical envelope. */
  public rebaseUnsavedDraft(): PersistenceResult<PrivateState | undefined> {
    if (this.unsavedDraft === undefined) {
      return success(undefined);
    }
    let raw: string | null;
    try {
      raw = this.storage.getItem(PRIVATE_STATE_STORAGE_KEY);
    } catch {
      return error("STORAGE_UNAVAILABLE");
    }
    let current: PrivateState | undefined;
    if (raw !== null) {
      let candidate: unknown;
      try {
        candidate = JSON.parse(raw) as unknown;
      } catch {
        return error("LOCAL_STATE_UNREADABLE");
      }
      const validated = validatePrivateState(candidate);
      if (!validated.ok) {
        return error(classifyStateError(validated.error));
      }
      current = validated.value;
    }
    const draft = cloneState(this.unsavedDraft);
    const previousOwnedReference = this.activeDraftOwned ? this.activeDraftReference : undefined;
    const previousReference = this.recoveredForeignReference ?? this.activeDraftReference;
    const previousObservedRaw = this.observedRaw;
    const previousHasObservedRaw = this.hasObservedRaw;
    const previousLastKnownGood = this.lastKnownGood === undefined ? undefined : cloneState(this.lastKnownGood);
    this.latestDraftRevision = createDraftRevision(this.draftId);
    this.observedRaw = raw;
    this.hasObservedRaw = true;
    this.lastKnownGood = current === undefined ? undefined : cloneState(current);
    const persistedReference = this.persistPendingNoteDraft(draft);
    if (this.storage.draftStorage !== undefined && persistedReference === undefined) {
      this.latestDraftRevision = previousReference?.revision;
      this.observedRaw = previousObservedRaw;
      this.hasObservedRaw = previousHasObservedRaw;
      this.lastKnownGood = previousLastKnownGood;
      return error(this.draftPersistenceError ?? "STORAGE_WRITE_FAILED");
    }
    if (persistedReference !== undefined && previousOwnedReference?.key !== persistedReference.key) {
      this.clearPendingNoteDraft(previousOwnedReference);
    }
    if (previousReference !== undefined && persistedReference?.key !== previousReference.key) {
      if (previousReference.draftId === this.draftId || !this.isDraftOwnerActive(previousReference)) {
        this.clearPendingNoteDraft(previousReference);
      } else {
        this.supersededDraftReference = previousReference;
      }
    }
    this.recoveredForeignReference = undefined;
    this.recoveredDraftPresented = false;
    this.startDraftHeartbeat();
    return success(draft);
  }

  /** Explicitly discard a recovered or pending note draft without changing canonical state. */
  public discardUnsavedDraft(): void {
    this.immediateGeneration += 1;
    this.noteGeneration += 1;
    this.cancelPendingNote();
    this.nextDraftToken += 1;
    this.latestDraftToken = this.nextDraftToken;
    const reference = this.activeDraftOwned ? this.activeDraftReference : undefined;
    const recoveredReference = this.recoveredForeignReference;
    const supersededReference = this.supersededDraftReference?.draftId === this.draftId
      ? undefined
      : this.supersededDraftReference;
    const foreignReference = recoveredReference ?? supersededReference;
    const foreignRetired = foreignReference === undefined || this.consumeSupersededDraft(foreignReference);
    const ownedRetired = reference === undefined || this.clearPendingNoteDraft(reference, true);
    if (ownedRetired) {
      this.activeDraftReference = undefined;
      this.activeDraftOwned = false;
      this.latestDraftRevision = undefined;
    } else {
      // A failed removal remains a live owned recovery and must be retried.
      this.activeDraftOwned = true;
      this.latestDraftRevision = this.activeDraftReference?.revision ?? reference?.revision;
    }
    if (foreignRetired) {
      this.recoveredForeignReference = undefined;
      if (this.supersededDraftReference?.key === foreignReference?.key) {
        this.supersededDraftReference = undefined;
      }
    } else if (recoveredReference !== undefined) {
      // Keep a non-adopted foreign recovery distinct from a superseded source.
      this.recoveredForeignReference = foreignReference;
    } else {
      this.supersededDraftReference = foreignReference;
    }
    this.recoveredDraftPresented = false;
    if (ownedRetired && foreignRetired) {
      this.unsavedDraft = undefined;
      this.supersededDraftReference = undefined;
      this.stopDraftHeartbeat();
    } else if (!ownedRetired) {
      this.startDraftHeartbeat();
    }
  }

  public saveImmediate(state: PrivateState): Promise<SaveResult> {
    const generation = ++this.immediateGeneration;
    const previousDraft = this.activeDraftOwned ? this.activeDraftReference : undefined;
    const recoveredDraft = this.isRecoveredDraftReplacement(state)
      ? this.recoveredForeignReference
      : undefined;
    const recoveryDraftReference = this.recoveredForeignReference;
    this.cancelPendingNote(previousDraft !== undefined);
    const draftToken = this.rememberDraft(state);
    const persistedReference = this.persistPendingNoteDraft(state);
    if (this.storage.draftStorage !== undefined && persistedReference === undefined) {
      return Promise.resolve(error(this.draftPersistenceError ?? "STORAGE_WRITE_FAILED"));
    }
    if (persistedReference !== undefined && previousDraft?.key !== persistedReference.key) {
      this.clearPendingNoteDraft(previousDraft);
    }
    return this.enqueue(state, {
      kind: "immediate",
      generation,
      draftToken,
      draftStorageReference: persistedReference ?? previousDraft,
      supersededDraftReference: this.supersededDraftReference ?? recoveredDraft,
      recoveryDraftReference,
    });
  }

  public scheduleNoteSave(state: PrivateState): PersistenceResult<void> {
    const generation = ++this.noteGeneration;
    this.cancelPendingNote();
    const previousDraft = this.activeDraftOwned ? this.activeDraftReference : undefined;
    const recoveredDraft = this.isRecoveredDraftReplacement(state)
      ? this.recoveredForeignReference
      : undefined;
    const recoveryDraftReference = this.recoveredForeignReference;
    const draftToken = this.rememberDraft(state);
    const supersededDraftReference = this.supersededDraftReference ?? recoveredDraft;
    const draftStorageReference = this.persistPendingNoteDraft(state) ?? previousDraft;
    if (draftStorageReference !== undefined && previousDraft?.key !== draftStorageReference.key) {
      this.clearPendingNoteDraft(previousDraft);
    }
    const timer = this.clock.setTimeout(() => {
      if (this.pendingNote?.generation === generation) {
        void this.flushNoteForGeneration(generation);
      }
    }, NOTE_AUTOSAVE_DELAY_MS);
    this.pendingNote = {
      state: cloneState(state),
      generation,
      timer,
      draftToken,
      draftStorageReference,
      supersededDraftReference,
      recoveryDraftReference,
    };
    this.startDraftHeartbeat();
    return this.draftPersistenceError === undefined
      ? success(undefined)
      : error(this.draftPersistenceError);
  }

  /** Flush on blur or pagehide; callers may ignore the returned promise for pagehide. */
  public flushNote(): Promise<SaveResult> {
    return this.flushNoteForGeneration(this.pendingNote?.generation);
  }

  public hasPendingNote(): boolean {
    return this.pendingNote !== undefined;
  }

  private flushNoteForGeneration(generation: number | undefined): Promise<SaveResult> {
    const pending = this.pendingNote;
    if (pending === undefined || pending.generation !== generation) {
      return Promise.resolve(success({ state: this.lastReadable(), skipped: true }));
    }
    this.cancelPendingNote(true);
    return this.enqueue(pending.state, {
      kind: "note",
      generation: pending.generation,
      draftToken: pending.draftToken,
      draftStorageReference: pending.draftStorageReference,
      supersededDraftReference: pending.supersededDraftReference,
      recoveryDraftReference: pending.recoveryDraftReference,
    });
  }

  private cancelPendingNote(keepDraftHeartbeat = false): void {
    if (this.pendingNote !== undefined) {
      this.clock.clearTimeout(this.pendingNote.timer);
      this.pendingNote = undefined;
    }
    if (!keepDraftHeartbeat) {
      this.stopDraftHeartbeat();
    }
  }

  private rememberDraft(state: PrivateState): number {
    const draftToken = ++this.nextDraftToken;
    this.latestDraftToken = draftToken;
    this.latestDraftRevision = createDraftRevision(this.draftId);
    this.unsavedDraft = cloneState(state);
    return draftToken;
  }

  private persistPendingNoteDraft(state: PrivateState, revision = this.latestDraftRevision): DraftReference | undefined {
    this.draftPersistenceError = undefined;
    const draftStorage = this.storage.draftStorage;
    if (draftStorage === undefined) {
      return undefined;
    }
    const serialized = serializePrivateState(state);
    if (!serialized.ok) {
      this.draftPersistenceError = "STORAGE_WRITE_FAILED";
      return undefined;
    }
    if (this.hasObservedRaw && this.observedRaw === undefined) {
      this.draftPersistenceError = "STORAGE_COMMIT_UNCERTAIN";
      return undefined;
    }
    const hasValidObservedRaw = this.hasValidObservedRaw();
    const draftRevision = revision ?? createDraftRevision(this.draftId);
    let ownerState: PendingNoteDraftRecord["ownerState"] = "active";
    let editTimestamp = Date.now();
    const previousOwnedReference = this.activeDraftOwned ? this.activeDraftReference : undefined;
    const sourceIsTombstoned = previousOwnedReference !== undefined
      && this.isTombstonedDraftKey(previousOwnedReference.key, this.draftId);
    let key = previousOwnedReference !== undefined
      ? createRotatedDraftStorageKey(this.draftId)
      : getPendingNoteDraftKey(this.draftId);
    if (previousOwnedReference !== undefined) {
      try {
        const raw = draftStorage.getItem(previousOwnedReference.key);
        if (raw !== null) {
          const current = this.parseDraftReference({
            ...previousOwnedReference,
            value: raw,
            draftId: this.draftId,
          });
          if (current !== undefined && (sourceIsTombstoned || current.ownerState === "consumed")) {
            const validatedCurrent = validatePrivateState(current.state);
            if (validatedCurrent.ok && sameState(validatedCurrent.value, state)) {
              ownerState = "consumed";
            }
          }
          if (current !== undefined && current.revision === draftRevision) {
            editTimestamp = current.updatedAt;
          }
        }
      } catch {
        // A lifecycle refresh remains best effort; a normal active record is safe to write.
      }
    }
    const record: PendingNoteDraftRecord = {
      schema: PRIVATE_STATE_NOTE_DRAFT_SCHEMA,
      schemaVersion: PRIVATE_STATE_NOTE_DRAFT_VERSION,
      draftId: this.draftId,
      state: JSON.parse(serialized.value) as unknown,
      revision: draftRevision,
      hasObservedRaw: hasValidObservedRaw,
      observedRaw: hasValidObservedRaw ? this.observedRaw ?? null : null,
      updatedAt: editTimestamp,
      ownerState,
    };
    try {
      const value = JSON.stringify(record);
      try {
        draftStorage.setItem(key, value);
      } catch (cause) {
        // A normal active draft can be safely overwritten when a second full
        // envelope would exceed quota.  Never fall back for a tombstoned
        // source: that record is concurrently reclaimable and must remain
        // immutable until the rotated replacement is durable.
        if (
          !isQuotaError(cause)
          || previousOwnedReference === undefined
          || sourceIsTombstoned
          || !this.canFallbackToActiveDraftOverwrite(previousOwnedReference)
        ) {
          throw cause;
        }
        key = previousOwnedReference.key;
        draftStorage.setItem(key, value);
      }
      const reference = { key, value, draftId: this.draftId, revision: draftRevision };
      this.activeDraftReference = reference;
      this.activeDraftOwned = true;
      return reference;
    } catch (cause) {
      this.draftPersistenceError = isQuotaError(cause)
        ? "STORAGE_QUOTA_EXCEEDED"
        : "STORAGE_WRITE_FAILED";
      // Keep the in-memory draft so the caller can retry after surfacing the
      // failure; do not silently present the previous durable record as new.
      return undefined;
    }
  }

  private hasValidObservedRaw(): boolean {
    if (!this.hasObservedRaw || this.observedRaw === undefined) {
      return false;
    }
    if (this.observedRaw === null) {
      return true;
    }
    try {
      return validatePrivateState(JSON.parse(this.observedRaw) as unknown).ok;
    } catch {
      return false;
    }
  }

  /**
   * Quota fallback is allowed only for the current active owner record. A
   * fresh read prevents an earlier tombstone snapshot from authorizing an
   * overwrite of a source that is already eligible for reclamation.
   */
  private canFallbackToActiveDraftOverwrite(reference: DraftReference): boolean {
    const draftStorage = this.storage.draftStorage;
    if (draftStorage === undefined) {
      return false;
    }
    try {
      if (this.isTombstonedDraftKey(reference.key, this.draftId)) {
        return false;
      }
      const raw = draftStorage.getItem(reference.key);
      if (raw === null) {
        return false;
      }
      const current = this.parseDraftReference({
        ...reference,
        value: raw,
        draftId: this.draftId,
      });
      return current !== undefined && current.ownerState === "active"
        && !this.isTombstonedDraftKey(reference.key, this.draftId);
    } catch {
      return false;
    }
  }

  private consumeSupersededDraft(reference: DraftReference | undefined): boolean {
    if (reference === undefined || reference.draftId === this.draftId || reference.revision === undefined) {
      return false;
    }
    const draftStorage = this.storage.draftStorage;
    if (draftStorage === undefined) {
      return false;
    }
    try {
      const expected = this.parseDraftReference(reference);
      if (expected === undefined) {
        return false;
      }
      const expectedState = validatePrivateState(expected.state);
      if (!expectedState.ok) {
        return false;
      }
      const candidates: Array<PendingNoteDraftRecord & { readonly key: string; readonly value: string }> = [];
      const keys = draftStorage.listKeys?.(PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX)
        .filter((key) => !key.startsWith(PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_KEY_PREFIX));
      if (keys === undefined) {
        const raw = draftStorage.getItem(reference.key);
        if (raw !== null) {
          const current = this.parseDraftReference({ ...reference, value: raw });
          if (current !== undefined && current.revision === reference.revision) {
            candidates.push(current);
          }
        }
      } else {
        for (const key of keys) {
          const raw = draftStorage.getItem(key);
          if (raw === null) {
            continue;
          }
          const current = this.parseDraftReference({ ...reference, key, value: raw });
          if (current !== undefined && current.revision === reference.revision) {
            candidates.push(current);
          }
        }
      }
      if (candidates.length === 0) {
        // With key enumeration, absence of every matching physical copy is
        // proof that the logical recovery source has already been retired.
        return keys !== undefined && draftStorage.getItem(reference.key) === null;
      }
      for (const current of candidates) {
        if (this.isDraftTombstoned(current)) {
          continue;
        }
        if (current.ownerState === "consumed") {
          return false;
        }
        const currentState = validatePrivateState(current.state);
        if (!currentState.ok || !sameState(expectedState.value, currentState.value)) {
          return false;
        }
        // Keep every source record untouched. Separate state-scoped markers
        // cannot overwrite owner writes that race with this transfer.
        if (!this.writeConsumedDraftTombstone(draftStorage, current.key, reference.draftId, reference.revision)) {
          return false;
        }
      }
      return true;
    } catch {
      // A failed tombstone must not make a verified canonical save fail.
      return false;
    }
  }

  private writeConsumedDraftTombstone(
    draftStorage: DraftStorageLike,
    sourceKey: string,
    sourceDraftId: string,
    sourceRevision: string,
  ): boolean {
    try {
      const tombstone: ConsumedDraftRecord = {
        schema: PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_SCHEMA,
        schemaVersion: PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_VERSION,
        sourceKey,
        sourceDraftId,
        sourceRevision,
        consumedAt: Date.now(),
      };
      const tombstoneKey = draftStorage.listKeys === undefined
        ? getConsumedDraftKey(sourceDraftId)
        : getConsumedDraftKey(sourceDraftId, sourceKey, sourceRevision);
      let consumedAt = tombstone.consumedAt;
      const previousRaw = draftStorage.getItem(tombstoneKey);
      if (previousRaw !== null) {
        const previous = this.parseConsumedDraftRecord(previousRaw);
        if (previous !== undefined && consumedAt <= previous.consumedAt) {
          consumedAt = previous.consumedAt + 1;
        }
      }
      draftStorage.setItem(tombstoneKey, JSON.stringify({ ...tombstone, consumedAt }));
      return true;
    } catch {
      return false;
    }
  }

  private startDraftHeartbeat(): void {
    if (this.draftHeartbeatTimer !== undefined || !this.activeDraftOwned) {
      return;
    }
    this.draftHeartbeatTimer = this.clock.setTimeout(() => {
      this.draftHeartbeatTimer = undefined;
      if (!this.activeDraftOwned || this.unsavedDraft === undefined) {
        return;
      }
      const previousReference = this.activeDraftReference;
      const persistedReference = this.persistPendingNoteDraft(this.unsavedDraft);
      if (persistedReference !== undefined && previousReference?.key !== persistedReference.key) {
        this.clearPendingNoteDraft(previousReference);
      }
      this.startDraftHeartbeat();
    }, DRAFT_OWNER_HEARTBEAT_MS);
  }

  private markDraftOwnerInactive(): void {
    this.setDraftOwnerState("inactive");
    this.stopDraftHeartbeat();
  }

  private markDraftOwnerActive(): void {
    this.setDraftOwnerState("active");
    if (this.unsavedDraft !== undefined) {
      this.startDraftHeartbeat();
    }
  }

  private setDraftOwnerState(ownerState: "active" | "inactive"): void {
    if (!this.activeDraftOwned || this.activeDraftReference === undefined) {
      return;
    }
    try {
      const draftStorage = this.storage.draftStorage;
      if (draftStorage === undefined) {
        return;
      }
      const reference = this.activeDraftReference;
      const raw = draftStorage.getItem(reference.key);
      if (raw === null) {
        return;
      }
      const parsed = this.parseDraftReference({ ...reference, value: raw });
      if (parsed === undefined || parsed.draftId !== this.draftId) {
        return;
      }
      let nextOwnerState: PendingNoteDraftRecord["ownerState"] = ownerState;
      if (ownerState === "active" && parsed.ownerState === "consumed" && this.unsavedDraft !== undefined) {
        const validated = validatePrivateState(parsed.state);
        if (validated.ok && sameState(validated.value, this.unsavedDraft)) {
          nextOwnerState = "consumed";
        }
      }
      if (ownerState === "inactive" && parsed.ownerState === "consumed"
        && !this.isTombstonedDraftKey(reference.key, reference.draftId)) {
        nextOwnerState = "consumed";
      }
      if (nextOwnerState === "active"
        && this.unsavedDraft !== undefined
        && this.isTombstonedDraftKey(reference.key, reference.draftId)) {
        const validated = validatePrivateState(parsed.state);
        if (validated.ok && sameState(validated.value, this.unsavedDraft)) {
          nextOwnerState = "consumed";
        }
      }
      const value = JSON.stringify({
        schema: PRIVATE_STATE_NOTE_DRAFT_SCHEMA,
        schemaVersion: PRIVATE_STATE_NOTE_DRAFT_VERSION,
        draftId: parsed.draftId,
        state: parsed.state,
        revision: parsed.revision,
        hasObservedRaw: parsed.hasObservedRaw,
        observedRaw: parsed.observedRaw,
        updatedAt: parsed.updatedAt,
        ownerState: nextOwnerState,
      } satisfies PendingNoteDraftRecord);
      if (ownerState === "active" && this.isTombstonedDraftKey(reference.key, reference.draftId)) {
        const rotatedKey = createRotatedDraftStorageKey(this.draftId);
        // Install a marker before publishing the rotated record. The source
        // is written as consumed, then the marker is refreshed with a newer
        // value so a reclaimer holding the pre-write marker cannot delete it
        // after the source becomes visible.
        const rotatedValue = JSON.stringify({
          schema: PRIVATE_STATE_NOTE_DRAFT_SCHEMA,
          schemaVersion: PRIVATE_STATE_NOTE_DRAFT_VERSION,
          draftId: parsed.draftId,
          state: parsed.state,
          revision: parsed.revision,
          hasObservedRaw: parsed.hasObservedRaw,
          observedRaw: parsed.observedRaw,
          updatedAt: parsed.updatedAt,
          ownerState: "consumed",
        } satisfies PendingNoteDraftRecord);
        if (!this.writeConsumedDraftTombstone(draftStorage, rotatedKey, this.draftId, parsed.revision)) {
          return;
        }
        try {
          draftStorage.setItem(rotatedKey, rotatedValue);
        } catch {
          return;
        }
        if (!this.writeConsumedDraftTombstone(draftStorage, rotatedKey, this.draftId, parsed.revision)) {
          try {
            if (draftStorage.getItem(rotatedKey) === rotatedValue) {
              draftStorage.removeItem(rotatedKey);
            }
          } catch {
            // Best-effort cleanup; the unsuppressed source is never adopted.
          }
          return;
        }
        // A concurrent reclamation may remove the marker between the source
        // write and adoption of the rotated reference.  Do not switch to an
        // unsuppressed source; leave the original consumed reference intact
        // and discard only the value written by this transfer.
        if (!this.isTombstonedDraftKey(rotatedKey, this.draftId)) {
          try {
            if (draftStorage.getItem(rotatedKey) === rotatedValue) {
              draftStorage.removeItem(rotatedKey);
            }
          } catch {
            // Best-effort cleanup; the reference is deliberately not adopted.
          }
          return;
        }
        this.activeDraftReference = { ...reference, key: rotatedKey, value: rotatedValue };
        this.clearPendingNoteDraft(reference);
      } else {
        draftStorage.setItem(reference.key, value);
        this.activeDraftReference = { ...reference, value };
      }
    } catch {
      // Lifecycle hints are best effort; failure must not affect canonical state.
    }
  }

  private stopDraftHeartbeat(): void {
    if (this.draftHeartbeatTimer !== undefined) {
      this.clock.clearTimeout(this.draftHeartbeatTimer);
      this.draftHeartbeatTimer = undefined;
    }
  }

  private isDraftOwnerActive(reference: DraftReference): boolean {
    if (reference.draftId === this.draftId) {
      return true;
    }
    try {
      const draftStorage = this.storage.draftStorage;
      const raw = draftStorage?.getItem(reference.key);
      if (raw === null || raw === undefined) {
        return false;
      }
      const parsed = this.parseDraftReference({ ...reference, value: raw });
      return parsed !== undefined && parsed.ownerState === "active";
    } catch {
      // An unreadable owner marker is not evidence that a foreign tab is live.
      return false;
    }
  }

  private isTombstonedDraftKey(key: string, draftId: string): boolean {
    try {
      const draftStorage = this.storage.draftStorage;
      if (draftStorage === undefined) {
        return false;
      }
      return this.tombstoneKeys(draftStorage).some((tombstoneKey) => {
        const raw = draftStorage.getItem(tombstoneKey);
        if (raw === null) {
          return false;
        }
        const tombstone = this.parseConsumedDraftRecord(raw);
        return tombstone !== undefined
          && tombstone.sourceKey === key
          && tombstone.sourceDraftId === draftId;
      });
    } catch {
      return false;
    }
  }

  private clearPendingNoteDraft(
    expectedReference: DraftReference | undefined,
    allowRefreshedOwnedReference = false,
  ): boolean {
    if (expectedReference === undefined) {
      return false;
    }
    try {
      const draftStorage = this.storage.draftStorage;
      if (draftStorage === undefined) {
        return false;
      }
      const currentValue = draftStorage?.getItem(expectedReference.key);
      if (currentValue === null) {
        return true;
      }
      const exactMatch = currentValue === expectedReference.value;
      const refreshedOwnedMatch = allowRefreshedOwnedReference
        && expectedReference.draftId === this.draftId
        && this.activeDraftOwned
        && this.activeDraftReference?.key === expectedReference.key
        && currentValue === this.activeDraftReference.value;
      if (exactMatch || refreshedOwnedMatch) {
        draftStorage.removeItem(expectedReference.key);
        if (this.activeDraftReference?.key === expectedReference.key
          && (this.activeDraftReference.value === expectedReference.value || refreshedOwnedMatch)) {
          this.activeDraftReference = undefined;
          this.activeDraftOwned = false;
          this.stopDraftHeartbeat();
        }
        return true;
      }
    } catch {
      // A successful canonical save remains authoritative even if cleanup fails.
    }
    return false;
  }

  private clearOwnedDraftCopies(expectedReference: DraftReference): boolean {
    const draftStorage = this.storage.draftStorage;
    if (draftStorage === undefined) {
      return false;
    }
    const references: DraftReference[] = [];
    let keys: readonly string[] | undefined;
    try {
      keys = draftStorage.listKeys?.(PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX);
      if (keys === undefined) {
        return this.clearPendingNoteDraft(expectedReference, true);
      }
      for (const key of keys) {
        if (key.startsWith(PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_KEY_PREFIX)) {
          continue;
        }
        const raw = draftStorage.getItem(key);
        if (raw === null) {
          continue;
        }
      const parsed = this.parseDraftReference({
          key,
          value: raw,
          draftId: this.draftId,
        });
        if (parsed !== undefined) {
          references.push(parsed);
        }
      }
    } catch {
      return false;
    }
    if (references.length === 0) {
      references.push(expectedReference);
    }
    const failed: DraftReference[] = [];
    for (const reference of references) {
      if (!this.clearPendingNoteDraft(reference, true)) {
        failed.push(reference);
      }
    }
    if (failed.length === 0) {
      return true;
    }
    const retained = references.find((reference) => {
      try {
        return draftStorage.getItem(reference.key) !== null;
      } catch {
        return false;
      }
    }) ?? failed[0];
    this.activeDraftReference = retained;
    this.activeDraftOwned = true;
    this.latestDraftRevision = retained.revision;
    const parsed = this.parseDraftReference(retained);
    const validated = parsed === undefined ? undefined : validatePrivateState(parsed.state);
    if (validated?.ok) {
      this.unsavedDraft = cloneState(validated.value);
    }
    this.recoveredForeignReference = undefined;
    this.recoveredDraftPresented = false;
    this.startDraftHeartbeat();
    return false;
  }

  private retainForeignRecovery(reference: DraftReference): void {
    let retained = reference;
    try {
      const raw = this.storage.draftStorage?.getItem(reference.key);
      if (raw !== null && raw !== undefined) {
        const current = this.parseDraftReference({ ...reference, value: raw });
        if (current !== undefined) {
          retained = {
            key: current.key,
            value: current.value,
            draftId: current.draftId,
            revision: current.revision,
          };
        }
      }
    } catch {
      // Keep the last verified reference; the next read can retry discovery.
    }
    this.recoveredForeignReference = retained;
    this.recoveredDraftPresented = false;
    const parsed = this.parseDraftReference(retained);
    if (parsed !== undefined) {
      const validated = validatePrivateState(parsed.state);
      if (validated.ok) {
        this.unsavedDraft = cloneState(validated.value);
      }
    }
  }

  private restorePendingNoteDraft(retireExactMatch = true): void {
    const draftStorage = this.storage.draftStorage;
    if (draftStorage === undefined) {
      return;
    }
    const pendingForeignRetirement = this.supersededDraftReference?.draftId === this.draftId
      ? undefined
      : this.supersededDraftReference;
    if (retireExactMatch && pendingForeignRetirement !== undefined && this.consumeSupersededDraft(pendingForeignRetirement)) {
      this.supersededDraftReference = undefined;
      this.activeDraftReference = undefined;
      this.activeDraftOwned = false;
      this.latestDraftRevision = undefined;
      this.recoveredForeignReference = undefined;
      this.recoveredDraftPresented = false;
      this.unsavedDraft = undefined;
      this.stopDraftHeartbeat();
    }
    if (retireExactMatch) {
      this.reclaimConsumedDrafts(draftStorage);
    }
    const keys = this.draftKeys(draftStorage);
    const candidates = keys
      .map((key) => {
        try {
          const raw = draftStorage.getItem(key);
          if (raw === null) {
            return undefined;
          }
          let draftId = key.slice(PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX.length);
          try {
            const parsed = JSON.parse(raw) as { draftId?: unknown };
            if (typeof parsed.draftId === "string") {
              draftId = parsed.draftId;
            }
          } catch {
            return undefined;
          }
          return this.parseDraftReference({ key, value: raw, draftId });
        } catch {
          return undefined;
        }
      })
      .filter((candidate): candidate is PendingNoteDraftRecord & { readonly key: string; readonly value: string } =>
        candidate !== undefined
        && candidate.ownerState !== "consumed"
        && !this.isDraftTombstoned(candidate));
    const sortByNewest = (left: PendingNoteDraftRecord, right: PendingNoteDraftRecord): number =>
      right.updatedAt - left.updatedAt || right.revision.localeCompare(left.revision);
    const selected = candidates.filter((candidate) => candidate.draftId === this.draftId)
      .sort(sortByNewest)[0]
      ?? candidates.sort(sortByNewest)[0];
    if (selected === undefined) {
      if (this.recoveredForeignReference !== undefined) {
        this.activeDraftReference = undefined;
        this.activeDraftOwned = false;
        this.latestDraftRevision = undefined;
        this.recoveredForeignReference = undefined;
        this.recoveredDraftPresented = false;
        this.unsavedDraft = undefined;
      }
      return;
    }
    this.activeDraftReference = {
      key: selected.key,
      value: selected.value,
      draftId: selected.draftId,
      revision: selected.revision,
    };
    this.activeDraftOwned = selected.draftId === this.draftId;
    this.latestDraftRevision = this.activeDraftOwned ? selected.revision : undefined;
    this.recoveredForeignReference = this.activeDraftOwned ? undefined : { ...this.activeDraftReference };
    const validated = validatePrivateState(selected.state);
    if (!validated.ok) {
      return;
    }
    if (retireExactMatch && this.lastKnownGood !== undefined && sameState(this.lastKnownGood, validated.value)) {
      const selectedReference = {
        key: selected.key,
        value: selected.value,
        draftId: selected.draftId,
        revision: selected.revision,
      };
      const retired = selected.draftId === this.draftId
        ? this.clearOwnedDraftCopies(selectedReference)
        : this.consumeSupersededDraft(selectedReference);
      if (!retired) {
        return;
      }
      this.activeDraftReference = undefined;
      this.activeDraftOwned = false;
      this.latestDraftRevision = undefined;
      this.recoveredForeignReference = undefined;
      this.recoveredDraftPresented = false;
      this.unsavedDraft = undefined;
      this.stopDraftHeartbeat();
      return;
    }
    this.unsavedDraft = cloneState(validated.value);
    this.recoveredDraftPresented = false;
    this.hasObservedRaw = selected.hasObservedRaw;
    this.observedRaw = selected.hasObservedRaw ? selected.observedRaw : undefined;
  }

  private isDraftTombstoned(candidate: PendingNoteDraftRecord & { readonly key: string; readonly value: string }): boolean {
    const draftStorage = this.storage.draftStorage;
    if (draftStorage === undefined) {
      return false;
    }
    try {
      return this.tombstoneKeys(draftStorage).some((tombstoneKey) => {
        const raw = draftStorage.getItem(tombstoneKey);
        if (raw === null) {
          return false;
        }
        const tombstone = this.parseConsumedDraftRecord(raw);
        return tombstone !== undefined
          && tombstone.sourceKey === candidate.key
          && tombstone.sourceDraftId === candidate.draftId
          && tombstone.sourceRevision === candidate.revision;
      });
    } catch {
      return false;
    }
  }

  private reclaimConsumedDrafts(draftStorage: DraftStorageLike): void {
    for (const tombstoneKey of this.tombstoneKeys(draftStorage)) {
      try {
        const tombstoneRaw = draftStorage.getItem(tombstoneKey);
        if (tombstoneRaw === null) {
          continue;
        }
        const tombstone = this.parseConsumedDraftRecord(tombstoneRaw);
        if (tombstone === undefined) {
          // It cannot suppress or safely identify a source; discard only the
          // malformed marker and leave every recovery record untouched.
          this.removeTombstoneIfUnchanged(draftStorage, tombstoneKey, tombstoneRaw);
          continue;
        }
        const sourceRaw = draftStorage.getItem(tombstone.sourceKey);
        if (sourceRaw === null) {
          this.removeTombstoneIfUnchanged(draftStorage, tombstoneKey, tombstoneRaw);
          continue;
        }
        const source = this.parseDraftReference({
          key: tombstone.sourceKey,
          value: sourceRaw,
          draftId: tombstone.sourceDraftId,
        });
        if (source === undefined || source.revision !== tombstone.sourceRevision) {
          this.removeTombstoneIfUnchanged(draftStorage, tombstoneKey, tombstoneRaw);
          continue;
        }
        // An explicit inactive lifecycle marker is the only safe reclamation
        // authority; active or uncleanly terminated owners remain recoverable.
        if (source.ownerState !== "inactive") {
          continue;
        }
        const confirmedRaw = draftStorage.getItem(tombstone.sourceKey);
        if (confirmedRaw !== sourceRaw) {
          continue;
        }
        if (draftStorage.getItem(tombstoneKey) !== tombstoneRaw) {
          continue;
        }
        // Owners rotate to a new physical key whenever this tombstone exists,
        // so deleting this unchanged key cannot remove a later owner revision.
        draftStorage.removeItem(tombstone.sourceKey);
        this.removeTombstoneIfUnchanged(draftStorage, tombstoneKey, tombstoneRaw);
      } catch {
        // Recovery cleanup is best effort and must never block loading state.
      }
    }
  }

  private removeTombstoneIfUnchanged(
    draftStorage: DraftStorageLike,
    tombstoneKey: string,
    expectedRaw: string,
  ): void {
    try {
      if (draftStorage.getItem(tombstoneKey) === expectedRaw) {
        draftStorage.removeItem(tombstoneKey);
      }
    } catch {
      // Recovery cleanup remains best effort.
    }
  }

  private parseConsumedDraftRecord(raw: string): ConsumedDraftRecord | undefined {
    try {
      const candidate = JSON.parse(raw) as Partial<ConsumedDraftRecord>;
      if (
        candidate.schema !== PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_SCHEMA
        || candidate.schemaVersion !== PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_VERSION
        || typeof candidate.sourceKey !== "string"
        || !candidate.sourceKey.startsWith(PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX)
        || typeof candidate.sourceDraftId !== "string"
        || typeof candidate.sourceRevision !== "string"
        || candidate.sourceRevision.length === 0
        || typeof candidate.consumedAt !== "number"
        || !Number.isFinite(candidate.consumedAt)
      ) {
        return undefined;
      }
      return {
        schema: PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_SCHEMA,
        schemaVersion: PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_VERSION,
        sourceKey: candidate.sourceKey,
        sourceDraftId: candidate.sourceDraftId,
        sourceRevision: candidate.sourceRevision,
        consumedAt: candidate.consumedAt,
      };
    } catch {
      return undefined;
    }
  }

  private draftKeys(draftStorage: DraftStorageLike): readonly string[] {
    const ownKey = getPendingNoteDraftKey(this.draftId);
    try {
      const keys = draftStorage.listKeys?.(PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX);
      if (keys !== undefined) {
        return keys.filter((key) => !key.startsWith(PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_KEY_PREFIX));
      }
    } catch {
      return [ownKey];
    }
    return [ownKey];
  }

  private tombstoneKeys(draftStorage: DraftStorageLike): readonly string[] {
    const ownKey = getConsumedDraftKey(this.draftId);
    try {
      const keys = draftStorage.listKeys?.(PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_KEY_PREFIX);
      if (keys !== undefined) {
        return keys.filter((key) => key.startsWith(PRIVATE_STATE_NOTE_DRAFT_TOMBSTONE_KEY_PREFIX));
      }
    } catch {
      return [ownKey];
    }
    return [ownKey];
  }

  private parseDraftReference(reference: DraftReference): (PendingNoteDraftRecord & {
    readonly key: string;
    readonly value: string;
  }) | undefined {
    if (!reference.key.startsWith(PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX)) {
      return undefined;
    }
    let candidate: Partial<PendingNoteDraftRecord>;
    try {
      candidate = JSON.parse(reference.value) as Partial<PendingNoteDraftRecord>;
    } catch {
      return undefined;
    }
    if (
      candidate.schema !== PRIVATE_STATE_NOTE_DRAFT_SCHEMA
      || candidate.schemaVersion !== PRIVATE_STATE_NOTE_DRAFT_VERSION
      || candidate.draftId !== reference.draftId
      || (candidate.revision !== undefined
        && (typeof candidate.revision !== "string" || candidate.revision.length === 0))
      || typeof candidate.hasObservedRaw !== "boolean"
      || typeof candidate.updatedAt !== "number"
      || !Number.isFinite(candidate.updatedAt)
      || (candidate.ownerState !== undefined
        && candidate.ownerState !== "active"
        && candidate.ownerState !== "inactive"
        && candidate.ownerState !== "consumed")
      || (candidate.hasObservedRaw
        ? (typeof candidate.observedRaw !== "string" && candidate.observedRaw !== null)
        : candidate.observedRaw !== null)
    ) {
      return undefined;
    }
    const validated = validatePrivateState(candidate.state);
    if (!validated.ok) {
      return undefined;
    }
    if (candidate.hasObservedRaw && typeof candidate.observedRaw === "string") {
      let baselineCandidate: unknown;
      try {
        baselineCandidate = JSON.parse(candidate.observedRaw) as unknown;
      } catch {
        return undefined;
      }
      if (!validatePrivateState(baselineCandidate).ok) {
        return undefined;
      }
    }
    return {
      schema: PRIVATE_STATE_NOTE_DRAFT_SCHEMA,
      schemaVersion: PRIVATE_STATE_NOTE_DRAFT_VERSION,
      draftId: candidate.draftId,
      state: candidate.state,
      revision: candidate.revision ?? `legacy:${candidate.updatedAt}`,
      hasObservedRaw: candidate.hasObservedRaw,
      observedRaw: candidate.observedRaw ?? null,
      updatedAt: candidate.updatedAt,
      ownerState: candidate.ownerState ?? "active",
      key: reference.key,
      value: reference.value,
    };
  }

  private enqueue(state: PrivateState, operation: SaveOperation): Promise<SaveResult> {
    const run = this.queue.then(() => {
      const latestGeneration = operation.kind === "immediate"
        ? this.immediateGeneration
        : this.noteGeneration;
      if (operation.generation < latestGeneration) {
        return success({ state: this.lastReadable(), skipped: true });
      }
      return this.commit(state, operation).then((result) => {
        if (result.ok && operation.draftToken === this.latestDraftToken) {
          const ownedReferences = [
            operation.draftStorageReference,
            this.activeDraftOwned ? this.activeDraftReference : undefined,
            operation.supersededDraftReference?.draftId === this.draftId
              ? operation.supersededDraftReference
              : undefined,
          ].filter((reference): reference is DraftReference => reference !== undefined)
            .filter((reference, index, references) => references.findIndex((candidate) => candidate.key === reference.key) === index);
          const ownedRetired = ownedReferences.every((reference) => this.clearPendingNoteDraft(reference, true));
          const foreignReference = operation.supersededDraftReference?.draftId === this.draftId
            ? undefined
            : operation.supersededDraftReference;
          const foreignRetired = foreignReference === undefined
            || this.consumeSupersededDraft(foreignReference);
          if (ownedRetired && foreignRetired) {
            const retainRecovery = operation.recoveryDraftReference !== undefined
              && (foreignReference === undefined || foreignReference.key !== operation.recoveryDraftReference.key);
            if (retainRecovery) {
              this.retainForeignRecovery(operation.recoveryDraftReference);
              // This source was only retained because the submitted state did
              // not adopt it. Keep it as recovery, never as a retirement
              // candidate for a later unrelated save.
              this.supersededDraftReference = undefined;
            } else {
              this.unsavedDraft = undefined;
              this.recoveredForeignReference = undefined;
              this.recoveredDraftPresented = false;
              this.supersededDraftReference = undefined;
            }
          } else {
            if (!ownedRetired && ownedReferences.length > 0) {
              const retainedOwned = ownedReferences.find((reference) => {
                try {
                  return this.storage.draftStorage?.getItem(reference.key) !== null;
                } catch {
                  return false;
                }
              });
              if (retainedOwned !== undefined) {
                this.activeDraftReference = retainedOwned;
                this.activeDraftOwned = true;
                this.latestDraftRevision = retainedOwned.revision;
              }
              this.unsavedDraft = cloneState(state);
              this.startDraftHeartbeat();
            }
            if (!foreignRetired && foreignReference !== undefined) {
              this.retainForeignRecovery(foreignReference);
              this.supersededDraftReference = foreignReference;
            }
            if (foreignRetired && operation.recoveryDraftReference !== undefined
              && (foreignReference === undefined || foreignReference.key !== operation.recoveryDraftReference.key)) {
              this.retainForeignRecovery(operation.recoveryDraftReference);
              // A retained, non-adopted recovery must not become superseded;
              // a later ordinary save must leave it recoverable.
              this.supersededDraftReference = undefined;
            }
            this.recoveredDraftPresented = false;
          }
        }
        return result;
      });
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private commit(state: PrivateState, operation: SaveOperation): Promise<SaveResult> {
    if (this.storage.withLock === undefined) {
      if (!this.isOperationCurrent(operation)) {
        return Promise.resolve(success({ state: this.lastReadable(), skipped: true }));
      }
      return Promise.resolve(this.commitWithinLock(state));
    }
    return this.storage.withLock(() => {
      if (!this.isOperationCurrent(operation)) {
        return Promise.resolve(success({ state: this.lastReadable(), skipped: true }));
      }
      return Promise.resolve(this.commitWithinLock(state));
    }).catch(() => error("STORAGE_COMMIT_UNCERTAIN"));
  }

  private isOperationCurrent(operation: SaveOperation): boolean {
    return operation.kind === "immediate"
      ? operation.generation === this.immediateGeneration
      : operation.generation === this.noteGeneration;
  }

  private commitWithinLock(state: PrivateState): SaveResult {
    const serialized = serializePrivateState(state);
    if (!serialized.ok) {
      return error("STORAGE_WRITE_FAILED");
    }
    let previous: string | null;
    try {
      previous = this.storage.getItem(PRIVATE_STATE_STORAGE_KEY);
    } catch {
      return error("STORAGE_UNAVAILABLE");
    }
    if (!this.hasObservedRaw) {
      if (previous !== null) {
        let previousCandidate: unknown;
        try {
          previousCandidate = JSON.parse(previous) as unknown;
        } catch {
          return error("LOCAL_STATE_UNREADABLE");
        }
        const previousState = validatePrivateState(previousCandidate);
        if (!previousState.ok) {
          return error(classifyStateError(previousState.error));
        }
        return error("STORAGE_COMMIT_UNCERTAIN");
      }
      this.observedRaw = previous;
      this.hasObservedRaw = true;
    } else if (previous !== this.observedRaw) {
      return error("STORAGE_COMMIT_UNCERTAIN");
    }
    if (previous !== null) {
      let previousCandidate: unknown;
      try {
        previousCandidate = JSON.parse(previous) as unknown;
      } catch {
        return error("LOCAL_STATE_UNREADABLE");
      }
      const previousState = validatePrivateState(previousCandidate);
      if (!previousState.ok) {
        return error(classifyStateError(previousState.error));
      }
      this.lastKnownGood = cloneState(previousState.value);
    }
    try {
      this.storage.setItem(PRIVATE_STATE_STORAGE_KEY, serialized.value);
    } catch (cause) {
      return this.readAfterFailedWrite(previous, isQuotaError(cause));
    }
    let readBack: string | null;
    try {
      readBack = this.storage.getItem(PRIVATE_STATE_STORAGE_KEY);
    } catch {
      return error("STORAGE_COMMIT_UNCERTAIN");
    }
    if (readBack !== serialized.value) {
      return error("STORAGE_COMMIT_UNCERTAIN");
    }
    const validated = validatePrivateState(JSON.parse(readBack) as unknown);
    if (!validated.ok) {
      return error("STORAGE_COMMIT_UNCERTAIN");
    }
    this.observedRaw = readBack;
    this.hasObservedRaw = true;
    this.lastKnownGood = cloneState(validated.value);
    return success({ state: cloneState(validated.value) });
  }

  private readAfterFailedWrite(previous: string | null, quota: boolean): SaveResult {
    try {
      const current = this.storage.getItem(PRIVATE_STATE_STORAGE_KEY);
      if (current === previous) {
        return error(quota ? "STORAGE_QUOTA_EXCEEDED" : "STORAGE_WRITE_FAILED");
      }
    } catch {
      return error("STORAGE_COMMIT_UNCERTAIN");
    }
    return error("STORAGE_COMMIT_UNCERTAIN");
  }
}
