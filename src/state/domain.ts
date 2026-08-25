export const PRIVATE_STATE_SCHEMA = "snoredex-collection-state" as const;
export const PRIVATE_STATE_VERSION = "1.0.0" as const;
export const PRIVATE_DATASET_ID = "snoredex-data/snorlax-current-known" as const;
export const MAX_QUANTITY = 9_999;
export const MAX_NOTE_CODE_POINTS = 2_000;

const ITEM_ID_PATTERN = /^item-[0-9a-f-]{36}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const APP_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const COLLECTION_STATUSES = ["need", "ordered", "have", "skip"] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];
export type StatusCommand = CollectionStatus;

export const STATE_ERROR_CODES = [
  "IMPORT_UNSUPPORTED_STATE_SCHEMA",
  "IMPORT_UNSUPPORTED_STATE_VERSION",
  "IMPORT_UNKNOWN_FIELD",
  "IMPORT_INVALID_STATE_DATA",
  "IMPORT_DUPLICATE_ITEM_ID",
  "EDIT_INVALID_QUANTITY",
  "EDIT_INVALID_NOTE",
] as const;
export type StateErrorCode = (typeof STATE_ERROR_CODES)[number];

export interface PrivateItemState {
  readonly itemId: string;
  readonly status: CollectionStatus;
  readonly quantityOwned: number;
  readonly quantityOrdered: number;
  readonly note?: string;
}

export interface PrivateState {
  readonly schema: typeof PRIVATE_STATE_SCHEMA;
  readonly schemaVersion: typeof PRIVATE_STATE_VERSION;
  readonly datasetId: typeof PRIVATE_DATASET_ID;
  readonly catalogueFingerprint: string;
  readonly items: readonly PrivateItemState[];
}

export interface PortablePrivateState extends PrivateState {
  readonly exportedAt: string;
  readonly appRevision: string;
}

export type StateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StateErrorCode };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isValidQuantity(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_QUANTITY
  );
}

function isValidItemId(value: unknown): value is string {
  return typeof value === "string" && ITEM_ID_PATTERN.test(value);
}

function isValidFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

function isValidStatus(value: unknown): value is CollectionStatus {
  return typeof value === "string" && (COLLECTION_STATUSES as readonly string[]).includes(value);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function countCodePointsAndRejectIsolatedSurrogates(value: string): number | undefined {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return undefined;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    }
    count += 1;
  }
  return count;
}

function isValidUtcInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isValidAppRevision(value: unknown): value is string {
  return typeof value === "string" && APP_REVISION_PATTERN.test(value);
}

function fail<T>(error: StateErrorCode): StateResult<T> {
  return { ok: false, error };
}

function ok<T>(value: T): StateResult<T> {
  return { ok: true, value };
}

/** Normalize a user-authored note without interpreting or filtering its contents. */
export function normalizeNote(value: unknown): StateResult<string | undefined> {
  if (typeof value !== "string") {
    return fail("EDIT_INVALID_NOTE");
  }
  const normalized = normalizeLineEndings(value);
  const codePoints = countCodePointsAndRejectIsolatedSurrogates(normalized);
  if (codePoints === undefined || codePoints > MAX_NOTE_CODE_POINTS) {
    return fail("EDIT_INVALID_NOTE");
  }
  return ok(normalized.trim() === "" ? undefined : normalized);
}

function normalizeImportedNote(value: unknown): StateResult<string | undefined> {
  const result = normalizeNote(value);
  return result.ok ? result : fail("IMPORT_INVALID_STATE_DATA");
}

function normalizeRecordForImport(value: unknown): StateResult<PrivateItemState | undefined> {
  if (!isRecord(value)) {
    return fail("IMPORT_INVALID_STATE_DATA");
  }
  const keys = ["itemId", "status", "quantityOwned", "quantityOrdered", "note"] as const;
  if (!hasOnlyKeys(value, keys)) {
    return fail("IMPORT_UNKNOWN_FIELD");
  }
  if (
    !hasOwn(value, "itemId") ||
    !hasOwn(value, "status") ||
    !hasOwn(value, "quantityOwned") ||
    !hasOwn(value, "quantityOrdered")
  ) {
    return fail("IMPORT_INVALID_STATE_DATA");
  }
  if (
    !isValidItemId(value.itemId) ||
    !isValidStatus(value.status) ||
    !isValidQuantity(value.quantityOwned) ||
    !isValidQuantity(value.quantityOrdered)
  ) {
    return fail("IMPORT_INVALID_STATE_DATA");
  }
  const noteResult = hasOwn(value, "note")
    ? normalizeImportedNote(value.note)
    : ok<string | undefined>(undefined);
  if (!noteResult.ok) {
    return noteResult;
  }
  const { status, quantityOwned, quantityOrdered } = value;
  if (
    (status === "have" && quantityOwned < 1) ||
    (status === "ordered" && (quantityOwned !== 0 || quantityOrdered < 1)) ||
    ((status === "need" || status === "skip") &&
      (quantityOwned !== 0 || quantityOrdered !== 0))
  ) {
    return fail("IMPORT_INVALID_STATE_DATA");
  }
  const record: PrivateItemState = {
    itemId: value.itemId,
    status,
    quantityOwned,
    quantityOrdered,
    ...(noteResult.value === undefined ? {} : { note: noteResult.value }),
  };
  if (status === "need" && quantityOwned === 0 && quantityOrdered === 0 && record.note === undefined) {
    return ok(undefined);
  }
  return ok(record);
}

const STATE_KEYS = ["schema", "schemaVersion", "datasetId", "catalogueFingerprint", "items"] as const;
const PORTABLE_STATE_KEYS = [
  "schema",
  "schemaVersion",
  "datasetId",
  "catalogueFingerprint",
  "exportedAt",
  "appRevision",
  "items",
] as const;

function parseState(
  input: unknown,
  portable: boolean,
  knownItemIds?: ReadonlySet<string>,
): StateResult<PrivateState | PortablePrivateState> {
  if (!isRecord(input)) {
    return fail("IMPORT_INVALID_STATE_DATA");
  }
  if (!hasOwn(input, "schema") || input.schema !== PRIVATE_STATE_SCHEMA) {
    return fail("IMPORT_UNSUPPORTED_STATE_SCHEMA");
  }
  if (!hasOwn(input, "schemaVersion") || input.schemaVersion !== PRIVATE_STATE_VERSION) {
    return fail("IMPORT_UNSUPPORTED_STATE_VERSION");
  }
  const keys = portable ? PORTABLE_STATE_KEYS : STATE_KEYS;
  if (!hasOnlyKeys(input, keys)) {
    return fail("IMPORT_UNKNOWN_FIELD");
  }
  if (
    input.datasetId !== PRIVATE_DATASET_ID ||
    !isValidFingerprint(input.catalogueFingerprint) ||
    !Array.isArray(input.items)
  ) {
    return fail("IMPORT_INVALID_STATE_DATA");
  }
  if (portable && (!isValidUtcInstant(input.exportedAt) || !isValidAppRevision(input.appRevision))) {
    return fail("IMPORT_INVALID_STATE_DATA");
  }

  const seen = new Set<string>();
  const items: PrivateItemState[] = [];
  for (const candidate of input.items) {
    const result = normalizeRecordForImport(candidate);
    if (!result.ok) {
      return result;
    }
    if (result.value === undefined) {
      // A valid default record is still an explicit input and must participate in duplicate checks.
      if (isRecord(candidate) && typeof candidate.itemId === "string") {
        if (knownItemIds !== undefined && !knownItemIds.has(candidate.itemId)) {
          return fail("IMPORT_INVALID_STATE_DATA");
        }
        if (seen.has(candidate.itemId)) {
          return fail("IMPORT_DUPLICATE_ITEM_ID");
        }
        seen.add(candidate.itemId);
      }
      continue;
    }
    if (knownItemIds !== undefined && !knownItemIds.has(result.value.itemId)) {
      return fail("IMPORT_INVALID_STATE_DATA");
    }
    if (seen.has(result.value.itemId)) {
      return fail("IMPORT_DUPLICATE_ITEM_ID");
    }
    seen.add(result.value.itemId);
    items.push(result.value);
  }
  items.sort(compareItemIds);
  const state: PrivateState = {
    schema: PRIVATE_STATE_SCHEMA,
    schemaVersion: PRIVATE_STATE_VERSION,
    datasetId: PRIVATE_DATASET_ID,
    catalogueFingerprint: input.catalogueFingerprint,
    items,
  };
  if (!portable) {
    return ok(state);
  }
  return ok({
    ...state,
    exportedAt: input.exportedAt as string,
    appRevision: input.appRevision as string,
  });
}

export function validatePrivateState(
  input: unknown,
  knownItemIds?: ReadonlySet<string>,
): StateResult<PrivateState> {
  const result = parseState(input, false, knownItemIds);
  return result.ok ? ok(result.value as PrivateState) : result;
}

export function validatePortableState(
  input: unknown,
  knownItemIds?: ReadonlySet<string>,
): StateResult<PortablePrivateState> {
  const result = parseState(input, true, knownItemIds);
  return result.ok ? ok(result.value as PortablePrivateState) : result;
}

function compareItemIds(left: PrivateItemState, right: PrivateItemState): number {
  return left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0;
}

function serializeRecord(record: PrivateItemState): JsonRecord {
  return {
    itemId: record.itemId,
    status: record.status,
    quantityOwned: record.quantityOwned,
    quantityOrdered: record.quantityOrdered,
    ...(record.note === undefined ? {} : { note: record.note }),
  };
}

function canonicalObject(state: PrivateState, metadata?: { exportedAt: string; appRevision: string }): JsonRecord {
  return {
    schema: PRIVATE_STATE_SCHEMA,
    schemaVersion: PRIVATE_STATE_VERSION,
    datasetId: PRIVATE_DATASET_ID,
    catalogueFingerprint: state.catalogueFingerprint,
    ...(metadata === undefined ? {} : metadata),
    items: [...state.items].sort(compareItemIds).map(serializeRecord),
  };
}

function canonicalJson(value: JsonRecord): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function serializePrivateState(input: unknown): StateResult<string> {
  const state = validatePrivateState(input);
  return state.ok ? ok(canonicalJson(canonicalObject(state.value))) : state;
}

export function serializePortableState(
  input: unknown,
  metadata: { readonly exportedAt: unknown; readonly appRevision: unknown },
): StateResult<string> {
  const state = validatePrivateState(input);
  if (!state.ok) {
    return state;
  }
  if (!isValidUtcInstant(metadata.exportedAt) || !isValidAppRevision(metadata.appRevision)) {
    return fail("IMPORT_INVALID_STATE_DATA");
  }
  return ok(
    canonicalJson(
      canonicalObject(state.value, {
        exportedAt: metadata.exportedAt,
        appRevision: metadata.appRevision,
      }),
    ),
  );
}

function currentRecord(itemId: string, current?: PrivateItemState): StateResult<PrivateItemState> {
  if (!isValidItemId(itemId)) {
    return fail("IMPORT_INVALID_STATE_DATA");
  }
  if (current === undefined) {
    return ok({ itemId, status: "need", quantityOwned: 0, quantityOrdered: 0 });
  }
  const result = normalizeRecordForImport(current);
  if (!result.ok) {
    return result;
  }
  return result.value === undefined
    ? ok({ itemId, status: "need", quantityOwned: 0, quantityOrdered: 0 })
    : ok(result.value);
}

function pruneDefault(record: PrivateItemState): PrivateItemState | undefined {
  return record.status === "need" &&
    record.quantityOwned === 0 &&
    record.quantityOrdered === 0 &&
    record.note === undefined
    ? undefined
    : record;
}

export function applyStatusCommand(
  itemId: string,
  current: PrivateItemState | undefined,
  command: StatusCommand,
): StateResult<PrivateItemState | undefined> {
  if (!isValidStatus(command)) {
    return fail("IMPORT_INVALID_STATE_DATA");
  }
  const base = currentRecord(itemId, current);
  if (!base.ok) {
    return base;
  }
  let next: PrivateItemState;
  if (command === "have") {
    next = { ...base.value, status: "have", quantityOwned: Math.max(1, base.value.quantityOwned) };
  } else if (command === "ordered") {
    next = { ...base.value, status: "ordered", quantityOwned: 0, quantityOrdered: Math.max(1, base.value.quantityOrdered) };
  } else {
    next = { ...base.value, status: command, quantityOwned: 0, quantityOrdered: 0 };
  }
  return ok(pruneDefault(next));
}

export function applyQuantityEdit(
  itemId: string,
  current: PrivateItemState | undefined,
  quantityOwned: unknown,
  quantityOrdered: unknown,
): StateResult<PrivateItemState | undefined> {
  if (!isValidQuantity(quantityOwned) || !isValidQuantity(quantityOrdered)) {
    return fail("EDIT_INVALID_QUANTITY");
  }
  const base = currentRecord(itemId, current);
  if (!base.ok) {
    return base;
  }
  const status: CollectionStatus = quantityOwned > 0 ? "have" : quantityOrdered > 0 ? "ordered" : "need";
  return ok(
    pruneDefault({
      ...base.value,
      status,
      quantityOwned,
      quantityOrdered,
    }),
  );
}

export function applyNoteEdit(
  itemId: string,
  current: PrivateItemState | undefined,
  note: unknown,
): StateResult<PrivateItemState | undefined> {
  const noteResult = normalizeNote(note);
  if (!noteResult.ok) {
    return noteResult;
  }
  const base = currentRecord(itemId, current);
  if (!base.ok) {
    return base;
  }
  const next: PrivateItemState = {
    ...base.value,
    ...(noteResult.value === undefined ? {} : { note: noteResult.value }),
  };
  if (noteResult.value === undefined) {
    delete (next as { note?: string }).note;
  }
  return ok(pruneDefault(next));
}
