import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import process from 'node:process';

const root = resolve(process.cwd(), process.argv[2] ?? 'dist/site');
const required = [
  'index.html',
  'collection/index.html',
  'theme.js',
  'collection/theme.js',
  'styles.css',
  'llms.txt',
  'LICENSE.md',
  'THIRD_PARTY_NOTICES.md',
  'provenance.json',
];

function containsPrivateStateSchema(value) {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && value.schema === 'snoredex-collection-state') return true;
  return Object.values(value).some((entry) => containsPrivateStateSchema(entry));
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&#x([\da-f]+);/giu, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd';
    })
    .replace(/&#(\d+);/gu, (_, decimal) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd';
    })
    .replace(/&(amp|apos|colon|gt|lt|quot);/giu, (_, entity) => {
      const entities = { amp: '&', apos: "'", colon: ':', gt: '>', lt: '<', quot: '"' };
      return entities[entity.toLowerCase()];
    });
}

function readAttribute(tag, name) {
  const pattern = new RegExp(`(?:^|[\\t\\n\\f\\r /])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'iu');
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function hasActiveCspMeta(head, expectedCsp) {
  const voidElements = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
  ]);
  const stack = [];
  const allowedHeadElements = new Set(['base', 'link', 'meta', 'noscript', 'script', 'style', 'template', 'title']);
  let cspSeen = false;
  let controlledResourceBeforeCsp = false;
  let headTerminated = false;
  for (const match of head.matchAll(/<(?:(\/)\s*)?([a-z][\w:-]*)(?:\s[^>]*)?>/giu)) {
    const tag = match[0];
    const closing = match[1] !== undefined;
    const name = match[2].toLowerCase();
    if (closing) {
      if (stack.at(-1) === name) stack.pop();
      continue;
    }
    if (!allowedHeadElements.has(name)) headTerminated = true;
    if (['base', 'link', 'script', 'style'].includes(name) && !cspSeen) controlledResourceBeforeCsp = true;
    if (
      name === 'meta' &&
      stack.length === 0 &&
      readAttribute(tag, 'http-equiv')?.toLowerCase() === 'content-security-policy' &&
      decodeHtmlAttribute(readAttribute(tag, 'content') ?? '') === expectedCsp
    ) {
      cspSeen = true;
    }
    if (!voidElements.has(name)) stack.push(name);
  }
  return cspSeen && !controlledResourceBeforeCsp && !headTerminated;
}

async function filesIn(directory) {
  const output = [];
  async function visit(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`ARTIFACT_SYMLINK_FORBIDDEN: ${relative(directory, path)}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
      else throw new Error(`ARTIFACT_UNSUPPORTED_ENTRY: ${relative(directory, path)}`);
    }
  }
  await visit(directory);
  return output;
}

try {
  const allFiles = await filesIn(root);
  const relativeFiles = allFiles.map((path) => relative(root, path).replaceAll('\\', '/'));
  for (const path of required)
    if (!relativeFiles.includes(path)) throw new Error(`ARTIFACT_REQUIRED_FILE_MISSING: ${path}`);
  const forbiddenPath = relativeFiles.find((path) => /\.snoredex-private\.json$/iu.test(path));
  if (forbiddenPath) throw new Error(`ARTIFACT_PRIVATE_FILE_PRESENT: ${forbiddenPath}`);

  const provenance = JSON.parse(await readFile(join(root, 'provenance.json'), 'utf8'));
  if (provenance.schema !== 'snoredex-site-provenance' || provenance.schemaVersion !== '1.0.0') {
    throw new Error('ARTIFACT_PROVENANCE_SCHEMA_INVALID');
  }
  if (!/^[0-9a-f]{40}$/u.test(provenance.appRevision)) throw new Error('ARTIFACT_APP_REVISION_INVALID');
  const catalogue = provenance.catalogue;
  if (
    !catalogue ||
    catalogue.mode !== 'synthetic-fixture' ||
    catalogue.sourceCommit !== 'synthetic-fixture' ||
    catalogue.lock !== null ||
    catalogue.contractVersion !== '1.0.0' ||
    !/^sha256:[0-9a-f]{64}$/u.test(catalogue.catalogueFingerprint) ||
    catalogue.sourceRepository !== 'https://github.com/m4s-ai/snoredex-data'
  ) {
    throw new Error('ARTIFACT_CATALOGUE_PROVENANCE_INVALID');
  }

  const forbiddenContent = /\.snoredex-private\.json|synthetic-secret|PRIVATE-NOTE-DO-NOT-LOG/iu;
  const csp =
    "default-src 'none'; base-uri 'none'; form-action 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; worker-src 'none'; frame-src 'none'; font-src 'none'; media-src 'none'; manifest-src 'none'";
  for (const page of ['index.html', 'collection/index.html']) {
    const html = await readFile(join(root, page), 'utf8');
    const withoutComments = html.replace(/<!--[\s\S]*?(?:-->|$)/gu, '');
    const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/iu.exec(withoutComments)?.[1] ?? '';
    const hasCspMeta = hasActiveCspMeta(head, csp);
    if (!hasCspMeta) throw new Error(`ARTIFACT_CSP_MISSING: ${page}`);
    if (/\b(?:unsafe-inline|unsafe-eval)\b/iu.test(html)) throw new Error(`ARTIFACT_CSP_UNSAFE_DIRECTIVE: ${page}`);
    if (/[\s/]on[a-z]+\s*=/iu.test(html)) throw new Error(`ARTIFACT_INLINE_HANDLER_PRESENT: ${page}`);
    for (const match of html.matchAll(/<script\b[^>]*>/giu)) {
      const encodedSource = readAttribute(match[0], 'src');
      if (encodedSource === undefined) throw new Error(`ARTIFACT_INLINE_SCRIPT_PRESENT: ${page}`);
      const source = decodeHtmlAttribute(encodedSource);
      if (
        !source ||
        source !== source.trim() ||
        /[\u0000-\u0020\u007f]/u.test(source) ||
        source.includes('&') ||
        source.startsWith('/') ||
        /^[a-z][a-z\d+.-]*:/iu.test(source) ||
        source.includes('\\')
      )
        throw new Error(`ARTIFACT_EXTERNAL_SCRIPT_PRESENT: ${page}`);
    }
  }
  for (const file of allFiles) {
    const bytes = await readFile(file);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (forbiddenContent.test(text)) throw new Error(`ARTIFACT_PRIVATE_CONTENT_PRESENT: ${relative(root, file)}`);
    if (file.toLowerCase().endsWith('.json')) {
      try {
        if (containsPrivateStateSchema(JSON.parse(text))) {
          throw new Error(`ARTIFACT_PRIVATE_STATE_SCHEMA_PRESENT: ${relative(root, file)}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('ARTIFACT_PRIVATE_STATE_SCHEMA_PRESENT:')) throw error;
      }
    }
  }
  console.log(
    `artifact ok: ${relativeFiles.length} files; app ${provenance.appRevision}; catalogue ${catalogue.catalogueFingerprint}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
