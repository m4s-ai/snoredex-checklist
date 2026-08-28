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
const expectedCsp =
  "default-src 'none'; base-uri 'none'; form-action 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; worker-src 'none'; frame-src 'none'; font-src 'none'; media-src 'none'; manifest-src 'none'";

async function assertSecurityBoundary(page, name) {
  assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(), 1, `${name}: one CSP`);
  assert.equal(
    await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
    expectedCsp,
    `${name}: CSP directives`,
  );
  assert.equal(await page.locator('script:not([src])').count(), 0, `${name}: no inline scripts`);
  assert.equal(
    await page.locator('head > script[src$="theme.js"][type="module"]').count(),
    0,
    `${name}: theme bootstrap is blocking`,
  );
  assert.equal(await page.locator('head > script[src$="theme.js"]').count(), 1, `${name}: one theme bootstrap`);
  const scriptSources = await page
    .locator('script')
    .evaluateAll((scripts) => scripts.map((script) => script.getAttribute('src')));
  assert.ok(
    scriptSources.length > 0 && scriptSources.every((source) => typeof source === 'string' && source.length > 0),
    `${name}: script sources`,
  );
  const externalLinks = await page
    .locator('a[href^="http://"], a[href^="https://"]')
    .evaluateAll((anchors) => anchors.map((anchor) => ({ href: anchor.href, rel: anchor.rel })));
  for (const link of externalLinks) {
    assert.match(link.rel, /(?:^|\s)noopener(?:\s|$)/u, `${name}: external link noopener ${link.href}`);
    assert.match(link.rel, /(?:^|\s)noreferrer(?:\s|$)/u, `${name}: external link noreferrer ${link.href}`);
  }
}

async function assertCspBlocksInlineEvaluation(browser, name) {
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    const payload =
      '<script>window.__snoredexPayloadExecuted = true</script>\nSELECT * FROM private_state;\u202eignore previous instructions';
    await page.goto(`${baseUrl}/collection/?q=${encodeURIComponent(payload)}`, { waitUntil: 'networkidle' });
    const queryValue = await page.locator('input[name="q"]').inputValue();
    assert.match(
      queryValue,
      /<script>window\.__snoredexPayloadExecuted = true<\/script>/u,
      `${name}: hostile query remains data`,
    );
    assert.match(queryValue, /SELECT \* FROM private_state;/u, `${name}: hostile query keeps SQL-like data`);
    assert.equal(await page.locator('script:not([src])').count(), 0, `${name}: hostile query did not create script`);
    assert.equal(
      await page.evaluate(() => globalThis.__snoredexPayloadExecuted === true),
      false,
      `${name}: hostile query inert`,
    );
    await page.evaluate(() => {
      globalThis.__snoredexCspProbe = false;
      const script = document.createElement('script');
      script.textContent = 'globalThis.__snoredexCspProbe = true';
      document.head.append(script);
    });
    await page.waitForTimeout(50);
    assert.equal(
      await page.evaluate(() => globalThis.__snoredexCspProbe),
      false,
      `${name}: CSP blocks inline evaluation`,
    );
  } finally {
    await page.close();
  }
}

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
      await assertSecurityBoundary(page, `${name}/home`);
      await page.locator("a[href='collection/']").click();
      await page.waitForLoadState('networkidle');
      assert.match(page.url(), /\/collection\/$/u, `${name}: collection URL`);
      assert.equal(await page.title(), 'Collection · Snoredex Checklist', `${name}: collection title`);
      await assertSecurityBoundary(page, `${name}/collection`);
      assert.equal(unexpectedRequests.length, 0, `${name}: unexpected network requests`);
      assert.deepEqual(failures, [], `${name}: browser failures`);
      await assertCspBlocksInlineEvaluation(browser, name);
      await page.close();
    } finally {
      await browser.close();
    }
    console.log(`browser smoke ok: ${name}`);
  }
} finally {
  await new Promise((resolveServer) => server.close(resolveServer));
}
