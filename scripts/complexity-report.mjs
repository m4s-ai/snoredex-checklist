import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { format } from 'prettier';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';

const root = resolve(process.cwd());
const outputPath = join(root, 'docs', 'complexity-report.md');
const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const functionKinds = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
]);

const decisionKinds = new Set([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CatchClause,
  SyntaxKind.CaseClause,
  SyntaxKind.ConditionalExpression,
]);

const logicalOperators = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

function isFunctionNode(node) {
  return functionKinds.has(node.kind);
}

function nodeName(node, sourceFile) {
  if (!node) return undefined;
  if (
    [SyntaxKind.Identifier, SyntaxKind.PrivateIdentifier, SyntaxKind.StringLiteral, SyntaxKind.NumericLiteral].includes(
      node.kind,
    )
  )
    return node.text ?? node.getText(sourceFile);
  if (node.kind === SyntaxKind.ComputedPropertyName) return '<computed>';
  return node.getText(sourceFile);
}

function functionName(node, sourceFile) {
  if (node.kind === SyntaxKind.Constructor) return 'constructor';
  const declaredName = nodeName(node.name, sourceFile);
  if (declaredName) return declaredName;

  const parent = node.parent;
  if (parent?.kind === SyntaxKind.VariableDeclaration) {
    const bindingName = nodeName(parent.name, sourceFile);
    if (bindingName) return bindingName;
  }
  if (parent?.kind === SyntaxKind.PropertyAssignment || parent?.kind === SyntaxKind.PropertyDeclaration) {
    const propertyName = nodeName(parent.name, sourceFile);
    if (propertyName) return propertyName;
  }
  return node.kind === SyntaxKind.ArrowFunction ? '<arrow>' : '<anonymous>';
}

function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function collectFunctions(sourceFile, filePath) {
  const functions = [];
  walk(sourceFile, (node) => {
    if (!isFunctionNode(node) || !node.body) return;
    const position = node.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(position);
    functions.push({
      path: relative(root, filePath).split('\\').join('/'),
      name: functionName(node, sourceFile),
      line: line + 1,
      parameters: node.parameters ?? [],
      body: node.body,
      complexity: 1,
    });
  });
  return functions;
}

function countDecisions(functionEntry) {
  if (isFunctionNode(functionEntry.body)) return 0;
  let decisions = 0;
  function visit(node) {
    if (node !== functionEntry.body && isFunctionNode(node)) return;
    if (
      decisionKinds.has(node.kind) ||
      (node.kind === SyntaxKind.BinaryExpression && logicalOperators.has(node.operatorToken?.kind))
    ) {
      decisions += 1;
    }
    node.forEachChild(visit);
  }
  visit(functionEntry.body);
  for (const parameter of functionEntry.parameters) {
    if (parameter.initializer) visit(parameter.initializer);
    if (parameter.name) visit(parameter.name);
  }
  return decisions;
}

function countSourceLines(source) {
  const lines = source.split(/\r\n|\n|\r/u).length;
  return lines - (/(?:\r\n|\n|\r)$/u.test(source) ? 1 : 0);
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

async function analyzeFiles(files, apiRoot = root) {
  const absoluteFiles = files.map((filePath) => resolve(filePath));
  const api = new API({ cwd: apiRoot });
  const snapshot = api.updateSnapshot({ openFiles: absoluteFiles });
  try {
    const analyzed = [];
    for (const filePath of absoluteFiles) {
      const project = snapshot.getDefaultProjectForFile(filePath);
      const sourceFile = project?.program.getSourceFile(filePath);
      if (!sourceFile) throw new Error(`TypeScript did not parse ${filePath}`);
      const source = sourceFile.text;
      const functions = collectFunctions(sourceFile, filePath);
      for (const entry of functions) entry.complexity += countDecisions(entry);
      analyzed.push({ path: filePath, source, functions });
    }
    return analyzed;
  } finally {
    snapshot.dispose();
    api.close();
  }
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

async function reportFor(files) {
  const analyzed = await analyzeFiles(files);
  const entries = analyzed.flatMap(({ functions }) => functions);
  const lines = analyzed.reduce((total, { source }) => total + countSourceLines(source), 0);
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
    '> Advisory AST-derived estimate; this is not a release gate or a conformance claim.',
    '',
    `Scope: \`src/\` and \`scripts/\` (${files.length} production code files).`,
    `Lines: ${lines.toLocaleString('en-US')}.`,
    `Function-like nodes: ${entries.length.toLocaleString('en-US')}.`,
    `McCabe estimate: sum ${sum.toLocaleString('en-US')}; mean ${mean.toFixed(1)}; median ${percentile(values, 0.5)}; P90 ${percentile(values, 0.9)}; P95 ${percentile(values, 0.95)}.`,
    `Hotspots: ${entries.filter((entry) => entry.complexity > 10).length} functions exceed 10; ${entries.filter((entry) => entry.complexity > 20).length} exceed 20.`,
    '',
    'The report parses each source file with the bundled TypeScript compiler and counts runtime function-like declarations plus structural decision nodes: if/for/while/do/catch/case statements, conditional expressions and logical (&&/||/??) binary expressions. Type-only function signatures and nested function bodies are excluded from their enclosing function. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.',
    '',
    '| Location | Function | Complexity |',
    '| --- | --- | ---: |',
    ...entries
      .slice(0, 20)
      .map((entry) => `| \`${entry.path}:${entry.line}\` | \`${entry.name}\` | ${entry.complexity} |`),
    '',
  ].join('\n');
}

async function selfTest() {
  const samples = [
    {
      name: 'basic.ts',
      source:
        'function typed({ enabled }: { enabled: boolean }): { ok: boolean } { if (enabled) return { ok: true }; return { ok: false }; }',
      expected: [{ name: 'typed', complexity: 2 }],
    },
    {
      name: 'default-parameter.ts',
      source: 'function select(value = ready ? yes : no) { return value; }',
      expected: [{ name: 'select', complexity: 2 }],
    },
    {
      name: 'destructured-default.ts',
      source: 'function pick({ value = ready ? yes : no }) { return value; }',
      expected: [{ name: 'pick', complexity: 2 }],
    },
    {
      name: 'logical.ts',
      source: 'const expression = (value) => value && value > 0 ? value : 0;',
      expected: [{ name: 'expression', complexity: 3 }],
    },
    {
      name: 'nested.ts',
      source: 'function outer(values) { return values.map((value) => value ? value : 0); }',
      expected: [
        { name: 'outer', complexity: 1 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      name: 'concise-return.ts',
      source: 'const make = () => value => value ? yes : no;',
      expected: [
        { name: 'make', complexity: 1 },
        { name: '<arrow>', complexity: 2 },
      ],
    },
    {
      name: 'types.ts',
      source:
        'type Handler = (value: string) => boolean; interface Handlers { callback?: (value: string) => boolean; } const typed: (value: string) => boolean = (value) => value.length > 0;',
      expected: [{ name: 'typed', complexity: 1 }],
    },
    {
      name: 'operators.ts',
      source: 'function operators(value, ready) { return value / 2 && ready ? value ** 2 : value % 2 || value; }',
      expected: [{ name: 'operators', complexity: 4 }],
    },
    {
      name: 'jsx.tsx',
      source:
        'function view(ready) { const render = () => <Comp<boolean> child={<span />} />; return <div>{ready ? render() : null}</div>; }',
      expected: [
        { name: 'view', complexity: 2 },
        { name: 'render', complexity: 1 },
      ],
    },
    {
      name: 'jsx-types.tsx',
      source: 'function generic() { return <Comp<(<T,>() => T)> value={ready ? true : false} />; }',
      expected: [{ name: 'generic', complexity: 2 }],
    },
    {
      name: 'jsx-namespace.tsx',
      source: 'function namespaced() { return <ns:Comp<(<T,>() => T)> />; }',
      expected: [{ name: 'namespaced', complexity: 1 }],
    },
    {
      name: 'methods.ts',
      source:
        'class Example { get value() { if (ready) return 1; return 0; } async check(value) { try { return value; } catch { return undefined; } } }',
      expected: [
        { name: 'value', complexity: 2 },
        { name: 'check', complexity: 2 },
      ],
    },
    {
      name: 'conditional-type.ts',
      source: 'function assertion(value) { return value as keyof N.class<A, B> extends U ? A : B; }',
      expected: [{ name: 'assertion', complexity: 1 }],
    },
  ];
  const directory = await mkdtemp(join(tmpdir(), 'complexity-report-'));
  try {
    const files = [];
    for (const sample of samples) {
      const filePath = join(directory, sample.name);
      await writeFile(filePath, sample.source, 'utf8');
      files.push(filePath);
    }
    const analyzed = await analyzeFiles(files, directory);
    for (const [index, sample] of samples.entries()) {
      const actual = analyzed[index].functions.map(({ name, complexity }) => ({ name, complexity }));
      assert.deepEqual(actual, sample.expected, sample.name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(countSourceLines('one\n'), 1);
  assert.equal(countSourceLines('one\n\ntwo\n'), 3);
  console.log('complexity self-test passed');
}

if (process.argv.includes('--self-test')) {
  await selfTest();
} else {
  const shouldWrite = process.argv.includes('--write');
  const shouldCheck = process.argv.includes('--check');
  const files = await sourceFiles(join(root, 'src'));
  files.push(...(await sourceFiles(join(root, 'scripts'))));
  const report = await format(await reportFor(files), { endOfLine: 'lf', parser: 'markdown' });

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
}
