import type { CatalogueSnapshot } from "./catalogue.js";

// Replaced with the accepted synthetic fixture by scripts/build-site.mjs.
export const provenance = Object.freeze({
  mode: "synthetic-fixture",
  sourceCommit: "synthetic-fixture",
  contractVersion: "1.0.0",
});
const snapshot: CatalogueSnapshot = {
  meta: { schema: "snoredex-collector-catalogue", schemaVersion: "1.0.0", catalogueFingerprint: `sha256:${"0".repeat(64)}` },
  localizations: [], localSets: [], setEditions: [], works: [], items: [], assets: [],
};
export default snapshot;
