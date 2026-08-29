import type { CatalogueSnapshot } from './catalogue.js';

export type SiteProvenance =
  | {
      readonly mode: 'synthetic-fixture';
      readonly sourceCommit: 'synthetic-fixture';
      readonly contractVersion: string;
      readonly sourceRepository: string;
      readonly catalogueFingerprint: string;
      readonly lock: null;
    }
  | {
      readonly mode: 'pinned-snapshot';
      readonly sourceCommit: string;
      readonly contractVersion: string;
      readonly sourceRepository: string;
      readonly catalogueFingerprint: string;
      readonly catalogueByteSha256: string;
      readonly catalogueByteLength: number;
      readonly lock: Record<string, unknown>;
    };

// Replaced with the selected validated snapshot by scripts/build-site.mjs.
export const provenance: SiteProvenance = Object.freeze({
  mode: 'synthetic-fixture',
  sourceCommit: 'synthetic-fixture',
  contractVersion: '1.0.0',
  sourceRepository: 'https://github.com/m4s-ai/snoredex-data',
  catalogueFingerprint: `sha256:${'0'.repeat(64)}`,
  lock: null,
});
const snapshot: CatalogueSnapshot = {
  meta: {
    schema: 'snoredex-collector-catalogue',
    schemaVersion: '1.0.0',
    catalogueFingerprint: `sha256:${'0'.repeat(64)}`,
  },
  localizations: [],
  localSets: [],
  setEditions: [],
  works: [],
  items: [],
  assets: [],
};
export default snapshot;
