import { readdir, readFile, writeFile } from 'node:fs/promises';
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
  let kind;
  do {
    kind = scanner.scan();
    if (kind === SyntaxKind.SlashToken) kind = scanner.reScanSlashToken();
    if (kind !== SyntaxKind.EndOfFile)
      tokens.push({ kind, text: scanner.getTokenText(), start: scanner.getTokenStart() });
  } while (kind !== SyntaxKind.EndOfFile);
  return tokens;
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

function collectFunctions(tokens, source, path) {
  const braces = pairBraces(tokens);
  const functions = [];
  const seen = new Set();
  const add = (start, bodyOpen, name) => {
    const bodyClose = braces.get(bodyOpen);
    if (bodyClose === undefined || seen.has(bodyOpen)) return;
    seen.add(bodyOpen);
    let complexity = 1;
    for (let index = bodyOpen + 1; index < bodyClose; index += 1) {
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
        complexity += 1;
    }
    const line = source.slice(0, tokens[start].start).split(/\r\n|\n|\r/u).length;
    functions.push({ path: relative(root, path).split('\\').join('/'), name, line, complexity });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === SyntaxKind.FunctionKeyword) {
      let nameIndex = index + 1;
      if (tokens[nameIndex]?.kind === SyntaxKind.AsteriskToken) nameIndex += 1;
      const name = identifierLike(tokens[nameIndex]) ? tokens[nameIndex].text : '<anonymous>';
      const bodyOpen = tokens.findIndex(
        (candidate, candidateIndex) => candidateIndex > nameIndex && candidate.kind === SyntaxKind.OpenBraceToken,
      );
      if (bodyOpen !== -1) add(index, bodyOpen, name);
      continue;
    }
    if (token.kind === SyntaxKind.EqualsGreaterThanToken) {
      const previous = tokens[index - 1];
      const name = identifierLike(previous) ? previous.text : '<arrow>';
      if (tokens[index + 1]?.kind === SyntaxKind.OpenBraceToken) add(index - 1, index + 1, name);
      continue;
    }
    if (token.kind !== SyntaxKind.OpenParenToken || !identifierLike(tokens[index - 1])) continue;
    const close = matching(tokens, index, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken);
    if (close !== undefined && tokens[close + 1]?.kind === SyntaxKind.OpenBraceToken)
      add(index - 1, close + 1, tokens[index - 1].text);
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
