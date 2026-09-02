import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative, posix } from 'node:path';
import process from 'node:process';
import { SyntaxKind } from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import {
  runtimeTupleFromProvenance,
  validateRuntimeAssetSetDirectory,
  validateRuntimeAssetSetPointer,
} from './runtime-assets.mjs';

const root = resolve(process.cwd(), process.argv[2] ?? 'dist/site');
const fontAssets = new Map([
  [
    'assets/fonts/nunito-sans-latin-400-normal.woff2',
    {
      byteLength: 13892,
      sha256: 'd9976dd1dc9c0d65046b52810e7cc69cfc229ee9939628ffe637e17efe4ef1ed',
    },
  ],
  [
    'assets/fonts/nunito-sans-latin-500-normal.woff2',
    {
      byteLength: 13968,
      sha256: '48dded5f1bd76377af9bd7da7da1433080e275bb26a81f1c1ae0dce3564d3f52',
    },
  ],
]);
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
  ...fontAssets.keys(),
];

function containsPrivateStateSchema(value) {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && value.schema === 'snoredex-collection-state') return true;
  return Object.values(value).some((entry) => containsPrivateStateSchema(entry));
}

function isArtifactUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.pathname.endsWith('/collector_catalogue.json')
    );
  } catch {
    return false;
  }
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
    .replace(/&(amp|apos|colon|gt|lt|quot|sol);/giu, (_, entity) => {
      const entities = { amp: '&', apos: "'", colon: ':', gt: '>', lt: '<', quot: '"', sol: '/' };
      return entities[entity.toLowerCase()];
    });
}

function hasResidualHtmlReference(value) {
  return /&(?:#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/iu.test(value);
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

function parseHtmlTagAt(html, start) {
  let cursor = start + 1;
  let quote;
  let tagNameComplete = false;
  let tagNameValid = false;
  let attributeName = false;
  let expectingValue = false;
  let unquotedValue = false;
  while (cursor < html.length) {
    const character = html[cursor];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '>') {
      const raw = html.slice(start, cursor + 1);
      const match = /^<(?:(\/))?([a-z][\w:-]*)(?=[\t\n\f\r />])/iu.exec(raw);
      return {
        closing: match?.[1] !== undefined,
        name: match?.[2]?.toLowerCase(),
        raw,
        end: cursor + 1,
      };
    } else if (!tagNameComplete) {
      if (cursor === start + 1 && character === '/') {
        cursor += 1;
        continue;
      }
      if (cursor === start + 1 && !/^[a-z]$/iu.test(character)) return { end: cursor };
      if (!tagNameValid) {
        if (/^[a-z]$/iu.test(character)) tagNameValid = true;
      } else if (/^[\w:-]$/u.test(character)) {
        // Continue the tag name.
      } else if (/[\t\n\f\r /]/u.test(character)) {
        tagNameComplete = true;
      } else {
        tagNameValid = false;
      }
    } else if (unquotedValue) {
      if (/[\t\n\f\r ]/u.test(character)) {
        unquotedValue = false;
        attributeName = false;
      }
    } else if (expectingValue && (character === '"' || character === "'")) {
      quote = character;
      expectingValue = false;
    } else if (expectingValue && !/[\t\n\f\r ]/u.test(character)) {
      expectingValue = false;
      attributeName = false;
      unquotedValue = true;
    } else if (character === '=' && attributeName) {
      expectingValue = true;
      attributeName = false;
    } else if (/[\t\n\f\r /]/u.test(character)) {
      attributeName = false;
    } else {
      attributeName = true;
    }
    cursor += 1;
  }
  return { end: html.length };
}

function hasTagNameAt(html, index, name) {
  const prefix = `<${name}`;
  return (
    html.slice(index, index + prefix.length).toLowerCase() === prefix &&
    /[\t\n\f\r />]/u.test(html[index + prefix.length] ?? '')
  );
}

function hasClosingTagNameAt(html, index, name) {
  const prefix = `</${name}`;
  return (
    html.slice(index, index + prefix.length).toLowerCase() === prefix &&
    /[\t\n\f\r />]/u.test(html[index + prefix.length] ?? '')
  );
}

function rawTextClosingEnd(html, index, name) {
  const tag = parseHtmlTagAt(html, index);
  return tag.closing && tag.name === name ? tag.end : -1;
}

function findRawTextEnd(html, index, name) {
  if (name === 'plaintext') return { end: html.length };
  if (name !== 'script') {
    while (index < html.length) {
      const end = rawTextClosingEnd(html, index, name);
      if (end >= 0) return { end, closeStart: index };
      index += 1;
    }
    return { end: html.length };
  }
  let state = 'data';
  while (index < html.length) {
    if (state === 'data') {
      if (html.startsWith('<!--', index)) {
        state = 'escaped';
        index += 4;
      } else {
        const end = rawTextClosingEnd(html, index, name);
        if (end >= 0) return { end, closeStart: index };
        index += 1;
      }
    } else if (state === 'escaped') {
      const end = rawTextClosingEnd(html, index, name);
      if (end >= 0) return { end, closeStart: index };
      if (hasTagNameAt(html, index, 'script')) {
        state = 'double-escaped';
        index += 1;
      } else if (html.startsWith('-->', index)) {
        state = 'data';
        index += 3;
      } else {
        index += 1;
      }
    } else {
      if (hasClosingTagNameAt(html, index, name)) {
        state = 'escaped';
        index += name.length + 2;
      } else if (hasTagNameAt(html, index, 'script')) {
        index += 1;
      } else {
        index += 1;
      }
    }
  }
  return { end: html.length };
}

function* htmlTags(html) {
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) return;
    const tag = parseHtmlTagAt(html, start);
    if (tag.name !== undefined) yield { ...tag, index: start };
    index = tag.end;
    if (index <= start) index = start + 1;
  }
}

function stripHtmlComments(html) {
  let output = '';
  let index = 0;
  let commentDepth = 0;
  let commentStart = false;
  let commentStartDash = false;
  let rawTextTag;
  let selectDepth = 0;
  let framesetDepth = 0;
  const namespaceStack = [{ name: '', namespace: 'html', integrationPoint: false }];
  const svgIntegrationPoints = new Set(['desc', 'foreignobject', 'title']);
  const htmlVoidElements = new Set([
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
  const resolveNamespace = (name) => {
    const parent = namespaceStack.at(-1);
    if (parent.namespace === 'html' || parent.integrationPoint) return name === 'svg' ? 'svg' : 'html';
    return 'svg';
  };
  const popNamespace = (name) => {
    for (let stackIndex = namespaceStack.length - 1; stackIndex > 0; stackIndex -= 1) {
      if (namespaceStack[stackIndex].name === name) {
        namespaceStack.length = stackIndex;
        return;
      }
    }
  };
  while (index < html.length) {
    if (commentDepth === 0) {
      if (rawTextTag !== undefined) {
        const rawText = findRawTextEnd(html, index, rawTextTag);
        const contentEnd = rawText.closeStart ?? rawText.end;
        output += html.slice(index, contentEnd).replaceAll('<', '\u0000');
        if (rawText.closeStart !== undefined) {
          output += html.slice(rawText.closeStart, rawText.end);
          popNamespace(rawTextTag);
        }
        index = rawText.end;
        rawTextTag = undefined;
        continue;
      }
      if (html.startsWith('<!--', index)) {
        commentDepth = 1;
        commentStart = true;
        commentStartDash = false;
        index += 4;
      } else if (html[index] === '<') {
        const tag = parseHtmlTagAt(html, index);
        if (tag.name !== undefined) {
          output += tag.raw;
          index = tag.end;
          if (tag.closing) {
            if (tag.name === 'select') selectDepth = Math.max(0, selectDepth - 1);
            if (tag.name === 'frameset') framesetDepth = Math.max(0, framesetDepth - 1);
            popNamespace(tag.name);
            continue;
          }
          const namespace = resolveNamespace(tag.name);
          if (tag.name === 'select') selectDepth += 1;
          if (tag.name === 'frameset') framesetDepth += 1;
          if (
            namespace === 'html' &&
            rawTextElements.has(tag.name) &&
            !(
              (selectDepth > 0 && tag.name !== 'script') ||
              (framesetDepth > 0 && tag.name !== 'script' && tag.name !== 'noframes')
            )
          )
            rawTextTag = tag.name;
          const selfClosing = /\/\s*>$/u.test(tag.raw);
          if (!selfClosing && !(namespace === 'html' && htmlVoidElements.has(tag.name))) {
            namespaceStack.push({
              name: tag.name,
              namespace,
              integrationPoint: namespace === 'svg' && svgIntegrationPoints.has(tag.name),
            });
          }
        } else {
          output += html[index];
          index += 1;
        }
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

function isArtifactAssetTarget(source, page, relativeFiles) {
  if (source.startsWith('/')) return false;
  const pathPart = source.split(/[?#]/u, 1)[0];
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathPart);
  } catch {
    return false;
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(decodedPath)) return false;
  const normalizedPath = posix.normalize(posix.join(posix.dirname(page), decodedPath));
  return normalizedPath !== '..' && !normalizedPath.startsWith('../') && relativeFiles.includes(normalizedPath);
}

function decodeCssEscapes(value) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\' || index + 1 >= value.length) {
      output += value[index] ?? '';
      continue;
    }
    const next = value[index + 1];
    if (/^[\da-f]$/iu.test(next)) {
      let end = index + 1;
      while (end < value.length && end <= index + 6 && /^[\da-f]$/iu.test(value[end])) end += 1;
      const codePoint = Number.parseInt(value.slice(index + 1, end), 16);
      output +=
        Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : '\ufffd';
      if (/^[\t\n\f\r ]$/u.test(value[end] ?? '')) {
        if (value[end] === '\r' && value[end + 1] === '\n') end += 1;
        index = end;
      } else {
        index = end - 1;
      }
      continue;
    }
    if (/^[\n\f\r]$/u.test(next)) {
      index += next === '\r' && value[index + 2] === '\n' ? 2 : 1;
      continue;
    }
    output += next;
    index += 1;
  }
  return output;
}

function stripCssComments(value) {
  let output = '';
  let quote;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      output += character;
      if (character === '\\' && index + 1 < value.length) {
        output += value[index + 1];
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
    } else if (character === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2);
      if (end < 0) break;
      output += ' ';
      index = end + 1;
    } else {
      output += character;
    }
  }
  return output;
}

function literalModuleSource(node) {
  return node?.kind === SyntaxKind.StringLiteral || node?.kind === SyntaxKind.NoSubstitutionTemplateLiteral
    ? node.text
    : '';
}

function moduleDependencySources(sourceFile) {
  const dependencies = [];
  function visit(node) {
    if (node.kind === SyntaxKind.ImportDeclaration) {
      dependencies.push(literalModuleSource(node.moduleSpecifier));
    } else if (node.kind === SyntaxKind.ExportDeclaration && node.moduleSpecifier) {
      dependencies.push(literalModuleSource(node.moduleSpecifier));
    } else if (
      node.kind === SyntaxKind.CallExpression &&
      (node.expression.kind === SyntaxKind.ImportKeyword ||
        (node.expression.kind === SyntaxKind.MetaProperty &&
          node.expression.keywordToken === SyntaxKind.ImportKeyword &&
          node.expression.name.text === 'source'))
    ) {
      dependencies.push(literalModuleSource(node.arguments[0]));
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);
  return dependencies;
}

function artifactModuleDependencies(files) {
  const dependencies = new Map();
  const api = new API({ cwd: root });
  const snapshot = api.updateSnapshot({ openFiles: files });
  try {
    for (const file of files) {
      const relativePath = relative(root, file).replaceAll('\\', '/');
      const project = snapshot.getDefaultProjectForFile(file);
      const sourceFile = project?.program.getSourceFile(file);
      if (!sourceFile || project.program.getSyntacticDiagnostics(file).length > 0) {
        throw new Error(`ARTIFACT_JAVASCRIPT_INVALID: ${relativePath}`);
      }
      dependencies.set(file, moduleDependencySources(sourceFile));
    }
  } finally {
    snapshot.dispose();
    api.close();
  }
  return dependencies;
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
  const commonCatalogueProvenance =
    catalogue &&
    catalogue.contractVersion === '1.0.0' &&
    /^sha256:[0-9a-f]{64}$/u.test(catalogue.catalogueFingerprint) &&
    catalogue.sourceRepository === 'https://github.com/m4s-ai/snoredex-data';
  const syntheticCatalogue =
    commonCatalogueProvenance &&
    catalogue.mode === 'synthetic-fixture' &&
    catalogue.sourceCommit === 'synthetic-fixture' &&
    catalogue.lock === null;
  const lock = catalogue?.lock;
  const pinnedCatalogue =
    commonCatalogueProvenance &&
    catalogue.mode === 'pinned-snapshot' &&
    /^[0-9a-f]{40}$/u.test(catalogue.sourceCommit) &&
    /^sha256:[0-9a-f]{64}$/u.test(catalogue.catalogueByteSha256) &&
    Number.isSafeInteger(catalogue.catalogueByteLength) &&
    catalogue.catalogueByteLength > 0 &&
    catalogue.catalogueFingerprint === lock?.catalogueFingerprint &&
    catalogue.catalogueByteSha256 === lock?.catalogueByteSha256 &&
    catalogue.catalogueByteLength === lock?.catalogueByteLength &&
    /^sha256:[0-9a-f]{64}$/u.test(catalogue.migrationByteSha256) &&
    Number.isSafeInteger(catalogue.migrationByteLength) &&
    catalogue.migrationByteLength > 0 &&
    catalogue.migrationByteSha256 === lock?.migrationByteSha256 &&
    catalogue.migrationByteLength === lock?.migrationByteLength &&
    lock?.schema === 'snoredex-checklist-catalogue-lock' &&
    lock?.schemaVersion === '1.0.0' &&
    lock?.sourceRepository === catalogue.sourceRepository &&
    lock?.producerRevision === catalogue.sourceCommit &&
    isArtifactUrl(lock?.artifactUrl) &&
    lock?.contractVersion === catalogue.contractVersion &&
    Array.isArray(lock?.issueUrls) &&
    lock.issueUrls.length > 0 &&
    lock.issueUrls.every((url) => typeof url === 'string');
  if (!syntheticCatalogue && !pinnedCatalogue) {
    throw new Error('ARTIFACT_CATALOGUE_PROVENANCE_INVALID');
  }
  let moduleManifest;
  let runtime;
  const runtimeSetTuples = new Map();
  if (pinnedCatalogue) {
    try {
      moduleManifest = JSON.parse(await readFile(join(root, 'assets/module-manifest.json'), 'utf8'));
      runtime = runtimeTupleFromProvenance(provenance);
    } catch {
      throw new Error('ARTIFACT_RUNTIME_MANIFEST_INVALID');
    }
    if (
      moduleManifest?.schema !== 'snoredex-site-module-manifest' ||
      moduleManifest?.schemaVersion !== '2.0.0' ||
      moduleManifest.appRevision !== provenance.appRevision ||
      !validateRuntimeAssetSetPointer(moduleManifest.runtimeAssetSet, provenance.appRevision) ||
      !Array.isArray(moduleManifest.retainedRuntimeAssetSets) ||
      moduleManifest.retainedRuntimeAssetSets.length > 1
    ) {
      throw new Error('ARTIFACT_RUNTIME_MANIFEST_INVALID');
    }
    const pointers = [moduleManifest.runtimeAssetSet, ...moduleManifest.retainedRuntimeAssetSets];
    if (new Set(pointers.map((pointer) => pointer.appRevision)).size !== pointers.length) {
      throw new Error('ARTIFACT_RUNTIME_MANIFEST_INVALID');
    }
    for (const pointer of pointers) {
      const expectedTuple = pointer.appRevision === runtime.appRevision ? runtime : undefined;
      if (
        !validateRuntimeAssetSetPointer(pointer) ||
        !(await validateRuntimeAssetSetDirectory(join(root, 'assets'), pointer, expectedTuple))
      ) {
        throw new Error('ARTIFACT_RUNTIME_SET_INVALID');
      }
      const directory = join(root, 'assets', ...pointer.path.split('/'));
      const setManifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
      runtimeSetTuples.set(pointer.appRevision, setManifest.runtime);
      const actual = (await filesIn(directory)).map((path) => relative(directory, path).replaceAll('\\', '/')).sort();
      const declared = ['manifest.json', ...setManifest.modules.map((module) => module.path)].sort();
      if (JSON.stringify(actual) !== JSON.stringify(declared))
        throw new Error('ARTIFACT_RUNTIME_SET_MEMBERSHIP_INVALID');
    }
  }
  if (relativeFiles.includes('deployment.json')) {
    let deployment;
    try {
      deployment = JSON.parse(await readFile(join(root, 'deployment.json'), 'utf8'));
    } catch {
      throw new Error('ARTIFACT_DEPLOYMENT_MANIFEST_INVALID');
    }
    if (
      deployment?.schema !== 'snoredex-checklist-deployment' ||
      deployment?.schemaVersion !== '1.0.0' ||
      deployment.pageUrl !== 'https://m4s-ai.github.io/snoredex-checklist/' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(deployment.publishedAt ?? '') ||
      deployment.appRevision !== provenance.appRevision ||
      deployment.producerRevision !== catalogue.sourceCommit ||
      deployment.contractVersion !== catalogue.contractVersion ||
      deployment.catalogueFingerprint !== catalogue.catalogueFingerprint ||
      deployment.catalogueByteSha256 !== catalogue.catalogueByteSha256 ||
      deployment.catalogueByteLength !== catalogue.catalogueByteLength ||
      deployment.migrationByteSha256 !== catalogue.migrationByteSha256 ||
      deployment.migrationByteLength !== catalogue.migrationByteLength ||
      JSON.stringify(deployment.runtimeAssetSet) !== JSON.stringify(moduleManifest?.runtimeAssetSet)
    ) {
      throw new Error('ARTIFACT_DEPLOYMENT_MANIFEST_INVALID');
    }
    const retained = moduleManifest.retainedRuntimeAssetSets;
    if (
      (deployment.rollback === undefined && retained.length !== 0) ||
      (deployment.rollback !== undefined &&
        (retained.length !== 1 ||
          deployment.rollback.appRevision !== retained[0].appRevision ||
          JSON.stringify(deployment.rollback.runtimeAssetSet) !== JSON.stringify(retained[0])))
    ) {
      throw new Error('ARTIFACT_DEPLOYMENT_ROLLBACK_INVALID');
    }
    if (deployment.rollback !== undefined) {
      const retainedRuntime = runtimeSetTuples.get(deployment.rollback.appRevision);
      for (const key of [
        'appRevision',
        'producerRevision',
        'contractVersion',
        'catalogueFingerprint',
        'catalogueByteSha256',
        'catalogueByteLength',
        'migrationByteSha256',
        'migrationByteLength',
      ]) {
        if (deployment.rollback[key] !== retainedRuntime?.[key]) {
          throw new Error('ARTIFACT_DEPLOYMENT_ROLLBACK_INVALID');
        }
      }
    }
  }

  const forbiddenContent = /\.snoredex-private\.json|synthetic-secret|PRIVATE-NOTE-DO-NOT-LOG/iu;
  const csp =
    "default-src 'none'; base-uri 'none'; form-action 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; worker-src 'none'; frame-src 'none'; font-src 'self'; media-src 'none'; manifest-src 'none'";
  for (const page of ['index.html', 'collection/index.html']) {
    const html = await readFile(join(root, page), 'utf8');
    const withoutComments = stripHtmlComments(html);
    const head = extractHead(withoutComments);
    const hasCspMeta = hasActiveCspMeta(head, csp);
    if (!hasCspMeta) throw new Error(`ARTIFACT_CSP_MISSING: ${page}`);
    if (hasMetaRefresh(withoutComments)) throw new Error(`ARTIFACT_META_REFRESH_PRESENT: ${page}`);
    if (/\b(?:unsafe-inline|unsafe-eval)\b/iu.test(html)) throw new Error(`ARTIFACT_CSP_UNSAFE_DIRECTIVE: ${page}`);
    if (/[\s/]on[a-z]+\s*=/iu.test(html)) throw new Error(`ARTIFACT_INLINE_HANDLER_PRESENT: ${page}`);
    if (pinnedCatalogue) {
      const prefix = page === 'index.html' ? '' : '../';
      const expectedSource = `${prefix}assets/${moduleManifest.runtimeAssetSet.path}/app.js`;
      if (!html.includes(`<script type="module" src="${expectedSource}"></script>`)) {
        throw new Error(`ARTIFACT_RUNTIME_SCRIPT_INVALID: ${page}`);
      }
    }
    for (const match of stripHtmlComments(html).matchAll(/<script\b[^>]*>/giu)) {
      const encodedSource = readAttribute(match[0], 'src');
      if (encodedSource === undefined) throw new Error(`ARTIFACT_INLINE_SCRIPT_PRESENT: ${page}`);
      const source = decodeHtmlAttribute(encodedSource);
      if (
        !source ||
        source !== source.trim() ||
        /[\u0000-\u0020\u007f]/u.test(source) ||
        source.includes('&') ||
        hasResidualHtmlReference(source) ||
        source.startsWith('/') ||
        /^[a-z][a-z\d+.-]*:/iu.test(source) ||
        source.includes('\\') ||
        !isArtifactAssetTarget(source, page, relativeFiles)
      )
        throw new Error(`ARTIFACT_EXTERNAL_SCRIPT_PRESENT: ${page}`);
    }
    for (const tag of htmlTags(withoutComments)) {
      if (tag.closing || tag.name !== 'link') continue;
      const rel = decodeHtmlAttribute(readAttribute(tag.raw, 'rel') ?? '')
        .trim()
        .toLowerCase()
        .split(/[\t\n\f\r ]+/u)
        .filter(Boolean);
      if (!rel.includes('stylesheet')) continue;
      const encodedSource = readAttribute(tag.raw, 'href');
      const source = encodedSource === undefined ? '' : decodeHtmlAttribute(encodedSource);
      if (
        !source ||
        source !== source.trim() ||
        /[\u0000-\u0020\u007f]/u.test(source) ||
        source.includes('\\') ||
        hasResidualHtmlReference(source) ||
        !isArtifactAssetTarget(source, page, relativeFiles)
      )
        throw new Error(`ARTIFACT_EXTERNAL_STYLESHEET_PRESENT: ${page}`);
    }
  }
  const moduleDependencies = artifactModuleDependencies(
    allFiles.filter((file) => /\.js$/iu.test(relative(root, file).replaceAll('\\', '/'))),
  );
  for (const file of allFiles) {
    const bytes = await readFile(file);
    const relativePath = relative(root, file).replaceAll('\\', '/');
    const font = fontAssets.get(relativePath);
    if (font) {
      if (bytes.byteLength !== font.byteLength || createHash('sha256').update(bytes).digest('hex') !== font.sha256) {
        throw new Error(`ARTIFACT_FONT_DIGEST_MISMATCH: ${relativePath}`);
      }
      continue;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/\.css$/iu.test(relativePath)) {
      for (const match of stripCssComments(decodeCssEscapes(text)).matchAll(
        /@import\b\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)|"([^"]*)"|'([^']*)')/giu,
      )) {
        const source = decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '');
        if (
          !source ||
          hasResidualHtmlReference(source) ||
          !isArtifactAssetTarget(source, relativePath, relativeFiles)
        ) {
          throw new Error(`ARTIFACT_EXTERNAL_CSS_IMPORT_PRESENT: ${relativePath}`);
        }
      }
    }
    if (/\.js$/iu.test(relativePath)) {
      for (const source of moduleDependencies.get(file) ?? []) {
        if (!isArtifactAssetTarget(source, relativePath, relativeFiles)) {
          throw new Error(`ARTIFACT_EXTERNAL_MODULE_PRESENT: ${relativePath}`);
        }
      }
    }
    if (forbiddenContent.test(text)) throw new Error(`ARTIFACT_PRIVATE_CONTENT_PRESENT: ${relativePath}`);
    try {
      if (containsPrivateStateSchema(JSON.parse(text))) {
        throw new Error(`ARTIFACT_PRIVATE_STATE_SCHEMA_PRESENT: ${relativePath}`);
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
