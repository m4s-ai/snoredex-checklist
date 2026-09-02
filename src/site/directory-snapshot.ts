import type { DirectorySnapshot } from './directory.js';
import type { SiteProvenance } from './snapshot.js';

// Replaced with the selected validated directory projection by scripts/build-site.mjs.
export const provenance: SiteProvenance = Object.freeze({
  mode: 'synthetic-fixture',
  sourceCommit: 'synthetic-fixture',
  appRevision: 'synthetic-fixture',
  contractVersion: '1.0.0',
  sourceRepository: 'https://github.com/m4s-ai/snoredex-data',
  catalogueFingerprint: `sha256:${'0'.repeat(64)}`,
  lock: null,
});
const directory: DirectorySnapshot = {
  meta: {
    schema: 'snoredex-collector-catalogue',
    schemaVersion: '1.0.0',
    catalogueFingerprint: `sha256:${'0'.repeat(64)}`,
  },
  localizations: [],
};
export default directory;
