import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind } from 'typescript/unstable/ast';

// Measure actual cold-route requests; gzip totals sum each response independently.
// Run against a previously built artifact to compare revisions without rebuilding it.
const root = resolve(process.argv[2] ?? 'dist/site');
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(root, `.${pathname}${pathname.endsWith('/') ? 'index.html' : ''}`);
    assert.ok(file.startsWith(`${root}${sep}`));
    response
      .writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' })
      .end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const api = new API({ cwd: process.cwd() });
try {
  browser = await chromium.launch();
  const moduleManifest = JSON.parse(await readFile(resolve(root, 'assets/module-manifest.json'), 'utf8'));
  const runtime = moduleManifest.runtimeAssetSet.path;
  const manifest = JSON.parse(await readFile(resolve(root, 'assets', runtime, 'manifest.json'), 'utf8'));
  const report = { runtime: manifest.runtime, manifestMembers: manifest.modules.map(({ path }) => path), routes: {} };
  for (const route of ['/', '/collection/']) {
    const page = await browser.newPage();
    const paths = new Set();
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('request', (request) => paths.add(new URL(request.url()).pathname));
    page.on('response', (response) => {
      if (!response.ok()) failures.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(`${origin}${route}`, { waitUntil: 'networkidle' });
    await page
      .locator(route === '/' ? '.localization-group' : '.query-primary')
      .first()
      .waitFor();
    assert.deepEqual(failures, []);
    const files = await Promise.all(
      [...paths].sort().map(async (path) => {
        const file = resolve(root, `.${path}${path.endsWith('/') ? 'index.html' : ''}`);
        const bytes = await readFile(file);
        return {
          path: path.replace(`/assets/${runtime}/`, '/assets/runtime/'),
          raw: bytes.length,
          gzip: gzipSync(bytes).length,
          file,
        };
      }),
    );
    const modules = files.filter(({ file }) => file.endsWith('.js'));
    const snapshot = api.updateSnapshot({ openFiles: modules.map(({ file }) => file) });
    const graph = {};
    try {
      for (const { path, file } of modules) {
        const project = snapshot.getDefaultProjectForFile(file);
        const source = project?.program.getSourceFile(file);
        assert.ok(source && project.program.getSyntacticDiagnostics(file).length === 0);
        const dependencies = [];
        const visit = (node) => {
          if (
            (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.ExportDeclaration) &&
            node.moduleSpecifier
          ) {
            dependencies.push({ kind: 'static', target: node.moduleSpecifier.text });
          } else if (node.kind === SyntaxKind.CallExpression && node.expression.kind === SyntaxKind.ImportKeyword) {
            assert.ok(
              [SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral].includes(node.arguments[0]?.kind),
            );
            dependencies.push({ kind: 'dynamic', target: node.arguments[0].text });
          }
          node.forEachChild(visit);
        };
        visit(source);
        graph[path] = dependencies;
      }
    } finally {
      snapshot.dispose();
    }
    const totals = (rows) => ({
      raw: rows.reduce((sum, row) => sum + row.raw, 0),
      gzip: rows.reduce((sum, row) => sum + row.gzip, 0),
    });
    report.routes[route] = {
      total: totals(files),
      javascript: totals(modules),
      files: files.map(({ file, ...row }) => row),
      graph,
    };
    await page.close();
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  api.close();
  await browser?.close();
  await new Promise((done) => server.close(done));
}
