import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd(), process.argv[2] ?? 'dist/site');
const pageUrl = process.env.SNOREDEX_PAGE_URL;
if (pageUrl !== 'https://m4s-ai.github.io/snoredex-checklist/') throw new Error('DEPLOYMENT_PAGE_URL_INVALID');

let provenance;
try {
  provenance = JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8'));
} catch {
  throw new Error('DEPLOYMENT_PROVENANCE_INVALID');
}

const catalogue = provenance?.catalogue;
const lock = catalogue?.lock;
if (
  provenance?.schema !== 'snoredex-site-provenance' ||
  provenance?.schemaVersion !== '1.0.0' ||
  !/^[0-9a-f]{40}$/u.test(provenance.appRevision ?? '') ||
  catalogue?.mode !== 'pinned-snapshot' ||
  !/^[0-9a-f]{40}$/u.test(catalogue.sourceCommit ?? '') ||
  catalogue.sourceCommit !== lock?.producerRevision ||
  catalogue.sourceRepository !== 'https://github.com/m4s-ai/snoredex-data' ||
  catalogue.contractVersion !== '1.0.0' ||
  !/^sha256:[0-9a-f]{64}$/u.test(catalogue.catalogueFingerprint ?? '') ||
  catalogue.catalogueFingerprint !== lock?.catalogueFingerprint ||
  catalogue.catalogueByteSha256 !== lock?.catalogueByteSha256 ||
  catalogue.catalogueByteLength !== lock?.catalogueByteLength
) {
  throw new Error('DEPLOYMENT_PROVENANCE_INVALID');
}

const manifest = {
  schema: 'snoredex-checklist-deployment',
  schemaVersion: '1.0.0',
  pageUrl,
  publishedAt: new Date().toISOString(),
  appRevision: provenance.appRevision,
  producerRevision: lock.producerRevision,
  contractVersion: lock.contractVersion,
  catalogueFingerprint: lock.catalogueFingerprint,
  catalogueByteSha256: lock.catalogueByteSha256,
  catalogueByteLength: lock.catalogueByteLength,
};
await writeFile(join(root, 'deployment.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log('deployment manifest created');
