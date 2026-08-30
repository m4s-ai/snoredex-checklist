import { readdir, readFile, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { format } from 'prettier';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';

const root = resolve(process.cwd());
const outputPath = join(root, 'docs', 'complexity-report.md');
const shouldWrite = process.argv.includes('--write');
const shouldCheck = process.argv.includes('--check');
const sourceExtensions = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

function scan(source) {
  const scanner = createScanner(true, undefined, source);
  const tokens = [];
  let previous;
  const templateSubstitutionBraces = [];
  let kind;
  do {
    kind = scanner.scan();
    if (kind === SyntaxKind.TemplateHead) templateSubstitutionBraces.push(0);
    if (templateSubstitutionBraces.length > 0) {
      if (kind === SyntaxKind.OpenBraceToken) {
        templateSubstitutionBraces[templateSubstitutionBraces.length - 1] += 1;
      } else if (kind === SyntaxKind.CloseBraceToken) {
        const last = templateSubstitutionBraces.length - 1;
        if (templateSubstitutionBraces[last] > 0) {
          templateSubstitutionBraces[last] -= 1;
        } else {
          const templateKind = scanner.reScanTemplateToken();
          kind = templateKind;
          if (templateKind === SyntaxKind.TemplateTail) templateSubstitutionBraces.pop();
        }
      }
    }
    if (kind === SyntaxKind.SlashToken && shouldRescanSlash(previous)) kind = scanner.reScanSlashToken();
    if (kind !== SyntaxKind.EndOfFile) {
      previous = { kind, text: scanner.getTokenText() };
      tokens.push({ ...previous, start: scanner.getTokenStart() });
    }
  } while (kind !== SyntaxKind.EndOfFile);
  return tokens;
}

function canEndExpression(token) {
  if (!token) return false;
  return [
    SyntaxKind.Identifier,
    SyntaxKind.PrivateIdentifier,
    SyntaxKind.ThisKeyword,
    SyntaxKind.SuperKeyword,
    SyntaxKind.CloseParenToken,
    SyntaxKind.CloseBracketToken,
    SyntaxKind.CloseBraceToken,
    SyntaxKind.PlusPlusToken,
    SyntaxKind.MinusMinusToken,
    SyntaxKind.TrueKeyword,
    SyntaxKind.FalseKeyword,
    SyntaxKind.NullKeyword,
    SyntaxKind.NumericLiteral,
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.RegularExpressionLiteral,
    SyntaxKind.TemplateTail,
  ].includes(token.kind);
}

function shouldRescanSlash(previous) {
  return !canEndExpression(previous);
}

function pairBraces(tokens) {
  const stack = [];
  const pairs = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].kind === SyntaxKind.OpenBraceToken) stack.push(index);
    if (tokens[index].kind === SyntaxKind.CloseBraceToken) {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, index);
    }
  }
  return pairs;
}

function matching(tokens, start, openKind, closeKind) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].kind === openKind) depth += 1;
    if (tokens[index].kind === closeKind) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function identifierLike(token) {
  return token && (token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.ConstructorKeyword);
}

function looksLikeMethodName(tokens, nameIndex) {
  const previous = tokens[nameIndex - 1];
  if (!previous) return true;
  if ([SyntaxKind.DotToken, SyntaxKind.QuestionDotToken, SyntaxKind.CloseParenToken].includes(previous.kind))
    return false;
  return [
    SyntaxKind.OpenBraceToken,
    SyntaxKind.CloseBraceToken,
    SyntaxKind.SemicolonToken,
    SyntaxKind.CommaToken,
    SyntaxKind.GetKeyword,
    SyntaxKind.SetKeyword,
    SyntaxKind.StaticKeyword,
    SyntaxKind.PublicKeyword,
    SyntaxKind.PrivateKeyword,
    SyntaxKind.ProtectedKeyword,
    SyntaxKind.AsyncKeyword,
    SyntaxKind.AsteriskToken,
  ].includes(previous.kind);
}

function matchingOpen(tokens, close, openKind, closeKind) {
  let depth = 0;
  for (let index = close; index >= 0; index -= 1) {
    if (tokens[index].kind === closeKind) depth += 1;
    if (tokens[index].kind === openKind) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function isTypeOnlyArrow(tokens, arrowIndex) {
  const close = arrowIndex - 1;
  if (tokens[close]?.kind !== SyntaxKind.CloseParenToken) return false;
  const open = matchingOpen(tokens, close, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
  if (open === undefined) return false;
  if (tokens[open - 1]?.kind === SyntaxKind.NewKeyword) return true;
  if (tokens[open - 1]?.kind === SyntaxKind.ColonToken) return true;
  if (tokens[open - 1]?.kind === SyntaxKind.AsKeyword) return true;
  for (let index = open - 1; index >= 0; index -= 1) {
    const kind = tokens[index].kind;
    if ([SyntaxKind.SemicolonToken, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken].includes(kind)) break;
    if ([SyntaxKind.ConstKeyword, SyntaxKind.LetKeyword, SyntaxKind.VarKeyword].includes(kind)) return false;
    if ([SyntaxKind.TypeKeyword, SyntaxKind.InterfaceKeyword, SyntaxKind.DeclareKeyword].includes(kind)) return true;
  }
  return false;
}

function findBodyOpen(tokens, after, braces) {
  let inReturnType = false;
  let angleDepth = 0;
  for (let index = after + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!inReturnType && token.kind === SyntaxKind.ColonToken) {
      inReturnType = true;
      continue;
    }
    if (inReturnType) {
      if (token.kind === SyntaxKind.LessThanToken) angleDepth += 1;
      if (token.kind === SyntaxKind.GreaterThanToken) angleDepth = Math.max(0, angleDepth - 1);
      if (token.kind === SyntaxKind.GreaterThanGreaterThanToken) angleDepth = Math.max(0, angleDepth - 2);
      if (token.kind === SyntaxKind.GreaterThanGreaterThanGreaterThanToken) angleDepth = Math.max(0, angleDepth - 3);
      if (token.kind === SyntaxKind.OpenBraceToken) {
        const previousKind = tokens[index - 1]?.kind;
        const typeBrace =
          angleDepth > 0 ||
          [
            SyntaxKind.ColonToken,
            SyntaxKind.LessThanToken,
            SyntaxKind.BarToken,
            SyntaxKind.AmpersandToken,
            SyntaxKind.EqualsGreaterThanToken,
            SyntaxKind.CommaToken,
            SyntaxKind.OpenBracketToken,
            SyntaxKind.OpenParenToken,
          ].includes(previousKind);
        if (typeBrace) {
          const typeClose = braces.get(index);
          if (typeClose === undefined) return undefined;
          index = typeClose;
          continue;
        }
        return index;
      }
      if (token.kind === SyntaxKind.SemicolonToken) return undefined;
      continue;
    }
    if (token.kind === SyntaxKind.OpenBraceToken) return index;
    if ([SyntaxKind.SemicolonToken, SyntaxKind.CommaToken, SyntaxKind.EqualsGreaterThanToken].includes(token.kind))
      return undefined;
  }
  return undefined;
}

function findArrowExpressionEnd(tokens, start) {
  let parens = 0;
  let brackets = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const kind = tokens[index].kind;
    if (kind === SyntaxKind.OpenParenToken) parens += 1;
    else if (kind === SyntaxKind.CloseParenToken) {
      if (parens === 0 && brackets === 0) return index;
      parens -= 1;
    } else if (kind === SyntaxKind.OpenBracketToken) brackets += 1;
    else if (kind === SyntaxKind.CloseBracketToken) {
      if (brackets === 0 && parens === 0) return index;
      brackets -= 1;
    } else if (parens === 0 && brackets === 0 && [SyntaxKind.CommaToken, SyntaxKind.SemicolonToken].includes(kind))
      return index;
  }
  return tokens.length;
}

function arrowName(tokens, arrowIndex) {
  let cursor = arrowIndex - 1;
  if (tokens[cursor]?.kind === SyntaxKind.CloseParenToken) {
    let depth = 0;
    for (; cursor >= 0; cursor -= 1) {
      if (tokens[cursor].kind === SyntaxKind.CloseParenToken) depth += 1;
      if (tokens[cursor].kind === SyntaxKind.OpenParenToken) {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    cursor -= 1;
  }
  if (tokens[cursor]?.kind === SyntaxKind.EqualsToken && identifierLike(tokens[cursor - 1]))
    return tokens[cursor - 1].text;
  if (tokens[cursor - 1]?.kind === SyntaxKind.EqualsToken && identifierLike(tokens[cursor - 2]))
    return tokens[cursor - 2].text;
  return '<arrow>';
}

function isOptionalTypeProperty(tokens, index) {
  return tokens[index]?.kind === SyntaxKind.QuestionToken && tokens[index + 1]?.kind === SyntaxKind.ColonToken;
}

function collectFunctions(tokens, source, path) {
  const braces = pairBraces(tokens);
  const functions = [];
  const seen = new Set();
  const add = (start, range, name) => {
    const { bodyOpen, bodyClose, expressionStart, expressionEnd } = range;
    if (bodyOpen !== undefined && bodyClose === undefined) return;
    const end = bodyClose ?? expressionEnd;
    if (end === undefined || seen.has(bodyOpen ?? expressionStart)) return;
    seen.add(bodyOpen ?? expressionStart);
    const line = source.slice(0, tokens[start].start).split(/\r\n|\n|\r/u).length;
    functions.push({
      path: relative(root, path).split('\\').join('/'),
      name,
      line,
      bodyOpen,
      bodyClose,
      expressionStart,
      expressionEnd,
      complexity: 1,
    });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === SyntaxKind.FunctionKeyword) {
      let nameIndex = index + 1;
      if (tokens[nameIndex]?.kind === SyntaxKind.AsteriskToken) nameIndex += 1;
      const name = identifierLike(tokens[nameIndex]) ? tokens[nameIndex].text : '<anonymous>';
      const parameterOpen = tokens.findIndex(
        (candidate, candidateIndex) => candidateIndex > nameIndex && candidate.kind === SyntaxKind.OpenParenToken,
      );
      const parameterClose =
        parameterOpen === -1
          ? undefined
          : matching(tokens, parameterOpen, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
      const bodyOpen = parameterClose === undefined ? undefined : findBodyOpen(tokens, parameterClose, braces);
      if (bodyOpen !== undefined) add(index, { bodyOpen, bodyClose: braces.get(bodyOpen) }, name);
      continue;
    }
    if (token.kind === SyntaxKind.EqualsGreaterThanToken) {
      if (isTypeOnlyArrow(tokens, index)) continue;
      const name = arrowName(tokens, index);
      if (tokens[index + 1]?.kind === SyntaxKind.OpenBraceToken) {
        const bodyOpen = index + 1;
        add(index - 1, { bodyOpen, bodyClose: braces.get(bodyOpen) }, name);
      } else {
        add(index - 1, { expressionStart: index + 1, expressionEnd: findArrowExpressionEnd(tokens, index + 1) }, name);
      }
      continue;
    }
    if (
      token.kind !== SyntaxKind.OpenParenToken ||
      !identifierLike(tokens[index - 1]) ||
      !looksLikeMethodName(tokens, index - 1)
    )
      continue;
    const close = matching(tokens, index, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    const bodyOpen = close === undefined ? undefined : findBodyOpen(tokens, close, braces);
    if (bodyOpen !== undefined) add(index - 1, { bodyOpen, bodyClose: braces.get(bodyOpen) }, tokens[index - 1].text);
  }

  for (const entry of functions) {
    const start = entry.bodyOpen === undefined ? entry.expressionStart : entry.bodyOpen + 1;
    const end = entry.bodyClose ?? entry.expressionEnd;
    for (let index = start; index < end; index += 1) {
      const nested = functions.find(
        (candidate) =>
          (candidate.bodyOpen === index || candidate.expressionStart === index) &&
          (candidate.bodyClose ?? candidate.expressionEnd) < end,
      );
      if (nested) {
        index = nested.bodyClose ?? nested.expressionEnd;
        continue;
      }
      if (
        [
          SyntaxKind.IfKeyword,
          SyntaxKind.ForKeyword,
          SyntaxKind.WhileKeyword,
          SyntaxKind.DoKeyword,
          SyntaxKind.CatchKeyword,
          SyntaxKind.CaseKeyword,
          SyntaxKind.QuestionToken,
          SyntaxKind.AmpersandAmpersandToken,
          SyntaxKind.BarBarToken,
          SyntaxKind.QuestionQuestionToken,
        ].includes(tokens[index].kind)
      )
        if (!isOptionalTypeProperty(tokens, index)) entry.complexity += 1;
    }
    delete entry.bodyOpen;
    delete entry.bodyClose;
    delete entry.expressionStart;
    delete entry.expressionEnd;
  }
  return functions;
}

async function sourceFiles(directory) {
  const files = [];
  async function visit(current) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && sourceExtensions.includes(extname(entry.name))) files.push(path);
    }
  }
  await visit(directory);
  return files;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

function reportFor(files) {
  const entries = [];
  let lines = 0;
  for (const path of files) {
    const source = files.sourceByPath.get(path);
    lines += source.split(/\r\n|\n|\r/u).length;
    entries.push(...collectFunctions(scan(source), source, path));
  }
  entries.sort(
    (left, right) =>
      right.complexity - left.complexity ||
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.name.localeCompare(right.name),
  );
  const values = entries.map((entry) => entry.complexity).sort((left, right) => left - right);
  const sum = values.reduce((total, value) => total + value, 0);
  const mean = values.length === 0 ? 0 : sum / values.length;
  return [
    '# Cyclomatic complexity baseline',
    '',
    '> Advisory lexical estimate; this is not a release gate or a conformance claim.',
    '',
    `Scope: \`src/\` and \`scripts/\` (${files.length} production code files).`,
    `Lines: ${lines.toLocaleString('en-US')}.`,
    `Function-like nodes: ${entries.length.toLocaleString('en-US')}.`,
    `McCabe estimate: sum ${sum.toLocaleString('en-US')}; mean ${mean.toFixed(1)}; median ${percentile(values, 0.5)}; P90 ${percentile(values, 0.9)}; P95 ${percentile(values, 0.95)}.`,
    `Hotspots: ${entries.filter((entry) => entry.complexity > 10).length} functions exceed 10; ${entries.filter((entry) => entry.complexity > 20).length} exceed 20.`,
    '',
    'The estimate counts if/for/while/do/catch/case statements, conditional `?` tokens and `&&`/`||`/`??` operators inside function-like bodies. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.',
    '',
    '| Location | Function | Complexity |',
    '| --- | --- | ---: |',
    ...entries
      .slice(0, 20)
      .map((entry) => `| \`${entry.path}:${entry.line}\` | \`${entry.name}\` | ${entry.complexity} |`),
    '',
  ].join('\n');
}

if (process.argv.includes('--self-test')) {
  const samples = [
    {
      source:
        'function typed({ enabled }: { enabled: boolean }): { ok: boolean } { if (enabled) return { ok: true }; return { ok: false }; }',
      expected: [{ name: 'typed', complexity: 2 }],
    },
    {
      source: 'const expression = (value) => value && value > 0 ? value : 0;',
      expected: [{ name: 'expression', complexity: 3 }],
    },
    {
      source: 'function outer(values) { return values.map((value) => value ? value : 0); }',
      expected: [
        { name: 'outer', complexity: 1 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      source: 'function slash(value) { const pattern = /a&&b/u; return value / 2 && value; }',
      expected: [{ name: 'slash', complexity: 2 }],
    },
    {
      source: `class Visibility {
        public visible(value) { if (value) return true; return false; }
        private hidden(value) { if (value) return true; return false; }
      }`,
      expected: [
        { name: 'visible', complexity: 2 },
        { name: 'hidden', complexity: 2 },
      ],
    },
    {
      source: `type Handler = (value: string) => boolean;
        interface Handlers { callback?: (value: string) => boolean; }
        const typed: (value: string) => boolean = (value) => value.length > 0;`,
      expected: [{ name: '<arrow>', complexity: 1 }],
    },
    {
      source: `const invoke = (request) => (request as (name: string) => Promise<string>)(name);`,
      expected: [{ name: 'invoke', complexity: 1 }],
    },
    {
      source: 'type Constructor = new (value: string) => Promise<string>; const build = (value) => value ? value : "";',
      expected: [{ name: 'build', complexity: 2 }],
    },
    {
      source: 'function template(value) { return `raw ${value ? 1 : 2} literal?` ?? value; }',
      expected: [{ name: 'template', complexity: 3 }],
    },
    {
      source: 'function optionalType(value) { const result: { enabled?: boolean } = {}; return value ? result : {}; }',
      expected: [{ name: 'optionalType', complexity: 2 }],
    },
    {
      source: 'function nestedTemplate(localization) { return `${{ localization }.localization ?? "unknown"}`; }',
      expected: [{ name: 'nestedTemplate', complexity: 2 }],
    },
    {
      source: 'function wrapped(): Promise<{ ok: boolean }> { if (true) return { ok: true }; return { ok: false }; }',
      expected: [{ name: 'wrapped', complexity: 2 }],
    },
    {
      source: 'function union(): { ok: boolean } | null { return null; }',
      expected: [{ name: 'union', complexity: 1 }],
    },
  ];
  for (const sample of samples) {
    const actual = collectFunctions(scan(sample.source), sample.source, 'fixture.ts').map(({ name, complexity }) => ({
      name,
      complexity,
    }));
    assert.deepEqual(actual, sample.expected);
  }
  console.log('complexity self-test passed');
  process.exit(0);
}

const files = await sourceFiles(join(root, 'src'));
files.push(...(await sourceFiles(join(root, 'scripts'))));
files.sourceByPath = new Map();
for (const path of files) files.sourceByPath.set(path, await readFile(path, 'utf8'));
const report = await format(reportFor(files), { endOfLine: 'lf', parser: 'markdown' });

if (shouldWrite) {
  await writeFile(outputPath, report, 'utf8');
  console.log(`wrote ${relative(root, outputPath)}`);
} else if (shouldCheck) {
  const current = await readFile(outputPath, 'utf8').catch(() => undefined);
  if (current !== report) {
    console.error('complexity report is stale; run npm run complexity:report');
    process.exitCode = 1;
  } else {
    console.log('complexity report is current');
  }
} else {
  process.stdout.write(report);
}
