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
  while (index < html.length) {
    if (commentDepth === 0) {
      if (rawTextTag !== undefined) {
        const rawText = findRawTextEnd(html, index, rawTextTag);
        const contentEnd = rawText.closeStart ?? rawText.end;
        output += html.slice(index, contentEnd).replaceAll('<', '\u0000');
        if (rawText.closeStart !== undefined) output += html.slice(rawText.closeStart, rawText.end);
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
          if (tag.name === 'select') selectDepth = Math.max(0, selectDepth + (tag.closing ? -1 : 1));
          if (tag.name === 'frameset') framesetDepth = Math.max(0, framesetDepth + (tag.closing ? -1 : 1));
          if (
            !tag.closing &&
            rawTextElements.has(tag.name) &&
            !((selectDepth > 0 || framesetDepth > 0) && tag.name !== 'script')
          )
            rawTextTag = tag.name;
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

function moduleDependencySources(value) {
  const sources = [stripJavaScriptComments(value), ...extractTemplateExpressions(value).map(stripJavaScriptComments)];
  const dependencies = [];
  for (const source of sources) {
    dependencies.push(...dynamicModuleDependencies(source));
    dependencies.push(...staticModuleDependencies(source));
  }
  return dependencies;
}

function dynamicModuleDependencies(value) {
  const dependencies = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' || character === "'") {
      index = skipJavaScriptQuoted(value, index, character) - 1;
      continue;
    }
    if (character === '`') {
      index = collectTemplateExpressions(value, index + 1, []) - 1;
      continue;
    }
    if (character === '/' && isJavaScriptRegexStart(value, index)) {
      index = skipJavaScriptRegex(value, index) - 1;
      continue;
    }
    const token = /\bimport\b/gu.exec(value.slice(index));
    if (token?.index !== 0) continue;
    let cursor = index + token[0].length;
    while (/\s/u.test(value[cursor] ?? '')) cursor += 1;
    const dynamicImport = value[cursor] === '(';
    if (dynamicImport) {
      cursor += 1;
      while (/\s/u.test(value[cursor] ?? '')) cursor += 1;
    }
    const quote = value[cursor];
    if (quote === '"' || quote === "'") {
      const end = skipJavaScriptQuoted(value, cursor, quote);
      dependencies.push(value.slice(cursor + 1, end - 1));
      index = end - 1;
      continue;
    }
    if (value[cursor] === '`') {
      const end = collectTemplateExpressions(value, cursor + 1, []);
      const source = value.slice(cursor + 1, end - 1);
      if (!source.includes('$')) dependencies.push(source);
      index = end - 1;
      continue;
    }
    if (dynamicImport) dependencies.push('');
  }
  return dependencies;
}

function staticModuleDependencies(value) {
  const dependencies = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' || character === "'") {
      index = skipJavaScriptQuoted(value, index, character) - 1;
      continue;
    }
    if (character === '`') {
      index = collectTemplateExpressions(value, index + 1, []) - 1;
      continue;
    }
    if (character === '/' && isJavaScriptRegexStart(value, index)) {
      index = skipJavaScriptRegex(value, index) - 1;
      continue;
    }
    const token = /\b(?:import|export)\b/gu.exec(value.slice(index));
    if (token?.index !== 0) continue;
    const dependency = staticModuleDependency(value, index + token[0].length);
    if (dependency !== undefined) dependencies.push(dependency);
    index += token[0].length - 1;
  }
  return dependencies;
}

function staticModuleDependency(value, index) {
  let braceDepth = 0;
  for (let cursor = index; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (character === '"' || character === "'") {
      cursor = skipJavaScriptQuoted(value, cursor, character) - 1;
      continue;
    }
    if (character === '`') {
      cursor = collectTemplateExpressions(value, cursor + 1, []) - 1;
      continue;
    }
    if (character === '/' && isJavaScriptRegexStart(value, cursor)) {
      cursor = skipJavaScriptRegex(value, cursor) - 1;
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      continue;
    }
    if (character === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (character === ';' && braceDepth === 0) return undefined;
    const from = /\bfrom\s*(['"])/gu.exec(value.slice(cursor));
    if (from?.index !== 0) continue;
    const quote = from[1];
    const sourceStart = cursor + from[0].length;
    const sourceEnd = value.indexOf(quote, sourceStart);
    return sourceEnd < 0 ? undefined : value.slice(sourceStart, sourceEnd);
  }
  return undefined;
}

function extractTemplateExpressions(value) {
  const sources = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"' || character === "'") {
      index = skipJavaScriptQuoted(value, index, character) - 1;
    } else if (character === '/' && value[index + 1] === '/') {
      index = skipJavaScriptLineComment(value, index) - 1;
    } else if (character === '/' && value[index + 1] === '*') {
      index = skipJavaScriptBlockComment(value, index) - 1;
    } else if (character === '`') {
      index = collectTemplateExpressions(value, index + 1, sources) - 1;
    }
  }
  return sources;
}

function collectTemplateExpressions(value, index, sources) {
  while (index < value.length) {
    if (value[index] === '\\') {
      index += 2;
    } else if (value[index] === '`') {
      return index + 1;
    } else if (value[index] === '$' && value[index + 1] === '{') {
      const expressionStart = index + 2;
      const expressionEnd = collectJavaScriptExpression(value, expressionStart, sources);
      sources.push(value.slice(expressionStart, expressionEnd - 1));
      index = expressionEnd;
    } else {
      index += 1;
    }
  }
  return value.length;
}

function collectJavaScriptExpression(value, index, sources) {
  let depth = 1;
  while (index < value.length) {
    const character = value[index];
    if (character === '"' || character === "'") {
      index = skipJavaScriptQuoted(value, index, character);
    } else if (character === '/' && value[index + 1] === '/') {
      index = skipJavaScriptLineComment(value, index);
    } else if (character === '/' && value[index + 1] === '*') {
      index = skipJavaScriptBlockComment(value, index);
    } else if (character === '`') {
      index = collectTemplateExpressions(value, index + 1, sources);
    } else if (character === '/' && isJavaScriptRegexStart(value, index)) {
      index = skipJavaScriptRegex(value, index);
    } else if (character === '{') {
      depth += 1;
      index += 1;
    } else if (character === '}') {
      depth -= 1;
      index += 1;
      if (depth === 0) return index;
    } else {
      index += 1;
    }
  }
  return value.length;
}

function skipJavaScriptQuoted(value, index, quote) {
  index += 1;
  while (index < value.length) {
    if (value[index] === '\\') index += 2;
    else if (value[index++] === quote) return index;
  }
  return value.length;
}

function skipJavaScriptLineComment(value, index) {
  for (let end = index + 2; end < value.length; end += 1) {
    if (isJavaScriptLineTerminator(value[end])) return end;
  }
  return value.length;
}

function isJavaScriptLineTerminator(character) {
  return character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029';
}

function skipJavaScriptBlockComment(value, index) {
  const end = value.indexOf('*/', index + 2);
  return end < 0 ? value.length : end + 2;
}

function isJavaScriptRegexStart(value, index) {
  let previous = index - 1;
  let lineTerminator = false;
  while (previous >= 0 && /\s/u.test(value[previous])) {
    if (isJavaScriptLineTerminator(value[previous])) lineTerminator = true;
    previous -= 1;
  }
  if (previous < 0 || /[({[=,:;!?&|+\-*%^~<>]/u.test(value[previous])) return true;
  if (value[previous] === ')') return isControlConditionEnd(value, previous);
  if (value[previous] === '}') return isJavaScriptBlockEnd(value, previous);
  const token = /([a-z_$][\w$]*)$/iu.exec(value.slice(0, previous + 1));
  if (token === null) return false;
  let beforeToken = token.index - 1;
  while (beforeToken >= 0 && /\s/u.test(value[beforeToken])) beforeToken -= 1;
  if (
    value[beforeToken] === '.' ||
    value[beforeToken] === '#' ||
    (value[beforeToken] === '?' && value[beforeToken - 1] === '.')
  )
    return false;
  return (
    /^(?:await|case|default|delete|do|else|extends|in|instanceof|new|of|return|throw|typeof|void|yield)$/iu.test(
      token[1],
    ) ||
    (lineTerminator && /^(?:break|continue|debugger)$/iu.test(token[1]))
  );
}

function skipJavaScriptRegexBackward(value, closeIndex) {
  let inCharacterClass = false;
  for (let index = closeIndex - 1; index >= 0; index -= 1) {
    const character = value[index];
    if (character === '\\') {
      index -= 1;
    } else if (inCharacterClass) {
      if (character === '[') inCharacterClass = false;
    } else if (character === ']') {
      inCharacterClass = true;
    } else if (character === '/') {
      return isJavaScriptRegexStart(value, index) ? index : -1;
    }
  }
  return -1;
}

function isJavaScriptFunctionExpression(prefix) {
  let close = prefix.length - 1;
  while (close >= 0 && /\s/u.test(prefix[close])) close -= 1;
  if (prefix[close] !== ')') return false;
  let depth = 0;
  let open = -1;
  for (let index = close; index >= 0; index -= 1) {
    const character = prefix[index];
    if (character === '"' || character === "'") {
      index = skipJavaScriptQuotedBackward(prefix, index);
      continue;
    }
    if (character === '`') {
      index = skipJavaScriptTemplateBackward(prefix, index);
      continue;
    }
    if (character === '/') {
      const regexStart = skipJavaScriptRegexBackward(prefix, index);
      if (regexStart >= 0) {
        index = regexStart;
        continue;
      }
    }
    if (character === ')') depth += 1;
    else if (character === '(') {
      depth -= 1;
      if (depth === 0) {
        open = index;
        break;
      }
    }
  }
  if (open < 0) return false;
  const functionToken = /(?:async\s+)?function(?:\s*\*)?(?:\s+[a-z_$][\w$]*)?\s*$/iu.exec(prefix.slice(0, open));
  if (functionToken === null) return false;
  let beforeFunction = functionToken.index - 1;
  while (beforeFunction >= 0 && /\s/u.test(prefix[beforeFunction])) beforeFunction -= 1;
  if (beforeFunction < 0 || /[;}]/u.test(prefix[beforeFunction])) {
    const preceding = prefix.slice(0, beforeFunction + 1);
    return /(?:^|\s)(?:return|yield|await|throw)\s*$/iu.test(preceding);
  }
  if (/[=(:,[!?&|+\-*%^~<>]/u.test(prefix[beforeFunction])) return true;
  return /(?:^|\s)(?:return|yield|await|throw)\s*$/iu.test(prefix.slice(0, beforeFunction + 1));
}

function isJavaScriptBlockEnd(value, closeIndex) {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    const character = value[index];
    if (character === '"' || character === "'") {
      index = skipJavaScriptQuotedBackward(value, index);
      continue;
    }
    if (character === '`') {
      index = skipJavaScriptTemplateBackward(value, index);
      continue;
    }
    if (character === '/') {
      const regexStart = skipJavaScriptRegexBackward(value, index);
      if (regexStart >= 0) {
        index = regexStart;
        continue;
      }
    }
    if (character === '}') {
      depth += 1;
      continue;
    }
    if (character !== '{') continue;
    depth -= 1;
    if (depth !== 0) continue;
    let before = index - 1;
    while (before >= 0 && /\s/u.test(value[before])) before -= 1;
    if (before < 0 || /[;}]/u.test(value[before])) return true;
    if (value[before] === '>' && value[before - 1] === '=') return true;
    if (value[before] === ')') {
      return !isJavaScriptFunctionExpression(value.slice(0, before + 1));
    }
    const prefix = value.slice(0, before + 1);
    if (/(?:^|\s)(?:catch|do|else|finally|try)\s*$/iu.test(prefix)) return true;
    if (isJavaScriptLabeledBlock(value, prefix)) return true;
    const classToken = /\bclass(?:\s+[a-z_$][\w$]*)?(?:\s+extends[\s\S]*)?\s*$/iu.exec(prefix);
    if (classToken === null) return false;
    let beforeClass = classToken.index - 1;
    while (beforeClass >= 0 && /\s/u.test(prefix[beforeClass])) beforeClass -= 1;
    return (
      beforeClass < 0 ||
      /[;}]/u.test(prefix[beforeClass]) ||
      /(?:^|\s)export(?:\s+default)?\s*$/iu.test(prefix.slice(0, beforeClass + 1))
    );
  }
  return false;
}

function isJavaScriptLabeledBlock(value, prefix) {
  const label = /([a-z_$][\w$]*)\s*:\s*$/iu.exec(prefix);
  if (label === null) return false;
  let beforeLabel = label.index - 1;
  while (beforeLabel >= 0 && /\s/u.test(prefix[beforeLabel])) beforeLabel -= 1;
  if (beforeLabel < 0 || /[;\n]/u.test(prefix[beforeLabel])) return true;
  return prefix[beforeLabel] === '{' && isJavaScriptBlockOpen(value, beforeLabel);
}

function isJavaScriptBlockOpen(value, openIndex) {
  let before = openIndex - 1;
  while (before >= 0 && /\s/u.test(value[before])) before -= 1;
  if (before < 0 || /[;}]/u.test(value[before])) return true;
  if (value[before] === ')' || (value[before] === '>' && value[before - 1] === '=')) return true;
  const prefix = value.slice(0, before + 1);
  if (/(?:^|\s)(?:catch|do|else|finally|try)\s*$/iu.test(prefix)) return true;
  const classToken = /\bclass(?:\s+[a-z_$][\w$]*)?(?:\s+extends[\s\S]*)?\s*$/iu.exec(prefix);
  if (classToken !== null) {
    let beforeClass = classToken.index - 1;
    while (beforeClass >= 0 && /\s/u.test(prefix[beforeClass])) beforeClass -= 1;
    if (beforeClass < 0 || /[;}]/u.test(prefix[beforeClass])) return true;
    if (/(?:^|\s)export(?:\s+default)?\s*$/iu.test(prefix.slice(0, beforeClass + 1))) return true;
  }
  return isJavaScriptLabeledBlock(value, prefix);
}

function isControlConditionEnd(value, closeIndex) {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    if (value[index] === '`') {
      index = skipJavaScriptTemplateBackward(value, index);
      continue;
    }
    if (value[index] === '"' || value[index] === "'") {
      index = skipJavaScriptQuotedBackward(value, index);
      continue;
    }
    if (value[index] === '/') {
      const regexStart = skipJavaScriptRegexBackward(value, index);
      if (regexStart >= 0) {
        index = regexStart;
        continue;
      }
    }
    if (value[index] === ')') depth += 1;
    else if (value[index] === '(') {
      depth -= 1;
      if (depth === 0) {
        let before = index - 1;
        while (before >= 0 && /\s/u.test(value[before])) before -= 1;
        const token = /([a-z_$][\w$]*)$/iu.exec(value.slice(0, before + 1));
        return token !== null && /^(?:catch|for|if|switch|while|with)$/iu.test(token[1]);
      }
    }
  }
  return false;
}

function skipJavaScriptTemplateBackward(value, closeIndex) {
  for (let index = closeIndex - 1; index >= 0; index -= 1) {
    if (value[index] !== '`') continue;
    let escapes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) escapes += 1;
    if (escapes % 2 === 0) return index;
  }
  return -1;
}

function skipJavaScriptQuotedBackward(value, closeIndex) {
  const quote = value[closeIndex];
  for (let index = closeIndex - 1; index >= 0; index -= 1) {
    if (value[index] !== quote) continue;
    let escapes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) escapes += 1;
    if (escapes % 2 === 0) return index;
  }
  return -1;
}

function skipJavaScriptRegex(value, index) {
  let inCharacterClass = false;
  for (let cursor = index + 1; cursor < value.length; cursor += 1) {
    if (value[cursor] === '\\') {
      cursor += 1;
    } else if (value[cursor] === '[') {
      inCharacterClass = true;
    } else if (value[cursor] === ']') {
      inCharacterClass = false;
    } else if (value[cursor] === '/' && !inCharacterClass) {
      cursor += 1;
      while (cursor < value.length && /[a-z]/iu.test(value[cursor])) cursor += 1;
      return cursor;
    }
  }
  return value.length;
}

function stripJavaScriptComments(value) {
  let output = '';
  let quote;
  let lineComment = false;
  let blockComment = false;
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
    if (lineComment) {
      if (isJavaScriptLineTerminator(character)) {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && value[index + 1] === '/') {
        blockComment = false;
        output += ' ';
        index += 1;
      } else if (isJavaScriptLineTerminator(character)) {
        output += character;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      output += character;
    } else if (
      character === '/' &&
      value[index + 1] !== '/' &&
      value[index + 1] !== '*' &&
      isJavaScriptRegexStart(output, output.length)
    ) {
      const end = skipJavaScriptRegex(value, index);
      output += value.slice(index, end);
      index = end - 1;
    } else if (character === '/' && value[index + 1] === '/') {
      lineComment = true;
      output += ' ';
      index += 1;
    } else if (character === '/' && value[index + 1] === '*') {
      blockComment = true;
      output += ' ';
      index += 1;
    } else {
      output += character;
    }
  }
  return output;
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
  for (const file of allFiles) {
    const bytes = await readFile(file);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const relativePath = relative(root, file).replaceAll('\\', '/');
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
      for (const source of moduleDependencySources(text)) {
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
