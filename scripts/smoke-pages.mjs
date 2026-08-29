const pageUrl = process.env.SNOREDEX_PAGE_URL;
if (pageUrl !== 'https://m4s-ai.github.io/snoredex-checklist/') throw new Error('PAGES_SMOKE_URL_INVALID');

async function get(path) {
  const response = await fetch(new URL(path, pageUrl), { redirect: 'error' });
  if (!response.ok) throw new Error('PAGES_SMOKE_HTTP_FAILED');
  return response;
}

const home = await get('./');
const collection = await get('./collection/');
const [homeText, collectionText] = await Promise.all([home.text(), collection.text()]);
if (
  !homeText.includes('Snoredex Checklist') ||
  !collectionText.includes('Public catalogue text is rendered from the validated snapshot')
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
const catalogue = provenance?.catalogue;
if (
  deployment?.schema !== 'snoredex-checklist-deployment' ||
  deployment?.schemaVersion !== '1.0.0' ||
  deployment.pageUrl !== pageUrl ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(deployment.publishedAt ?? '') ||
  deployment.appRevision !== provenance?.appRevision ||
  deployment.producerRevision !== catalogue?.sourceCommit ||
  deployment.contractVersion !== catalogue?.contractVersion ||
  deployment.catalogueFingerprint !== catalogue?.catalogueFingerprint ||
  deployment.catalogueByteSha256 !== catalogue?.catalogueByteSha256 ||
  deployment.catalogueByteLength !== catalogue?.catalogueByteLength
) {
  throw new Error('PAGES_SMOKE_PROVENANCE_INVALID');
}
console.log('Pages smoke ok');
