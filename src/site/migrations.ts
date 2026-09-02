/**
 * Replaced by the build from the pinned producer migration artifact.
 * Keeping a typed source module lets the site compile independently.
 */
export const migrationManifest = Object.freeze({
  catalogueTransitions: [],
});

export const knownSourceItemIdsByFingerprint = new Map<string, ReadonlySet<string>>();

export const runtimeIdentity = Object.freeze({
  appRevision: 'synthetic-fixture',
  catalogueFingerprint: `sha256:${'0'.repeat(64)}`,
  migrationByteSha256: `sha256:${'0'.repeat(64)}`,
  migrationByteLength: 1,
});
