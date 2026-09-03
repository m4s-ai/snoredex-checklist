import { validatePagesDeployment } from '../src/site/deployment.ts';
import { readRuntimeAssetSet, runtimeShellBindings, validateRuntimeAssetSetPointer } from './runtime-assets.mjs';

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
const { manifest: activeRuntimeManifest, moduleTexts: activeModuleTexts } = await readRuntimeAssetSet(
  pointer,
  runtime,
  getRuntimeBytes,
);
const homeBindings = runtimeShellBindings(activeRuntimeManifest, `assets/${pointer.path}/`);
const collectionBindings = runtimeShellBindings(activeRuntimeManifest, `../assets/${pointer.path}/`);
const [homeText, collectionText, guideText, stylesheetText, ...moduleTexts] = await Promise.all([
  home.text(),
  collection.text(),
  guide.text(),
  stylesheet.text(),
  ...activeModuleTexts,
]);
if (
  !homeText.includes('Snoredex Checklist') ||
  !collectionText.includes('<body data-page="collection">') ||
  !homeText.includes(`<script type="importmap">${homeBindings.importMap}</script>`) ||
  !collectionText.includes(`<script type="importmap">${collectionBindings.importMap}</script>`) ||
  !homeText.includes(`src="assets/${pointer.path}/app.js"`) ||
  !homeText.includes(`integrity="${homeBindings.appIntegrity}"`) ||
  !collectionText.includes(`src="../assets/${pointer.path}/app.js"`) ||
  !collectionText.includes(`integrity="${collectionBindings.appIntegrity}"`) ||
  !homeText.includes(`src="assets/${pointer.path}/theme.js"`) ||
  !homeText.includes(`integrity="${homeBindings.themeIntegrity}"`) ||
  !collectionText.includes(`src="../assets/${pointer.path}/theme.js"`) ||
  !collectionText.includes(`integrity="${collectionBindings.themeIntegrity}"`) ||
  !homeText.includes(`script-src 'self' '${homeBindings.importMapCsp}'`) ||
  !collectionText.includes(`script-src 'self' '${collectionBindings.importMapCsp}'`) ||
  !homeText.includes(`name="snoredex-app-revision" content="${expected.appRevision}"`) ||
  !collectionText.includes(`name="snoredex-app-revision" content="${expected.appRevision}"`) ||
  !guideText.includes(`snoredex-app-revision:${expected.appRevision}`) ||
  !stylesheetText.includes(`snoredex-app-revision:${expected.appRevision}`) ||
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
let retainedRuntimeManifest;
if (
  (deployment.rollback === undefined && retained.length !== 0) ||
  (deployment.rollback !== undefined &&
    (retained.length !== 1 || JSON.stringify(deployment.rollback.runtimeAssetSet) !== JSON.stringify(retained[0])))
) {
  throw new Error('PAGES_SMOKE_ROLLBACK_RUNTIME_INVALID');
}
if (deployment.rollback !== undefined) {
  ({ manifest: retainedRuntimeManifest } = await readRuntimeAssetSet(
    retained[0],
    deployment.rollback,
    getRuntimeBytes,
  ));
}
const [themeText, collectionThemeText] = await Promise.all([theme.text(), collectionTheme.text()]);
const rootThemeRevision =
  retainedRuntimeManifest && !retainedRuntimeManifest.modules.some((module) => module.path === 'theme.js')
    ? deployment.rollback.appRevision
    : expected.appRevision;
if (themeText !== collectionThemeText || !themeText.includes(`snoredex-app-revision:${rootThemeRevision}`)) {
  throw new Error('PAGES_SMOKE_THEME_INVALID');
}
console.log('Pages smoke ok');
