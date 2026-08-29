import { validatePagesDeployment } from '../src/site/deployment.ts';

const pageUrl = process.env.SNOREDEX_PAGE_URL;
if (pageUrl !== 'https://m4s-ai.github.io/snoredex-checklist/') throw new Error('PAGES_SMOKE_URL_INVALID');
const expected = {
  appRevision: process.env.SNOREDEX_EXPECTED_GITHUB_SHA,
  producerRevision: process.env.SNOREDEX_EXPECTED_PRODUCER_REVISION,
  contractVersion: process.env.SNOREDEX_EXPECTED_CONTRACT_VERSION,
  catalogueFingerprint: process.env.SNOREDEX_EXPECTED_CATALOGUE_FINGERPRINT,
  catalogueByteSha256: process.env.SNOREDEX_EXPECTED_CATALOGUE_BYTE_SHA256,
  catalogueByteLength: Number(process.env.SNOREDEX_EXPECTED_CATALOGUE_BYTE_LENGTH),
};

async function get(path) {
  const response = await fetch(new URL(path, pageUrl), { redirect: 'error' });
  if (!response.ok) throw new Error('PAGES_SMOKE_HTTP_FAILED');
  return response;
}

const home = await get('./');
const collection = await get('./collection/');
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
  moduleManifest?.schemaVersion !== '1.0.0' ||
  moduleManifest?.appRevision !== expected.appRevision ||
  !Array.isArray(moduleManifest.modules) ||
  moduleManifest.modules.length === 0 ||
  moduleManifest.modules.length > 256 ||
  !moduleManifest.modules.includes('app.js') ||
  new Set(moduleManifest.modules).size !== moduleManifest.modules.length ||
  moduleManifest.modules.some(
    (path) =>
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > 256 ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
      !path.endsWith('.js'),
  )
) {
  throw new Error('PAGES_SMOKE_MODULE_MANIFEST_INVALID');
}
const moduleResponses = await Promise.all(moduleManifest.modules.map((path) => get(`./assets/${path}`)));
const appScript = await get('./assets/app.js');
const [homeText, collectionText, appScriptText, ...moduleTexts] = await Promise.all([
  home.text(),
  collection.text(),
  appScript.text(),
  ...moduleResponses.map((response) => response.text()),
]);
const [themeText, collectionThemeText] = await Promise.all([theme.text(), collectionTheme.text()]);
if (
  !homeText.includes('Snoredex Checklist') ||
  !collectionText.includes('Public catalogue text is rendered from the validated snapshot') ||
  !homeText.includes(`name="snoredex-app-revision" content="${expected.appRevision}"`) ||
  !collectionText.includes(`name="snoredex-app-revision" content="${expected.appRevision}"`) ||
  !themeText.includes(`snoredex-app-revision:${expected.appRevision}`) ||
  !collectionThemeText.includes(`snoredex-app-revision:${expected.appRevision}`) ||
  !appScriptText.includes(`snoredex-app-revision:${expected.appRevision}`) ||
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
console.log('Pages smoke ok');
