import {
  serializePortableState,
  validatePrivateState,
  validatePortableState,
  type PrivateState,
  type PortablePrivateState,
  type StateErrorCode,
} from "./domain.ts";
import {
  readStateAuthority,
  serializeStateAuthority,
  type AuthorityReadResult,
} from "./authority.ts";
import { PRIVATE_STATE_STORAGE_KEY, type StorageLike } from "./storage.ts";

export const MAX_PORTABLE_BYTES = 16 * 1024 * 1024;
export const PRIVATE_BACKUP_SUFFIX = ".snoredex-private.json";
export const SUGGESTED_BACKUP_FILENAME = `snoredex-checklist-backup${PRIVATE_BACKUP_SUFFIX}`;

export const BACKUP_ERROR_CODES = [
  "IMPORT_FILE_TOO_LARGE",
  "IMPORT_FILE_READ_FAILED",
  "IMPORT_INVALID_ENCODING",
  "IMPORT_INVALID_JSON",
  "IMPORT_UNSUPPORTED_STATE_SCHEMA",
  "IMPORT_UNSUPPORTED_STATE_VERSION",
  "IMPORT_UNKNOWN_FIELD",
  "IMPORT_INVALID_STATE_DATA",
  "IMPORT_DUPLICATE_ITEM_ID",
  "STATE_FINGERPRINT_UNSUPPORTED",
  "STATE_RECONCILIATION_BLOCKED",
  "STATE_PORTABLE_LIMIT_EXCEEDED",
  "STATE_CHANGED_DURING_OPERATION",
  "EXPORT_FAILED",
  "STORAGE_UNAVAILABLE",
  "STORAGE_QUOTA_EXCEEDED",
  "STORAGE_WRITE_FAILED",
  "STORAGE_COMMIT_UNCERTAIN",
  "LOCAL_STATE_UNSUPPORTED",
  "LOCAL_STATE_UNREADABLE",
] as const;
export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number];

export type BackupResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BackupErrorCode };

export interface ExportedBackup {
  readonly filename: string;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly state: PrivateState;
}

export interface BackupExportOptions {
  readonly appRevision: unknown;
  readonly exportedAt?: unknown;
  readonly filename?: string;
}

export interface ImportPreview {
  readonly mode: "create" | "replace";
  readonly sourceFingerprint: string;
  readonly targetFingerprint: string;
  readonly schemaVersion: string;
  readonly explicitRecordCount: number;
  readonly statusCounts: Readonly<Record<"need" | "ordered" | "have" | "skip", number>>;
  readonly quantityOwned: number;
  readonly quantityOrdered: number;
  readonly noteCount: number;
  readonly recordsToReplace: number;
}

export interface ImportPlan {
  readonly candidate: PrivateState;
  readonly preview: ImportPreview;
  readonly expectedRaw: string | null;
}

export interface LifecycleSuccess {
  readonly active: PrivateState | undefined;
  readonly recovery: PrivateState | undefined;
  readonly changed: boolean;
}

export type LifecycleResult = BackupResult<LifecycleSuccess>;

function ok<T>(value: T): BackupResult<T> {
  return { ok: true, value };
}

function fail<T>(error: BackupErrorCode): BackupResult<T> {
  return { ok: false, error };
}

function mapStateError(error: StateErrorCode): BackupErrorCode {
  switch (error) {
    case "IMPORT_UNSUPPORTED_STATE_SCHEMA":
    case "IMPORT_UNSUPPORTED_STATE_VERSION":
    case "IMPORT_UNKNOWN_FIELD":
    case "IMPORT_INVALID_STATE_DATA":
    case "IMPORT_DUPLICATE_ITEM_ID":
      return error;
    default:
      return "IMPORT_INVALID_STATE_DATA";
  }
}

function isQuotaError(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("name" in value)) return false;
  const name = (value as { name?: unknown }).name;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function normalizeFilename(filename: string | undefined): string {
  if (filename === undefined || !filename.endsWith(PRIVATE_BACKUP_SUFFIX)) {
    return SUGGESTED_BACKUP_FILENAME;
  }
  // A caller may provide a product-controlled localized label, but never a
  // user value. Keep path separators and control characters out of downloads.
  const basename = filename.replace(/[\\/\u0000-\u001f\u007f]/g, "_");
  return basename.endsWith(PRIVATE_BACKUP_SUFFIX) ? basename : SUGGESTED_BACKUP_FILENAME;
}

export function createPortableBackup(
  input: unknown,
  options: BackupExportOptions,
): BackupResult<ExportedBackup> {
  const state = validatePrivateState(input);
  if (!state.ok) return fail("EXPORT_FAILED");
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const serialized = serializePortableState(state.value, {
    exportedAt,
    appRevision: options.appRevision,
  });
  if (!serialized.ok) return fail("EXPORT_FAILED");
  const bytes = new TextEncoder().encode(serialized.value);
  if (bytes.byteLength > MAX_PORTABLE_BYTES) return fail("STATE_PORTABLE_LIMIT_EXCEEDED");
  return ok({
    filename: normalizeFilename(options.filename),
    text: serialized.value,
    bytes,
    byteLength: bytes.byteLength,
    state: state.value,
  });
}

export function parsePortableBackup(input: Uint8Array): BackupResult<{
  readonly state: PortablePrivateState;
  readonly text: string;
  readonly byteLength: number;
}> {
  if (!(input instanceof Uint8Array)) return fail("IMPORT_FILE_READ_FAILED");
  if (input.byteLength > MAX_PORTABLE_BYTES) return fail("IMPORT_FILE_TOO_LARGE");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    return fail("IMPORT_INVALID_ENCODING");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(text) as unknown;
  } catch {
    return fail("IMPORT_INVALID_JSON");
  }
  const state = validatePortableState(candidate);
  if (!state.ok) return fail(mapStateError(state.error));
  return ok({ state: state.value, text, byteLength: input.byteLength });
}

export async function parsePortableBackupFrom(
  read: () => Promise<Uint8Array>,
): Promise<BackupResult<{ readonly state: PortablePrivateState; readonly text: string; readonly byteLength: number }>> {
  let bytes: Uint8Array;
  try {
    bytes = await read();
  } catch {
    return fail("IMPORT_FILE_READ_FAILED");
  }
  return parsePortableBackup(bytes);
}

function aggregate(state: PrivateState): Omit<ImportPreview, "mode" | "sourceFingerprint" | "targetFingerprint" | "schemaVersion" | "recordsToReplace"> {
  const statusCounts = { need: 0, ordered: 0, have: 0, skip: 0 };
  let quantityOwned = 0;
  let quantityOrdered = 0;
  let noteCount = 0;
  for (const item of state.items) {
    statusCounts[item.status] += 1;
    quantityOwned += item.quantityOwned;
    quantityOrdered += item.quantityOrdered;
    if (item.note !== undefined) noteCount += 1;
  }
  return {
    explicitRecordCount: state.items.length,
    statusCounts,
    quantityOwned,
    quantityOrdered,
    noteCount,
  };
}

export function buildImportPreview(
  state: PrivateState,
  current: PrivateState | undefined,
  targetFingerprint?: string,
): BackupResult<ImportPreview> {
  const target = targetFingerprint ?? current?.catalogueFingerprint ?? state.catalogueFingerprint;
  if (state.catalogueFingerprint !== target) return fail("STATE_FINGERPRINT_UNSUPPORTED");
  const totals = aggregate(state);
  return ok({
    mode: current === undefined || current.items.length === 0 ? "create" : "replace",
    sourceFingerprint: state.catalogueFingerprint,
    targetFingerprint: target,
    schemaVersion: state.schemaVersion,
    ...totals,
    recordsToReplace: current?.items.length ?? 0,
  });
}

function readRaw(storage: StorageLike): BackupResult<string | null> {
  try {
    return ok(storage.getItem(PRIVATE_STATE_STORAGE_KEY));
  } catch {
    return fail("STORAGE_UNAVAILABLE");
  }
}

function readAuthority(storage: StorageLike): BackupResult<{ readonly raw: string | null; readonly authority: Extract<AuthorityReadResult, { ok: true }> }> {
  const raw = readRaw(storage);
  if (!raw.ok) return raw;
  const authority = readStateAuthority(raw.value);
  return authority.ok ? ok({ raw: raw.value, authority }) : fail(authority.error);
}

function writeAuthority(
  storage: StorageLike,
  expectedRaw: string | null,
  active: PrivateState | undefined,
  recovery: PrivateState | undefined,
): BackupResult<LifecycleSuccess> {
  const current = readRaw(storage);
  if (!current.ok) return current;
  if (current.value !== expectedRaw) return fail("STATE_CHANGED_DURING_OPERATION");
  const serialized = serializeStateAuthority(active, recovery);
  if (!serialized.ok) return fail("STORAGE_WRITE_FAILED");
  try {
    storage.setItem(PRIVATE_STATE_STORAGE_KEY, serialized.value);
  } catch (cause) {
    const after = readRaw(storage);
    if (!after.ok) return fail("STORAGE_COMMIT_UNCERTAIN");
    if (after.value === expectedRaw) return fail(isQuotaError(cause) ? "STORAGE_QUOTA_EXCEEDED" : "STORAGE_WRITE_FAILED");
    return fail("STORAGE_COMMIT_UNCERTAIN");
  }
  const after = readRaw(storage);
  if (!after.ok || after.value !== serialized.value) return fail("STORAGE_COMMIT_UNCERTAIN");
  const authority = readStateAuthority(after.value);
  if (!authority.ok) return fail("STORAGE_COMMIT_UNCERTAIN");
  return ok({ active: authority.active, recovery: authority.recovery, changed: true });
}

async function exclusive<T>(storage: StorageLike, callback: () => T): Promise<T> {
  if (storage.withLock === undefined) return callback();
  return storage.withLock(async () => callback());
}

/**
 * Import, clear and recovery operations sharing the OrderedStateStore key.
 * All mutating methods require an explicit confirmation flag and re-check the
 * raw value captured by preview, so a stale preview cannot replace newer data.
 */
export class PrivateStateLifecycle {
  private readonly storage: StorageLike;
  private readonly appRevision: string;
  private readonly now: () => string;

  public constructor(storage: StorageLike, options: { readonly appRevision: string; readonly now?: () => string }) {
    this.storage = storage;
    this.appRevision = options.appRevision;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public read(): BackupResult<{ readonly active: PrivateState | undefined; readonly recovery: PrivateState | undefined }> {
    const result = readAuthority(this.storage);
    return result.ok ? ok({ active: result.value.authority.active, recovery: result.value.authority.recovery }) : result;
  }

  public exportActive(): BackupResult<ExportedBackup> {
    const current = this.read();
    if (!current.ok) return current;
    if (current.value.active === undefined || current.value.active.items.length === 0) return fail("EXPORT_FAILED");
    return createPortableBackup(current.value.active, { appRevision: this.appRevision, exportedAt: this.now() });
  }

  public exportRecovery(): BackupResult<ExportedBackup> {
    const current = this.read();
    if (!current.ok) return current;
    if (current.value.recovery === undefined) return fail("EXPORT_FAILED");
    return createPortableBackup(current.value.recovery, { appRevision: this.appRevision, exportedAt: this.now() });
  }

  public prepareImport(bytes: Uint8Array, targetFingerprint?: string): BackupResult<ImportPlan> {
    const current = readAuthority(this.storage);
    if (!current.ok) return current;
    const parsed = parsePortableBackup(bytes);
    if (!parsed.ok) return parsed;
    // Imported diagnostic metadata is intentionally not persisted as local
    // collection state. The next export gets fresh appRevision/exportedAt.
    const candidate: PrivateState = {
      schema: parsed.value.state.schema,
      schemaVersion: parsed.value.state.schemaVersion,
      datasetId: parsed.value.state.datasetId,
      catalogueFingerprint: parsed.value.state.catalogueFingerprint,
      items: parsed.value.state.items,
    };
    const preview = buildImportPreview(candidate, current.value.authority.active, targetFingerprint);
    if (!preview.ok) return preview;
    return ok({ candidate, preview: preview.value, expectedRaw: current.value.raw });
  }

  public async commitImport(plan: ImportPlan, confirmed: boolean): Promise<LifecycleResult> {
    if (!confirmed) return ok({ active: undefined, recovery: undefined, changed: false });
    return exclusive(this.storage, () => {
      const current = readAuthority(this.storage);
      if (!current.ok) return current;
      const recovery = current.value.authority.active?.items.length
        ? current.value.authority.active
        : current.value.authority.recovery;
      return writeAuthority(this.storage, plan.expectedRaw, plan.candidate, recovery);
    });
  }

  public async clear(confirmed: boolean): Promise<LifecycleResult> {
    if (!confirmed) return ok({ active: undefined, recovery: undefined, changed: false });
    return exclusive(this.storage, () => {
      const current = readAuthority(this.storage);
      if (!current.ok) return current;
      const active = current.value.authority.active;
      if (active === undefined || active.items.length === 0) {
        return ok({ active, recovery: current.value.authority.recovery, changed: false });
      }
      const empty: PrivateState = { ...active, items: [] };
      return writeAuthority(this.storage, current.value.raw, empty, active);
    });
  }

  public async restore(confirmed: boolean): Promise<LifecycleResult> {
    if (!confirmed) return ok({ active: undefined, recovery: undefined, changed: false });
    return exclusive(this.storage, () => {
      const current = readAuthority(this.storage);
      if (!current.ok) return current;
      const recovery = current.value.authority.recovery;
      if (recovery === undefined) return fail("EXPORT_FAILED");
      const active = current.value.authority.active;
      if (active === undefined || active.items.length === 0) {
        return writeAuthority(this.storage, current.value.raw, recovery, undefined);
      }
      return writeAuthority(this.storage, current.value.raw, recovery, active);
    });
  }
}
