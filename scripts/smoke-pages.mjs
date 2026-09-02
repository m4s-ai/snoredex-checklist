import { validatePagesDeployment } from '../src/site/deployment.ts';
import { readRuntimeAssetSet, validateRuntimeAssetSetPointer } from './runtime-assets.mjs';

const pageUrl = process.env.SNOREDEX_PAGE_URL;
if (pageUrl !== 'https://m4s-ai.github.io/snoredex-checklist/') throw new Error('PAGES_SMOKE_URL_INVALID');
const expected = {
  appRevision: process.env.SNOREDEX_EXPECTED_GITHUB_SHA,
  producerRevision: process.env.SNOREDEX_EXPECTED_PRODUCER_REVISION,
  contractVersion: process.env.SNOREDEX_EXPECTED_CONTRACT_VERSION,
  catalogueFingerprint: process.env.SNOREDEX_EXPECTED_CATALOGUE_FINGERPRINT,
  catalogueByteSha256: process.env.SNOREDEX_EXPECTED_CATALOGUE_BYTE_SHA256,
  catalogueByteLength: Number(process.env.SNOREDEX_EXPECTED_CATALOGUE_BYTE_LENGTH),
  migrationByteSha256: process.env.SNOREDEX_EXPECTED_MIGRATION_BYTE_SHA256,
  migrationByteLength: Number(process.env.SNOREDEX_EXPECTED_MIGRATION_BYTE_LENGTH),
};

async function get(path) {
  const response = await fetch(new URL(path, pageUrl), { redirect: 'error' });
  if (!response.ok) throw new Error('PAGES_SMOKE_HTTP_FAILED');
  return response;
}

async function getRuntimeBytes(path) {
  const response = await get(`./assets/${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

const home = await get('./');
const collection = await get('./collection/');
const guide = await get('./llms.txt');
const stylesheet = await get('./styles.css');
const theme = await get('./theme.js');
const collectionTheme = await get('./collection/theme.js');
const moduleManifestResponse = await get('./assets/module-manifest.json');
let moduleManifest;
try {
  moduleManifest = await moduleManifestResponse.json();
} catch {
  throw new Error('PAGES_SMOKE_MODULE_MANIFEST_INVALID');
}
if (
  moduleManifest?.schema !== 'snoredex-site-module-manifest' ||
  moduleManifest?.schemaVersion !== '2.0.0' ||
  moduleManifest?.appRevision !== expected.appRevision ||
  !validateRuntimeAssetSetPointer(moduleManifest.runtimeAssetSet, expected.appRevision) ||
  !Array.isArray(moduleManifest.retainedRuntimeAssetSets) ||
  moduleManifest.retainedRuntimeAssetSets.length > 1
) {
  throw new Error('PAGES_SMOKE_MODULE_MANIFEST_INVALID');
}
const pointer = moduleManifest.runtimeAssetSet;
const runtime = {
  appRevision: expected.appRevision,
  producerRevision: expected.producerRevision,
  contractVersion: expected.contractVersion,
  catalogueFingerprint: expected.catalogueFingerprint,
  catalogueByteSha256: expected.catalogueByteSha256,
  catalogueByteLength: expected.catalogueByteLength,
  migrationByteSha256: expected.migrationByteSha256,
  migrationByteLength: expected.migrationByteLength,
};
const { moduleTexts: activeModuleTexts } = await readRuntimeAssetSet(pointer, runtime, getRuntimeBytes);
const [homeText, collectionText, guideText, stylesheetText, ...moduleTexts] = await Promise.all([
  home.text(),
  collection.text(),
  guide.text(),
  stylesheet.text(),
  ...activeModuleTexts,
]);
const [themeText, collectionThemeText] = await Promise.all([theme.text(), collectionTheme.text()]);
if (
  !homeText.includes('Snoredex Checklist') ||
  !collectionText.includes('<body data-page="collection">') ||
  !homeText.includes(`<script type="module" src="assets/${pointer.path}/app.js"></script>`) ||
  !collectionText.includes(`<script type="module" src="../assets/${pointer.path}/app.js"></script>`) ||
  !homeText.includes(`name="snoredex-app-revision" content="${expected.appRevision}"`) ||
  !collectionText.includes(`name="snoredex-app-revision" content="${expected.appRevision}"`) ||
  !guideText.includes(`snoredex-app-revision:${expected.appRevision}`) ||
  !stylesheetText.includes(`snoredex-app-revision:${expected.appRevision}`) ||
  !themeText.includes(`snoredex-app-revision:${expected.appRevision}`) ||
  !collectionThemeText.includes(`snoredex-app-revision:${expected.appRevision}`) ||
  moduleTexts.some((text) => !text.includes(`snoredex-app-revision:${expected.appRevision}`))
) {
  throw new Error('PAGES_SMOKE_SHELL_INVALID');
}

const deploymentResponse = await get('./deployment.json');
const provenanceResponse = await get('./provenance.json');
let deployment;
let provenance;
try {
  [deployment, provenance] = await Promise.all([deploymentResponse.json(), provenanceResponse.json()]);
} catch {
  throw new Error('PAGES_SMOKE_PROVENANCE_INVALID');
}
if (!validatePagesDeployment(deployment, provenance, pageUrl, expected)) {
  throw new Error('PAGES_SMOKE_PROVENANCE_INVALID');
}
if (JSON.stringify(deployment.runtimeAssetSet) !== JSON.stringify(pointer)) {
  throw new Error('PAGES_SMOKE_RUNTIME_POINTER_INVALID');
}
const retained = moduleManifest.retainedRuntimeAssetSets;
if (
  (deployment.rollback === undefined && retained.length !== 0) ||
  (deployment.rollback !== undefined &&
    (retained.length !== 1 || JSON.stringify(deployment.rollback.runtimeAssetSet) !== JSON.stringify(retained[0])))
) {
  throw new Error('PAGES_SMOKE_ROLLBACK_RUNTIME_INVALID');
}
if (deployment.rollback !== undefined) {
  await readRuntimeAssetSet(retained[0], deployment.rollback, getRuntimeBytes);
}
console.log('Pages smoke ok');
