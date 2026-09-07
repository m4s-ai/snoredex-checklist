import { serializePrivateState, validatePrivateState, type PrivateState, type StateResult } from './domain.ts';

/**
 * The persisted value is kept backwards compatible with the state-only value
 * written by the persistence node. Once a destructive operation needs a
 * recovery copy, the same local authority key becomes this envelope.
 */
export const PRIVATE_STATE_AUTHORITY_SCHEMA = 'snoredex-private-state-authority' as const;
export const PRIVATE_STATE_AUTHORITY_VERSION = 1 as const;

export interface StateAuthorityEnvelope {
  readonly schema: typeof PRIVATE_STATE_AUTHORITY_SCHEMA;
  readonly schemaVersion: typeof PRIVATE_STATE_AUTHORITY_VERSION;
  readonly active: PrivateState | null;
  readonly recovery: PrivateState | null;
}

export type AuthorityComponentError = 'LOCAL_STATE_UNSUPPORTED' | 'LOCAL_STATE_UNREADABLE';

/**
 * Read the two authority components independently. A component error never
 * turns a readable sibling into an empty collection; callers decide whether
 * an operation can safely proceed with the partial result.
 */
export interface StateAuthorityParts {
  readonly active: PrivateState | undefined;
  readonly recovery: PrivateState | undefined;
  readonly activeError?: AuthorityComponentError;
  readonly recoveryError?: AuthorityComponentError;
  readonly enveloped: boolean;
}

export type AuthorityReadResult =
  | {
      readonly ok: true;
      readonly active: PrivateState | undefined;
      readonly recovery: PrivateState | undefined;
      readonly enveloped: boolean;
    }
  | { readonly ok: false; readonly error: 'LOCAL_STATE_UNSUPPORTED' | 'LOCAL_STATE_UNREADABLE' };

type AuthorityError = Extract<AuthorityReadResult, { ok: false }>;

function readRecoverySidecar(raw: string | null): PrivateState | undefined | AuthorityError {
  if (raw === null || raw.trim() === '' || raw.trim() === 'null') {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: 'LOCAL_STATE_UNREADABLE' };
  }
  const recovery = validatePrivateState(value);
  return recovery.ok ? recovery.value : { ok: false, error: 'LOCAL_STATE_UNREADABLE' };
}

function readActiveValue(raw: string): PrivateState | AuthorityError {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: 'LOCAL_STATE_UNREADABLE' };
  }
  const active = validatePrivateState(value);
  if (active.ok) return active.value;
  return active.error === 'IMPORT_UNSUPPORTED_STATE_SCHEMA' || active.error === 'IMPORT_UNSUPPORTED_STATE_VERSION'
    ? { ok: false, error: 'LOCAL_STATE_UNSUPPORTED' }
    : { ok: false, error: 'LOCAL_STATE_UNREADABLE' };
}

function isAuthorityError(value: PrivateState | undefined | AuthorityError): value is AuthorityError {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  return Object.keys(value).every((key) => allowed.has(key));
}

function componentValue(value: unknown): {
  readonly value: PrivateState | undefined;
  readonly error?: AuthorityComponentError;
} {
  if (value === null) return { value: undefined };
  const validated = validatePrivateState(value);
  if (validated.ok) return { value: validated.value };
  return {
    value: undefined,
    error:
      validated.error === 'IMPORT_UNSUPPORTED_STATE_SCHEMA' || validated.error === 'IMPORT_UNSUPPORTED_STATE_VERSION'
        ? 'LOCAL_STATE_UNSUPPORTED'
        : 'LOCAL_STATE_UNREADABLE',
  };
}

/** Read active and recovery independently while preserving strict legacy semantics for normal callers. */
export function readStateAuthorityParts(raw: string | null, recoveryRaw: string | null = null): StateAuthorityParts {
  if (raw === null) {
    const recovery = readRecoverySidecar(recoveryRaw);
    return isAuthorityError(recovery)
      ? { active: undefined, recovery: undefined, recoveryError: recovery.error, enveloped: false }
      : { active: undefined, recovery, enveloped: false };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    const recovery = readRecoverySidecar(recoveryRaw);
    return isAuthorityError(recovery)
      ? {
          active: undefined,
          recovery: undefined,
          activeError: 'LOCAL_STATE_UNREADABLE',
          recoveryError: recovery.error,
          enveloped: false,
        }
      : { active: undefined, recovery, activeError: 'LOCAL_STATE_UNREADABLE', enveloped: false };
  }

  if (isRecord(value) && value.schema === PRIVATE_STATE_AUTHORITY_SCHEMA) {
    if (!hasOnlyKeys(value, ['schema', 'schemaVersion', 'active', 'recovery'])) {
      return { active: undefined, recovery: undefined, activeError: 'LOCAL_STATE_UNREADABLE', enveloped: true };
    }
    if (value.schemaVersion !== PRIVATE_STATE_AUTHORITY_VERSION) {
      return { active: undefined, recovery: undefined, activeError: 'LOCAL_STATE_UNSUPPORTED', enveloped: true };
    }
    const active = componentValue(value.active);
    const recovery = componentValue(value.recovery);
    return {
      active: active.value,
      recovery: recovery.value,
      ...(active.error === undefined ? {} : { activeError: active.error }),
      ...(recovery.error === undefined ? {} : { recoveryError: recovery.error }),
      enveloped: true,
    };
  }

  const active = readActiveValue(raw);
  const recovery = readRecoverySidecar(recoveryRaw);
  return {
    active: isAuthorityError(active) ? undefined : active,
    recovery: isAuthorityError(recovery) ? undefined : recovery,
    ...(isAuthorityError(active) ? { activeError: active.error } : {}),
    ...(isAuthorityError(recovery) ? { recoveryError: recovery.error } : {}),
    enveloped: false,
  };
}

/** Read either the legacy state-only value or the recovery-capable envelope. */
export function readStateAuthority(raw: string | null, recoveryRaw: string | null = null): AuthorityReadResult {
  const parts = readStateAuthorityParts(raw, recoveryRaw);
  if (parts.activeError !== undefined) return { ok: false, error: parts.activeError };
  if (parts.recoveryError !== undefined) return { ok: false, error: parts.recoveryError };
  return {
    ok: true,
    active: parts.active,
    recovery: parts.recovery,
    enveloped: parts.enveloped,
  };
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
  const activeJson = activeResult === undefined ? 'null' : activeResult.value.trim();
  const recoveryJson = recoveryResult === undefined ? 'null' : recoveryResult.value.trim();
  return {
    ok: true,
    value: `{"schema":"${value.schema}","schemaVersion":${value.schemaVersion},"active":${activeJson},"recovery":${recoveryJson}}\n`,
  };
}
