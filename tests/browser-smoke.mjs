import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';

const root = resolve(process.cwd(), 'dist/site');
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(requestUrl.pathname);
    const relativePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const file = resolve(root, `.${relativePath}`);
    if (file !== root && !file.startsWith(`${root}${normalize('/')}`)) {
      response.writeHead(400).end('bad path');
      return;
    }
    const bytes = await readFile(file);
    response.writeHead(200, { 'content-type': mimeTypes.get(extname(file)) ?? 'application/octet-stream' }).end(bytes);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('BROWSER_SMOKE_SERVER_UNAVAILABLE');
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  for (const [name, engine] of [
    ['chromium', chromium],
    ['firefox', firefox],
    ['webkit', webkit],
  ]) {
    let browser;
    try {
      browser = await engine.launch({ headless: true });
    } catch (error) {
      throw new Error(`BROWSER_${name.toUpperCase()}_INSTALL_MISSING: run npx playwright install ${name}`, {
        cause: error,
      });
    }
    try {
      const page = await browser.newPage();
      const failures = [];
      const unexpectedRequests = [];
      page.on('pageerror', (error) => failures.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') failures.push(message.text());
      });
      page.on('request', (request) => {
        if (!request.url().startsWith(baseUrl)) unexpectedRequests.push(request.url());
      });
      const home = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      assert.equal(home?.status(), 200, `${name}: home status`);
      assert.equal(await page.title(), 'Snoredex Checklist', `${name}: home title`);
      assert.equal(await page.locator("a[href='collection/']").count(), 1, `${name}: collection link`);
      await page.locator("a[href='collection/']").click();
      await page.waitForLoadState('networkidle');
      assert.match(page.url(), /\/collection\/$/u, `${name}: collection URL`);
      assert.equal(await page.title(), 'Collection · Snoredex Checklist', `${name}: collection title`);
      assert.equal(unexpectedRequests.length, 0, `${name}: unexpected network requests`);
      assert.deepEqual(failures, [], `${name}: browser failures`);
      await page.close();
    } finally {
      await browser.close();
    }
    console.log(`browser smoke ok: ${name}`);
  }
} finally {
  await new Promise((resolveServer) => server.close(resolveServer));
}
