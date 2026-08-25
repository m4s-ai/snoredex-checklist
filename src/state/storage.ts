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

const PRIVATE_STATE_NOTE_DRAFT_SCHEMA = "snoredex-checklist.pending-note";
const PRIVATE_STATE_NOTE_DRAFT_VERSION = 1;

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
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  readonly withLock?: <T>(callback: () => Promise<T>) => Promise<T>;
  readonly draftStorage?: DraftStorageLike;
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
  readonly draftStorageValue: string | undefined;
}

interface SaveOperation {
  readonly kind: "immediate" | "note";
  readonly generation: number;
  readonly draftToken: number;
  readonly draftStorageValue: string | undefined;
}

interface PendingNoteDraftRecord {
  readonly schema: typeof PRIVATE_STATE_NOTE_DRAFT_SCHEMA;
  readonly schemaVersion: typeof PRIVATE_STATE_NOTE_DRAFT_VERSION;
  readonly state: unknown;
  readonly hasObservedRaw: boolean;
  readonly observedRaw: string | null;
}

const browserClock: TimerClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
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
      withLock: (callback) => locks.request(PRIVATE_STATE_LOCK_NAME, callback),
      draftStorage: {
        getItem: (key) => storage.getItem(key),
        setItem: (key, value) => storage.setItem(key, value),
        removeItem: (key) => storage.removeItem(key),
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
  private queue: Promise<void> = Promise.resolve();
  private immediateGeneration = 0;
  private noteGeneration = 0;
  private nextDraftToken = 0;
  private latestDraftToken = 0;
  private lastKnownGood: PrivateState | undefined;
  private unsavedDraft: PrivateState | undefined;
  private pendingNote: PendingNote | undefined;
  private observedRaw: string | null | undefined;
  private hasObservedRaw = false;

  public constructor(storage: StorageLike, clock: TimerClock = browserClock) {
    this.storage = storage;
    this.clock = clock;
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
      return error("LOCAL_STATE_UNREADABLE");
    }
    const validated = validatePrivateState(candidate);
    if (!validated.ok) {
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

  public saveImmediate(state: PrivateState): Promise<SaveResult> {
    const generation = ++this.immediateGeneration;
    const previousDraft = this.readPendingNoteDraft();
    this.cancelPendingNote();
    const draftToken = this.rememberDraft(state);
    return this.enqueue(state, {
      kind: "immediate",
      generation,
      draftToken,
      draftStorageValue: this.draftMatchesState(previousDraft, state) ? previousDraft : undefined,
    });
  }

  public scheduleNoteSave(state: PrivateState): void {
    const generation = ++this.noteGeneration;
    this.cancelPendingNote();
    const draftToken = this.rememberDraft(state);
    const previousDraft = this.readPendingNoteDraft();
    const draftStorageValue = this.persistPendingNoteDraft(state) ?? previousDraft;
    const timer = this.clock.setTimeout(() => {
      if (this.pendingNote?.generation === generation) {
        void this.flushNoteForGeneration(generation);
      }
    }, NOTE_AUTOSAVE_DELAY_MS);
    this.pendingNote = { state: cloneState(state), generation, timer, draftToken, draftStorageValue };
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
    this.cancelPendingNote();
    return this.enqueue(pending.state, {
      kind: "note",
      generation: pending.generation,
      draftToken: pending.draftToken,
      draftStorageValue: pending.draftStorageValue,
    });
  }

  private cancelPendingNote(): void {
    if (this.pendingNote !== undefined) {
      this.clock.clearTimeout(this.pendingNote.timer);
      this.pendingNote = undefined;
    }
  }

  private rememberDraft(state: PrivateState): number {
    const draftToken = ++this.nextDraftToken;
    this.latestDraftToken = draftToken;
    this.unsavedDraft = cloneState(state);
    return draftToken;
  }

  private persistPendingNoteDraft(state: PrivateState): string | undefined {
    const draftStorage = this.storage.draftStorage;
    if (draftStorage === undefined) {
      return undefined;
    }
    const serialized = serializePrivateState(state);
    if (!serialized.ok) {
      return undefined;
    }
    if (this.hasObservedRaw && this.observedRaw === undefined) {
      return undefined;
    }
    const record: PendingNoteDraftRecord = {
      schema: PRIVATE_STATE_NOTE_DRAFT_SCHEMA,
      schemaVersion: PRIVATE_STATE_NOTE_DRAFT_VERSION,
      state: JSON.parse(serialized.value) as unknown,
      hasObservedRaw: this.hasObservedRaw,
      observedRaw: this.hasObservedRaw ? this.observedRaw ?? null : null,
    };
    try {
      const value = JSON.stringify(record);
      draftStorage.setItem(PRIVATE_STATE_NOTE_DRAFT_KEY, value);
      return value;
    } catch {
      // Keep the in-memory draft and let the canonical save report its own result.
      return undefined;
    }
  }

  private readPendingNoteDraft(): string | undefined {
    try {
      return this.storage.draftStorage?.getItem(PRIVATE_STATE_NOTE_DRAFT_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private draftMatchesState(raw: string | undefined, state: PrivateState): boolean {
    if (raw === undefined) {
      return false;
    }
    try {
      const candidate = JSON.parse(raw) as Partial<PendingNoteDraftRecord>;
      const serialized = serializePrivateState(state);
      return serialized.ok
        && candidate.schema === PRIVATE_STATE_NOTE_DRAFT_SCHEMA
        && candidate.schemaVersion === PRIVATE_STATE_NOTE_DRAFT_VERSION
        && JSON.stringify(candidate.state) === serialized.value;
    } catch {
      return false;
    }
  }

  private clearPendingNoteDraft(expectedValue: string | undefined): void {
    if (expectedValue === undefined) {
      return;
    }
    try {
      const draftStorage = this.storage.draftStorage;
      if (draftStorage?.getItem(PRIVATE_STATE_NOTE_DRAFT_KEY) === expectedValue) {
        draftStorage.removeItem(PRIVATE_STATE_NOTE_DRAFT_KEY);
      }
    } catch {
      // A successful canonical save remains authoritative even if cleanup fails.
    }
  }

  private restorePendingNoteDraft(): void {
    const draftStorage = this.storage.draftStorage;
    if (draftStorage === undefined) {
      return;
    }
    let raw: string | null;
    try {
      raw = draftStorage.getItem(PRIVATE_STATE_NOTE_DRAFT_KEY);
    } catch {
      return;
    }
    if (raw === null) {
      return;
    }
    try {
      const candidate = JSON.parse(raw) as Partial<PendingNoteDraftRecord>;
      if (
        candidate.schema !== PRIVATE_STATE_NOTE_DRAFT_SCHEMA
        || candidate.schemaVersion !== PRIVATE_STATE_NOTE_DRAFT_VERSION
        || typeof candidate.hasObservedRaw !== "boolean"
        || (candidate.hasObservedRaw
          ? (typeof candidate.observedRaw !== "string" && candidate.observedRaw !== null)
          : candidate.observedRaw !== null)
      ) {
        return;
      }
      const validated = validatePrivateState(candidate.state);
      if (validated.ok) {
        if (candidate.hasObservedRaw && typeof candidate.observedRaw === "string") {
          let baselineCandidate: unknown;
          try {
            baselineCandidate = JSON.parse(candidate.observedRaw) as unknown;
          } catch {
            return;
          }
          if (!validatePrivateState(baselineCandidate).ok) {
            return;
          }
        }
        this.unsavedDraft = cloneState(validated.value);
        this.hasObservedRaw = candidate.hasObservedRaw;
        this.observedRaw = candidate.hasObservedRaw ? candidate.observedRaw : undefined;
      }
    } catch {
      // Ignore an unusable recovery draft without touching the canonical state.
    }
  }

  private enqueue(state: PrivateState, operation: SaveOperation): Promise<SaveResult> {
    const run = this.queue.then(() => {
      const latestGeneration = operation.kind === "immediate"
        ? this.immediateGeneration
        : this.noteGeneration;
      if (operation.generation < latestGeneration) {
        return success({ state: this.lastReadable(), skipped: true });
      }
      return this.commit(state).then((result) => {
        if (result.ok && operation.draftToken === this.latestDraftToken) {
          this.unsavedDraft = undefined;
          this.clearPendingNoteDraft(operation.draftStorageValue);
        }
        return result;
      });
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private commit(state: PrivateState): Promise<SaveResult> {
    if (this.storage.withLock === undefined) {
      return Promise.resolve(this.commitWithinLock(state));
    }
    return this.storage.withLock(() => Promise.resolve(this.commitWithinLock(state))).catch(() =>
      error("STORAGE_COMMIT_UNCERTAIN"),
    );
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
