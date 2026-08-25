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
/** A pending draft is considered owned while its tab refreshes this lease. */
export const DRAFT_OWNER_LEASE_MS = 30_000;
const DRAFT_OWNER_HEARTBEAT_MS = 5_000;

const PRIVATE_STATE_NOTE_DRAFT_SCHEMA = "snoredex-checklist.pending-note";
const PRIVATE_STATE_NOTE_DRAFT_VERSION = 1;
const PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX = `${PRIVATE_STATE_NOTE_DRAFT_KEY}:`;

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
}

interface SaveOperation {
  readonly kind: "immediate" | "note";
  readonly generation: number;
  readonly draftToken: number;
  readonly draftStorageReference: DraftReference | undefined;
}

interface PendingNoteDraftRecord {
  readonly schema: typeof PRIVATE_STATE_NOTE_DRAFT_SCHEMA;
  readonly schemaVersion: typeof PRIVATE_STATE_NOTE_DRAFT_VERSION;
  readonly draftId: string;
  readonly state: unknown;
  readonly hasObservedRaw: boolean;
  readonly observedRaw: string | null;
  readonly updatedAt: number;
}

interface DraftReference {
  readonly key: string;
  readonly value: string;
  readonly draftId: string;
}

export function getPendingNoteDraftKey(draftId: string): string {
  return `${PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX}${draftId}`;
}

let generatedDraftId = 0;

function createDraftId(): string {
  generatedDraftId += 1;
  const cryptoValue = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const randomId = cryptoValue?.randomUUID?.();
  if (randomId !== undefined) {
    return `store-${randomId}`;
  }
  return `store-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${generatedDraftId.toString(36)}`;
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
  private lastKnownGood: PrivateState | undefined;
  private unsavedDraft: PrivateState | undefined;
  private pendingNote: PendingNote | undefined;
  private draftHeartbeatTimer: unknown;
  private activeDraftReference: DraftReference | undefined;
  private activeDraftOwned = false;
  private observedRaw: string | null | undefined;
  private hasObservedRaw = false;

  public constructor(storage: StorageLike, clock: TimerClock = browserClock) {
    this.storage = storage;
    this.clock = clock;
    this.draftId = storage.draftId ?? createDraftId();
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
    const previousReference = this.activeDraftReference;
    const previousObservedRaw = this.observedRaw;
    const previousHasObservedRaw = this.hasObservedRaw;
    const previousLastKnownGood = this.lastKnownGood === undefined ? undefined : cloneState(this.lastKnownGood);
    this.observedRaw = raw;
    this.hasObservedRaw = true;
    this.lastKnownGood = current === undefined ? undefined : cloneState(current);
    const persistedReference = this.persistPendingNoteDraft(draft);
    if (this.storage.draftStorage !== undefined && persistedReference === undefined) {
      this.observedRaw = previousObservedRaw;
      this.hasObservedRaw = previousHasObservedRaw;
      this.lastKnownGood = previousLastKnownGood;
      return error("STORAGE_WRITE_FAILED");
    }
    if (previousReference !== undefined
      && persistedReference?.key !== previousReference.key
      && (previousReference.draftId === this.draftId || !this.isDraftOwnerActive(previousReference))) {
      this.clearPendingNoteDraft(previousReference);
    }
    this.startDraftHeartbeat();
    return success(draft);
  }

  /** Explicitly discard a recovered or pending note draft without changing canonical state. */
  public discardUnsavedDraft(): void {
    this.noteGeneration += 1;
    this.cancelPendingNote();
    this.nextDraftToken += 1;
    this.latestDraftToken = this.nextDraftToken;
    const reference = this.activeDraftOwned ? this.activeDraftReference : undefined;
    this.activeDraftReference = undefined;
    this.activeDraftOwned = false;
    this.unsavedDraft = undefined;
    this.clearPendingNoteDraft(reference);
  }

  public saveImmediate(state: PrivateState): Promise<SaveResult> {
    const generation = ++this.immediateGeneration;
    const previousDraft = this.activeDraftOwned ? this.activeDraftReference : undefined;
    this.cancelPendingNote();
    const draftToken = this.rememberDraft(state);
    return this.enqueue(state, {
      kind: "immediate",
      generation,
      draftToken,
      draftStorageReference: previousDraft,
    });
  }

  public scheduleNoteSave(state: PrivateState): void {
    const generation = ++this.noteGeneration;
    this.cancelPendingNote();
    const draftToken = this.rememberDraft(state);
    const previousDraft = this.activeDraftOwned ? this.activeDraftReference : undefined;
    const draftStorageReference = this.persistPendingNoteDraft(state) ?? previousDraft;
    if (draftStorageReference !== undefined && previousDraft?.key !== draftStorageReference.key) {
      this.clearPendingNoteDraft(previousDraft);
    }
    const timer = this.clock.setTimeout(() => {
      if (this.pendingNote?.generation === generation) {
        void this.flushNoteForGeneration(generation);
      }
    }, NOTE_AUTOSAVE_DELAY_MS);
    this.pendingNote = { state: cloneState(state), generation, timer, draftToken, draftStorageReference };
    this.startDraftHeartbeat();
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
    this.unsavedDraft = cloneState(state);
    return draftToken;
  }

  private persistPendingNoteDraft(state: PrivateState): DraftReference | undefined {
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
      draftId: this.draftId,
      state: JSON.parse(serialized.value) as unknown,
      hasObservedRaw: this.hasObservedRaw,
      observedRaw: this.hasObservedRaw ? this.observedRaw ?? null : null,
      updatedAt: Date.now(),
    };
    try {
      const value = JSON.stringify(record);
      const key = getPendingNoteDraftKey(this.draftId);
      draftStorage.setItem(key, value);
      const reference = { key, value, draftId: this.draftId };
      this.activeDraftReference = reference;
      this.activeDraftOwned = true;
      return reference;
    } catch {
      // Keep the in-memory draft and let the canonical save report its own result.
      return undefined;
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
      this.persistPendingNoteDraft(this.unsavedDraft);
      this.startDraftHeartbeat();
    }, DRAFT_OWNER_HEARTBEAT_MS);
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
      return parsed !== undefined && Date.now() - parsed.updatedAt <= DRAFT_OWNER_LEASE_MS;
    } catch {
      // An unreadable owner marker is not evidence that a foreign tab is live.
      return false;
    }
  }

  private clearPendingNoteDraft(expectedReference: DraftReference | undefined): void {
    if (expectedReference === undefined) {
      return;
    }
    try {
      const draftStorage = this.storage.draftStorage;
      if (draftStorage?.getItem(expectedReference.key) === expectedReference.value) {
        draftStorage.removeItem(expectedReference.key);
        if (this.activeDraftReference?.key === expectedReference.key
          && this.activeDraftReference.value === expectedReference.value) {
          this.activeDraftReference = undefined;
          this.activeDraftOwned = false;
          this.stopDraftHeartbeat();
        }
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
    const keys = this.draftKeys(draftStorage);
    const candidates = keys
      .map((key) => {
        try {
          const raw = draftStorage.getItem(key);
          return raw === null ? undefined : this.parseDraftReference({
            key,
            value: raw,
            draftId: key.slice(PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX.length),
          });
        } catch {
          return undefined;
        }
      })
      .filter((candidate): candidate is PendingNoteDraftRecord & { readonly key: string; readonly value: string } =>
        candidate !== undefined);
    const selected = candidates.find((candidate) => candidate.draftId === this.draftId)
      ?? candidates.sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (selected === undefined) {
      return;
    }
    this.activeDraftReference = {
      key: selected.key,
      value: selected.value,
      draftId: selected.draftId,
    };
    this.activeDraftOwned = selected.draftId === this.draftId;
    const validated = validatePrivateState(selected.state);
    if (!validated.ok) {
      return;
    }
    this.unsavedDraft = cloneState(validated.value);
    this.hasObservedRaw = selected.hasObservedRaw;
    this.observedRaw = selected.hasObservedRaw ? selected.observedRaw : undefined;
  }

  private draftKeys(draftStorage: DraftStorageLike): readonly string[] {
    const ownKey = getPendingNoteDraftKey(this.draftId);
    try {
      const keys = draftStorage.listKeys?.(PRIVATE_STATE_NOTE_DRAFT_KEY_PREFIX);
      if (keys !== undefined) {
        return keys;
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
      || typeof candidate.hasObservedRaw !== "boolean"
      || typeof candidate.updatedAt !== "number"
      || !Number.isFinite(candidate.updatedAt)
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
      hasObservedRaw: candidate.hasObservedRaw,
      observedRaw: candidate.observedRaw ?? null,
      updatedAt: candidate.updatedAt,
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
          this.unsavedDraft = undefined;
          this.clearPendingNoteDraft(operation.draftStorageReference);
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
