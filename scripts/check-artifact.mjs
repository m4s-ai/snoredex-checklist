import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, relative, posix } from 'node:path';
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
    .replace(/&#x([\da-f]+);?/giu, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd';
    })
    .replace(/&#(\d+);?/gu, (_, decimal) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd';
    })
    .replace(/&(amp|apos|colon|gt|lt|quot);/giu, (_, entity) => {
      const entities = { amp: '&', apos: "'", colon: ':', gt: '>', lt: '<', quot: '"' };
      return entities[entity.toLowerCase()];
    });
}

function readAttributeLegacy(tag, name) {
  const pattern = new RegExp(`(?:^|[\\t\\n\\f\\r /])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'iu');
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function readAttribute(tag, name) {
  const target = name.toLowerCase();
  let index = 1;
  while (index < tag.length && !/[\t\n\f\r />]/u.test(tag[index])) index += 1;
  while (index < tag.length) {
    while (index < tag.length && /[\t\n\f\r /]/u.test(tag[index])) index += 1;
    if (index >= tag.length || tag[index] === '>') break;
    const start = index;
    while (index < tag.length && !/[\t\n\f\r />=]/u.test(tag[index])) index += 1;
    const attributeName = tag.slice(start, index).toLowerCase();
    while (index < tag.length && /[\t\n\f\r ]/u.test(tag[index])) index += 1;
    let value;
    if (tag[index] === '=') {
      index += 1;
      while (index < tag.length && /[\t\n\f\r ]/u.test(tag[index])) index += 1;
      const quote = tag[index] === '"' || tag[index] === "'" ? tag[index++] : undefined;
      const valueStart = index;
      if (quote !== undefined) {
        while (index < tag.length && tag[index] !== quote) index += 1;
      } else {
        while (index < tag.length && !/[\t\n\f\r >]/u.test(tag[index])) index += 1;
      }
      value = tag.slice(valueStart, index);
      if (quote !== undefined && tag[index] === quote) index += 1;
    }
    if (attributeName === target) return value;
    if (index === start) index += 1;
  }
  return undefined;
}

function* htmlTags(html) {
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) return;
    let cursor = start + 1;
    let quote;
    while (cursor < html.length) {
      const character = html[cursor];
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        const raw = html.slice(start, cursor + 1);
        const match = /^<(?:(\/)[\s]*)?([a-z][\w:-]*)(?=[\t\n\f\r />])/iu.exec(raw);
        if (match) yield { closing: match[1] !== undefined, name: match[2].toLowerCase(), raw, index: start };
        index = cursor + 1;
        break;
      }
      cursor += 1;
    }
    if (cursor >= html.length) return;
  }
}

function stripHtmlComments(html) {
  let output = '';
  let index = 0;
  let commentDepth = 0;
  let commentStart = false;
  let commentStartDash = false;
  while (index < html.length) {
    if (commentDepth === 0) {
      if (html.startsWith('<!--', index)) {
        commentDepth = 1;
        commentStart = true;
        commentStartDash = false;
        index += 4;
      } else {
        output += html[index];
        index += 1;
      }
      continue;
    }
    if (html.startsWith('--!>', index)) {
      commentDepth -= 1;
      commentStart = false;
      commentStartDash = false;
      index += 4;
    } else if (html.startsWith('-->', index)) {
      commentDepth -= 1;
      commentStart = false;
      commentStartDash = false;
      index += 3;
    } else if ((commentStart || commentStartDash) && html[index] === '>') {
      commentDepth -= 1;
      commentStart = false;
      commentStartDash = false;
      index += 1;
    } else if (commentStart && html[index] === '-') {
      commentStart = false;
      commentStartDash = true;
      index += 1;
    } else {
      commentStart = false;
      commentStartDash = false;
      index += 1;
    }
  }
  return output;
}

function isArtifactScriptTarget(source, page, relativeFiles) {
  const pathPart = source.split(/[?#]/u, 1)[0];
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathPart);
  } catch {
    return false;
  }
  const normalizedPath = posix.normalize(posix.join(posix.dirname(page), decodedPath));
  return normalizedPath !== '..' && !normalizedPath.startsWith('../') && relativeFiles.includes(normalizedPath);
}

function hasMetaRefresh(html) {
  for (const tag of htmlTags(html)) {
    if (tag.closing || tag.name !== 'meta') continue;
    const httpEquiv = readAttribute(tag.raw, 'http-equiv');
    if (httpEquiv !== undefined && decodeHtmlAttribute(httpEquiv).trim().toLowerCase() === 'refresh') return true;
  }
  return false;
}

function extractHead(html) {
  const rawTextElements = new Set([
    'iframe',
    'noembed',
    'noframes',
    'noscript',
    'plaintext',
    'script',
    'style',
    'textarea',
    'title',
    'xmp',
  ]);
  const inertElements = new Set(['template']);
  const preHeadElements = new Set([
    'base',
    'head',
    'html',
    'link',
    'meta',
    'noscript',
    'script',
    'style',
    'template',
    'title',
  ]);
  let rawTextTag;
  let inertDepth = 0;
  let headStart = -1;
  let implicitHead = false;
  let explicitHeadTagStart = -1;
  let explicitHeadContentStart = -1;
  let bodyStarted = false;
  let previousEnd = 0;
  for (const tag of htmlTags(html)) {
    const { closing, name } = tag;
    if (
      rawTextTag === undefined &&
      inertDepth === 0 &&
      !bodyStarted &&
      /\S/u.test(html.slice(previousEnd, tag.index).replace(/<![^>]*>/gu, ''))
    ) {
      bodyStarted = true;
    }
    if (rawTextTag !== undefined) {
      if (rawTextTag !== 'plaintext' && closing && name === rawTextTag) rawTextTag = undefined;
      previousEnd = tag.index + tag.raw.length;
      continue;
    }
    if (inertDepth > 0) {
      if (!closing && rawTextElements.has(name)) rawTextTag = name;
      else if (name === 'template') inertDepth += closing ? -1 : 1;
      previousEnd = tag.index + tag.raw.length;
      continue;
    }
    if (!closing && name === 'body') {
      if (headStart >= 0) return bodyStarted ? '' : html.slice(headStart, tag.index);
      bodyStarted = true;
      previousEnd = tag.index + tag.raw.length;
      continue;
    }
    if (closing && headStart < 0 && !bodyStarted) {
      bodyStarted = true;
      previousEnd = tag.index + tag.raw.length;
      continue;
    }
    if (bodyStarted) {
      previousEnd = tag.index + tag.raw.length;
      continue;
    }
    if (!closing && headStart < 0 && !preHeadElements.has(name)) {
      bodyStarted = true;
      previousEnd = tag.index + tag.raw.length;
      continue;
    }
    if (closing) {
      if (headStart >= 0 && name === 'head') {
        if (bodyStarted) return '';
        if (implicitHead && explicitHeadTagStart >= 0) {
          return html.slice(headStart, explicitHeadTagStart) + html.slice(explicitHeadContentStart, tag.index);
        }
        return html.slice(headStart, tag.index);
      }
      if (!bodyStarted && headStart >= 0 && ['body', 'br', 'html'].includes(name)) {
        bodyStarted = true;
      }
      previousEnd = tag.index + tag.raw.length;
      continue;
    }
    if (headStart < 0 && name === 'head') {
      headStart = tag.index + tag.raw.length;
    } else if (headStart >= 0 && name === 'head' && implicitHead) {
      explicitHeadTagStart = tag.index;
      explicitHeadContentStart = tag.index + tag.raw.length;
    }
    if (headStart < 0 && preHeadElements.has(name) && !['head', 'html', 'template'].includes(name)) {
      headStart = tag.index;
      implicitHead = true;
    }
    if (rawTextElements.has(name)) {
      rawTextTag = name;
      previousEnd = tag.index + tag.raw.length;
      continue;
    }
    if (inertElements.has(name)) {
      inertDepth += 1;
      previousEnd = tag.index + tag.raw.length;
      continue;
    }
    previousEnd = tag.index + tag.raw.length;
  }
  return '';
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
  for (const tag of htmlTags(head)) {
    const { closing, name, raw } = tag;
    if (closing) {
      if (stack.at(-1) === name) stack.pop();
      continue;
    }
    if (!allowedHeadElements.has(name)) headTerminated = true;
    if (['base', 'link', 'script', 'style'].includes(name) && !cspSeen) controlledResourceBeforeCsp = true;
    if (
      name === 'meta' &&
      stack.length === 0 &&
      readAttribute(raw, 'http-equiv')?.toLowerCase() === 'content-security-policy' &&
      decodeHtmlAttribute(readAttribute(raw, 'content') ?? '') === expectedCsp
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
    const withoutComments = stripHtmlComments(html);
    const head = extractHead(withoutComments);
    const hasCspMeta = hasActiveCspMeta(head, csp);
    if (!hasCspMeta) throw new Error(`ARTIFACT_CSP_MISSING: ${page}`);
    if (hasMetaRefresh(withoutComments)) throw new Error(`ARTIFACT_META_REFRESH_PRESENT: ${page}`);
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
        source.includes('\\') ||
        !isArtifactScriptTarget(source, page, relativeFiles)
      )
        throw new Error(`ARTIFACT_EXTERNAL_SCRIPT_PRESENT: ${page}`);
    }
  }
  for (const file of allFiles) {
    const bytes = await readFile(file);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (forbiddenContent.test(text)) throw new Error(`ARTIFACT_PRIVATE_CONTENT_PRESENT: ${relative(root, file)}`);
    try {
      if (containsPrivateStateSchema(JSON.parse(text))) {
        throw new Error(`ARTIFACT_PRIVATE_STATE_SCHEMA_PRESENT: ${relative(root, file)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ARTIFACT_PRIVATE_STATE_SCHEMA_PRESENT:')) throw error;
    }
  }
  console.log(
    `artifact ok: ${relativeFiles.length} files; app ${provenance.appRevision}; catalogue ${catalogue.catalogueFingerprint}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
