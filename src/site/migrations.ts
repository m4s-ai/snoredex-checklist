import type { ReconciliationManifest } from './state/reconciliation.js';

/**
 * Replaced by the build from the pinned producer migration artifact.
 * The placeholder uses the State owner's boundary type; the build still validates
 * the pinned producer manifest before replacing these empty fixture values.
 */
export const migrationManifest: ReconciliationManifest = Object.freeze({
  catalogueTransitions: [],
});

export const knownSourceItemIdsByFingerprint = new Map<string, ReadonlySet<string>>();

export const runtimeIdentity = Object.freeze({
  appRevision: 'synthetic-fixture',
  catalogueFingerprint: `sha256:${'0'.repeat(64)}`,
  migrationByteSha256: `sha256:${'0'.repeat(64)}`,
  migrationByteLength: 1,
});
