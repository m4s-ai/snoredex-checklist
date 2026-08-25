import {
  serializePrivateState,
  validatePrivateState,
  type PrivateState,
  type StateErrorCode,
} from "./domain.ts";

export const PRIVATE_STATE_STORAGE_KEY = "snoredex-checklist.private-state";
export const NOTE_AUTOSAVE_DELAY_MS = 3_000;

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

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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
    return success(globalThis.localStorage);
  } catch {
    return error("STORAGE_UNAVAILABLE");
  }
}

/**
 * The sole v1 browser-local state authority. All writes pass through one queue;
 * callers never write the namespaced key directly.
 */
export class OrderedStateStore {
  private readonly storage: StorageLike;
  private readonly clock: TimerClock;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private lastKnownGood: PrivateState | undefined;
  private unsavedDraft: PrivateState | undefined;
  private pendingNote: PendingNote | undefined;

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
    if (raw === null) {
      this.lastKnownGood = undefined;
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
    return success(cloneState(validated.value));
  }

  public lastReadable(): PrivateState | undefined {
    return this.lastKnownGood === undefined ? undefined : cloneState(this.lastKnownGood);
  }

  public unsaved(): PrivateState | undefined {
    return this.unsavedDraft === undefined ? undefined : cloneState(this.unsavedDraft);
  }

  public saveImmediate(state: PrivateState): Promise<SaveResult> {
    this.generation += 1;
    this.cancelPendingNote();
    return this.enqueue(state, this.generation);
  }

  public scheduleNoteSave(state: PrivateState): void {
    this.generation += 1;
    this.cancelPendingNote();
    const generation = this.generation;
    const timer = this.clock.setTimeout(() => {
      if (this.pendingNote?.generation === generation) {
        void this.flushNoteForGeneration(generation);
      }
    }, NOTE_AUTOSAVE_DELAY_MS);
    this.pendingNote = { state: cloneState(state), generation, timer };
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
    return this.enqueue(pending.state, pending.generation);
  }

  private cancelPendingNote(): void {
    if (this.pendingNote !== undefined) {
      this.clock.clearTimeout(this.pendingNote.timer);
      this.pendingNote = undefined;
    }
  }

  private enqueue(state: PrivateState, generation: number): Promise<SaveResult> {
    this.unsavedDraft = cloneState(state);
    const run = this.queue.then(() => {
      if (generation < this.generation) {
        return success({ state: this.lastReadable(), skipped: true });
      }
      const result = this.commit(state);
      if (result.ok && generation === this.generation) {
        this.unsavedDraft = undefined;
      }
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private commit(state: PrivateState): SaveResult {
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
