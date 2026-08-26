import {
  serializePrivateState,
  validatePrivateState,
  type PrivateState,
  type StateResult,
} from "./domain.ts";

/**
 * The persisted value is kept backwards compatible with the state-only value
 * written by the persistence node. Once a destructive operation needs a
 * recovery copy, the same local authority key becomes this envelope.
 */
export const PRIVATE_STATE_AUTHORITY_SCHEMA = "snoredex-private-state-authority" as const;
export const PRIVATE_STATE_AUTHORITY_VERSION = 1 as const;

export interface StateAuthorityEnvelope {
  readonly schema: typeof PRIVATE_STATE_AUTHORITY_SCHEMA;
  readonly schemaVersion: typeof PRIVATE_STATE_AUTHORITY_VERSION;
  readonly active: PrivateState | null;
  readonly recovery: PrivateState | null;
}

export type AuthorityReadResult =
  | { readonly ok: true; readonly active: PrivateState | undefined; readonly recovery: PrivateState | undefined; readonly enveloped: boolean }
  | { readonly ok: false; readonly error: "LOCAL_STATE_UNSUPPORTED" | "LOCAL_STATE_UNREADABLE" };

type AuthorityError = Extract<AuthorityReadResult, { ok: false }>;

function readRecoverySidecar(raw: string | null): PrivateState | undefined | AuthorityError {
  if (raw === null || raw.trim() === "" || raw.trim() === "null") {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "LOCAL_STATE_UNREADABLE" };
  }
  const recovery = validatePrivateState(value);
  return recovery.ok ? recovery.value : { ok: false, error: "LOCAL_STATE_UNREADABLE" };
}

function isAuthorityError(value: PrivateState | undefined | AuthorityError): value is AuthorityError {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validateAuthorityEnvelope(value: unknown): StateAuthorityEnvelope | AuthorityReadResult {
  if (!isRecord(value)
    || value.schema !== PRIVATE_STATE_AUTHORITY_SCHEMA
    || !hasOnlyKeys(value, ["schema", "schemaVersion", "active", "recovery"])) {
    return { ok: false, error: "LOCAL_STATE_UNREADABLE" };
  }
  if (value.schemaVersion !== PRIVATE_STATE_AUTHORITY_VERSION) {
    return { ok: false, error: "LOCAL_STATE_UNSUPPORTED" };
  }
  const active = value.active === null ? undefined : validatePrivateState(value.active);
  const recovery = value.recovery === null ? undefined : validatePrivateState(value.recovery);
  if (value.active !== null && (!active || !active.ok)) {
    return { ok: false, error: "LOCAL_STATE_UNREADABLE" };
  }
  if (value.recovery !== null && (!recovery || !recovery.ok)) {
    return { ok: false, error: "LOCAL_STATE_UNREADABLE" };
  }
  return {
    schema: PRIVATE_STATE_AUTHORITY_SCHEMA,
    schemaVersion: PRIVATE_STATE_AUTHORITY_VERSION,
    active: value.active === null ? null : (active as { ok: true; value: PrivateState }).value,
    recovery: value.recovery === null ? null : (recovery as { ok: true; value: PrivateState }).value,
  };
}

/** Read either the legacy state-only value or the recovery-capable envelope. */
export function readStateAuthority(raw: string | null, recoveryRaw: string | null = null): AuthorityReadResult {
  if (raw === null) {
    const recovery = readRecoverySidecar(recoveryRaw);
    return isAuthorityError(recovery)
      ? recovery
      : { ok: true, active: undefined, recovery, enveloped: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: "LOCAL_STATE_UNREADABLE" };
  }
  if (isRecord(value) && value.schema === PRIVATE_STATE_AUTHORITY_SCHEMA) {
    const envelope = validateAuthorityEnvelope(value);
    if (!("ok" in envelope)) {
      const sidecar = readRecoverySidecar(recoveryRaw);
      if (isAuthorityError(sidecar)) return sidecar;
      return {
        ok: true,
        active: envelope.active ?? undefined,
        // An explicit envelope null means the recovery was consumed. A stale
        // sidecar must never resurrect that already-consumed snapshot.
        recovery: envelope.recovery ?? undefined,
        enveloped: true,
      };
    }
    return envelope;
  }
  const active = validatePrivateState(value);
  if (!active.ok) {
    return active.error === "IMPORT_UNSUPPORTED_STATE_SCHEMA" || active.error === "IMPORT_UNSUPPORTED_STATE_VERSION"
      ? { ok: false, error: "LOCAL_STATE_UNSUPPORTED" }
      : { ok: false, error: "LOCAL_STATE_UNREADABLE" };
  }
  const recovery = readRecoverySidecar(recoveryRaw);
  if (isAuthorityError(recovery)) return recovery;
  return { ok: true, active: active.value, recovery, enveloped: false };
}

/** Build a canonical recovery-capable value for the sole local authority key. */
export function serializeStateAuthority(
  active: PrivateState | undefined,
  recovery: PrivateState | undefined,
): StateResult<string> {
  if (active !== undefined) {
    const validActive = validatePrivateState(active);
    if (!validActive.ok) return validActive;
  }
  if (recovery !== undefined) {
    const validRecovery = validatePrivateState(recovery);
    if (!validRecovery.ok) return validRecovery;
  }
  const value: StateAuthorityEnvelope = {
    schema: PRIVATE_STATE_AUTHORITY_SCHEMA,
    schemaVersion: PRIVATE_STATE_AUTHORITY_VERSION,
    active: active === undefined ? null : active,
    recovery: recovery === undefined ? null : recovery,
  };
  // Reuse the state serializer's validation and stable JSON formatting for
  // each nested payload, while keeping the outer field order explicit.
  const activeResult = active === undefined ? undefined : serializePrivateState(active);
  if (activeResult !== undefined && !activeResult.ok) return activeResult;
  const recoveryResult = recovery === undefined ? undefined : serializePrivateState(recovery);
  if (recoveryResult !== undefined && !recoveryResult.ok) return recoveryResult;
  const activeJson = activeResult === undefined ? "null" : activeResult.value.trim();
  const recoveryJson = recoveryResult === undefined ? "null" : recoveryResult.value.trim();
  return {
    ok: true,
    value: `{"schema":"${value.schema}","schemaVersion":${value.schemaVersion},"active":${activeJson},"recovery":${recoveryJson}}\n`,
  };
}
