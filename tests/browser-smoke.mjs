import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';

const root = resolve(process.env.SNOREDEX_SITE_ROOT ?? 'dist/site');
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.woff2', 'font/woff2'],
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
const directorySnapshotSource = await readFile(join(root, 'assets/directory-snapshot.js'), 'utf8');
const corruptedDirectorySnapshotSource = directorySnapshotSource.replace(
  /"displayName":"[^"]+"/u,
  '"displayName":"Corrupted directory label"',
);
assert.notEqual(
  corruptedDirectorySnapshotSource,
  directorySnapshotSource,
  'directory fixture corruption must change a digest-bound value',
);
const staleProvenanceDirectorySnapshotSource = directorySnapshotSource.replace(
  /"catalogueByteSha256":"sha256:[0-9a-f]{64}"/gu,
  `"catalogueByteSha256":"sha256:${'e'.repeat(64)}"`,
);
assert.notEqual(
  staleProvenanceDirectorySnapshotSource,
  directorySnapshotSource,
  'directory fixture provenance must change a digest-bound value',
);
const expectedCsp =
  "default-src 'none'; base-uri 'none'; form-action 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; worker-src 'none'; frame-src 'none'; font-src 'self'; media-src 'none'; manifest-src 'none'";

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
  const fontFaces = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((face) => face.family.replaceAll('"', '') === 'Nunito Sans')
      .map((face) => ({ status: face.status, weight: face.weight }))
      .sort((left, right) => left.weight.localeCompare(right.weight));
  });
  assert.deepEqual(
    fontFaces,
    [
      { status: 'loaded', weight: '400' },
      { status: 'loaded', weight: '500' },
    ],
    `${name}: self-hosted Nunito Sans faces`,
  );
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

const PRIVATE_STATE_KEY = 'snoredex-checklist.private-state';
const INVALID_QUANTITY_MESSAGE =
  'Quantity is invalid. Enter a whole number from 0 through 9999. This draft was not saved, and the previous collection value remains unchanged. Error code: EDIT_INVALID_QUANTITY';

async function collectionScenarioPage(browser, synthetic, items) {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/collection/`, { waitUntil: 'networkidle' });
  await page.evaluate(
    ({ fingerprint, records }) => {
      localStorage.setItem(
        'snoredex-checklist.private-state',
        JSON.stringify({
          schema: 'snoredex-collection-state',
          schemaVersion: '1.0.0',
          datasetId: 'snoredex-data/snorlax-current-known',
          catalogueFingerprint: fingerprint,
          items: records,
        }),
      );
    },
    { fingerprint: synthetic.fingerprint, records: items },
  );
  await page.goto(`${baseUrl}/collection/?localization=${encodeURIComponent(synthetic.localizationId)}`, {
    waitUntil: 'networkidle',
  });
  const requiredItemIds = [synthetic.itemId, synthetic.secondItemId].filter(Boolean);
  while (
    !(await Promise.all(requiredItemIds.map((itemId) => controlsForItem(page, itemId).count()))).every(
      (count) => count > 0,
    )
  ) {
    const showMore = page.locator('[data-show-more]');
    assert.equal(await showMore.count(), 1, 'target item remains reachable through progressive results');
    await showMore.click();
  }
  return page;
}

function controlsForOwnedInput(owned) {
  return owned.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " collection-controls ")]',
  );
}

function controlsForItem(page, itemId) {
  return page
    .locator(`input[name="status-${itemId}"]`)
    .first()
    .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " collection-controls ")]');
}

async function assertCollectionEditStateMachine(browser, name, synthetic) {
  const initial = {
    itemId: synthetic.itemId,
    status: 'have',
    quantityOwned: 1,
    quantityOrdered: 0,
  };

  {
    const page = await collectionScenarioPage(browser, synthetic, [initial]);
    try {
      const controls = controlsForItem(page, synthetic.itemId);
      const quantity = controls.locator('.quantity-control');
      assert.equal(await quantity.isVisible(), true, `${name}: quantities available for Have`);
      assert.equal(await quantity.getAttribute('open'), null, `${name}: quantities initially collapsed`);
      assert.match(await quantity.locator('summary').innerText(), /Owned 1 · Ordered 0/u, `${name}: quantity summary`);
      await controls.getByRole('radio', { name: 'Need' }).check();
      await quantity.waitFor({ state: 'hidden' });
      await controls.getByRole('radio', { name: 'Ordered' }).check();
      await quantity.waitFor({ state: 'visible' });
      await quantity.locator('summary').filter({ hasText: 'Owned 0 · Ordered 1' }).waitFor();
      await controls.locator('.state-feedback').filter({ hasText: 'Saved' }).waitFor();
      await quantity.locator('summary').click();
      const owned = controls.getByRole('spinbutton', { name: 'Owned' });
      const before = await page.evaluate((key) => localStorage.getItem(key), PRIVATE_STATE_KEY);
      await owned.fill('1123123123');
      await owned.blur();
      await controls.getByText(INVALID_QUANTITY_MESSAGE, { exact: true }).waitFor();
      assert.equal(await owned.getAttribute('aria-invalid'), 'true', `${name}: invalid quantity is field-attached`);
      assert.equal(await controls.locator('.state-retry').isVisible(), false, `${name}: validation has no fake retry`);
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), PRIVATE_STATE_KEY),
        before,
        `${name}: invalid quantity does not mutate storage`,
      );
      await controls.getByRole('radio', { name: 'Need' }).check();
      await quantity.waitFor({ state: 'visible' });
      await controls.getByRole('radio', { name: 'Skip' }).check();
      await quantity.waitFor({ state: 'visible' });
      assert.equal(await owned.isVisible(), true, `${name}: invalid quantity input remains reachable`);

      await owned.fill('2');
      await owned.blur();
      await controls.locator('.state-feedback').filter({ hasText: 'Saved' }).waitFor();
      assert.equal(await owned.getAttribute('aria-invalid'), null, `${name}: correction clears invalid state`);
      assert.equal(
        await page.evaluate(
          ({ key, itemId }) =>
            JSON.parse(localStorage.getItem(key) ?? '{}').items?.find((item) => item.itemId === itemId)?.quantityOwned,
          { key: PRIVATE_STATE_KEY, itemId: synthetic.itemId },
        ),
        2,
        `${name}: corrected quantity is persisted`,
      );
    } finally {
      await page.close();
    }
  }

  {
    assert.ok(synthetic.secondItemId, `${name}: localization has two trackable items`);
    const page = await collectionScenarioPage(browser, synthetic, [initial]);
    try {
      const firstControls = controlsForItem(page, synthetic.itemId);
      await firstControls.locator('.quantity-control summary').click();
      const firstOwned = firstControls.getByRole('spinbutton', { name: 'Owned' });
      const firstOrdered = firstControls.getByRole('spinbutton', { name: 'Ordered' });
      const secondControls = controlsForItem(page, synthetic.secondItemId);
      await firstOwned.fill('1123123123');
      await firstOwned.blur();
      await firstControls.getByText(INVALID_QUANTITY_MESSAGE, { exact: true }).waitFor();

      await secondControls.getByRole('radio', { name: 'Have' }).check();
      await secondControls.locator('.state-feedback').filter({ hasText: 'Saved' }).waitFor();
      assert.equal(await firstOwned.inputValue(), '1123123123', `${name}: cross-card save preserves invalid draft`);
      assert.equal(
        await firstOwned.getAttribute('aria-invalid'),
        'true',
        `${name}: cross-card save preserves validation`,
      );

      await firstControls.getByRole('radio', { name: 'Ordered' }).check();
      await page.waitForFunction(
        ({ key, itemId }) =>
          JSON.parse(localStorage.getItem(key) ?? '{}').items?.find((item) => item.itemId === itemId)?.status ===
          'ordered',
        { key: PRIVATE_STATE_KEY, itemId: synthetic.itemId },
      );
      assert.equal(
        await firstOwned.inputValue(),
        '1123123123',
        `${name}: status save preserves invalid quantity draft`,
      );
      assert.equal(await firstOrdered.inputValue(), '1', `${name}: status save refreshes the valid quantity sibling`);
      assert.equal(
        await firstControls.locator('.state-feedback').textContent(),
        INVALID_QUANTITY_MESSAGE,
        `${name}: status save leaves specific validation feedback`,
      );

      await firstOwned.fill('0');
      await firstOwned.blur();
      await firstControls.locator('.state-feedback').filter({ hasText: 'Saved' }).waitFor();
      assert.equal(
        await page.evaluate(
          ({ key, itemId }) =>
            JSON.parse(localStorage.getItem(key) ?? '{}').items?.find((item) => item.itemId === itemId)?.status,
          { key: PRIVATE_STATE_KEY, itemId: synthetic.itemId },
        ),
        'ordered',
        `${name}: correcting the invalid field preserves the selected status`,
      );
    } finally {
      await page.close();
    }
  }

  {
    const page = await collectionScenarioPage(browser, synthetic, [initial]);
    try {
      const controls = controlsForItem(page, synthetic.itemId);
      await controls.locator('.quantity-control summary').click();
      const owned = controls.getByRole('spinbutton', { name: 'Owned' });
      await page.evaluate((key) => {
        const setItem = Storage.prototype.setItem;
        globalThis.__snoredexFailNextStateWrite = true;
        Storage.prototype.setItem = function failOneCanonicalWrite(candidate, value) {
          if (candidate === key && globalThis.__snoredexFailNextStateWrite) {
            globalThis.__snoredexFailNextStateWrite = false;
            globalThis.__snoredexFailedStateWrite = true;
            throw new Error('synthetic state write failure');
          }
          return setItem.call(this, candidate, value);
        };
      }, PRIVATE_STATE_KEY);
      await controls.getByRole('radio', { name: 'Ordered' }).check();
      await page.waitForFunction(() => globalThis.__snoredexFailedStateWrite === true);
      await controls.locator('.state-feedback').filter({ hasText: 'Save failed.' }).waitFor();

      await owned.fill('1123123123');
      assert.match(await controls.locator('.state-feedback').textContent(), /Quantity is invalid.*Save failed/u);
      const retry = controls.locator('.state-retry');
      assert.equal(await retry.isVisible(), true, `${name}: validation does not erase an independent save failure`);
      await retry.click();
      await page.waitForFunction(
        ({ key, itemId }) =>
          JSON.parse(localStorage.getItem(key) ?? '{}').items?.find((item) => item.itemId === itemId)?.status ===
          'ordered',
        { key: PRIVATE_STATE_KEY, itemId: synthetic.itemId },
      );
      assert.equal(await owned.inputValue(), '1123123123', `${name}: retry preserves the invalid field draft`);
      assert.equal(await retry.isVisible(), false, `${name}: encompassing success clears the stale retry`);
    } finally {
      await page.close();
    }
  }

  {
    const page = await collectionScenarioPage(browser, synthetic, [{ ...initial, note: 'old note' }]);
    try {
      const controls = controlsForItem(page, synthetic.itemId);
      const note = controls.getByRole('textbox', { name: /Private note for/u });
      await note.fill('');
      await note.pressSequentially('  first');
      await note.press('Enter');
      await note.pressSequentially('second');
      assert.equal(await note.inputValue(), '  first\nsecond', `${name}: note composition preserves leading spaces`);
      await note.blur();
      await controls.locator('.state-feedback').filter({ hasText: 'Saved' }).waitFor();
      assert.equal(
        await page.evaluate(
          ({ key, itemId }) =>
            JSON.parse(localStorage.getItem(key) ?? '{}').items?.find((item) => item.itemId === itemId)?.note,
          { key: PRIVATE_STATE_KEY, itemId: synthetic.itemId },
        ),
        '  first\nsecond',
        `${name}: note save preserves leading spaces`,
      );
    } finally {
      await page.close();
    }
  }

  {
    const page = await collectionScenarioPage(browser, synthetic, [initial]);
    try {
      const initialControls = controlsForItem(page, synthetic.itemId);
      await initialControls.getByRole('button', { name: 'Add note' }).click();
      const note = initialControls.getByRole('textbox', { name: /Private note for/u });
      await note.fill('recovered browser draft');
      await page.waitForFunction(() =>
        Object.keys(localStorage).some(
          (key) =>
            key.startsWith('snoredex-checklist.private-state.note-draft:') &&
            localStorage.getItem(key)?.includes('recovered browser draft'),
        ),
      );
      await page.reload({ waitUntil: 'networkidle' });
      while ((await page.locator(`[data-item-id="${synthetic.itemId}"]`).count()) === 0) {
        await page.locator('[data-show-more]').click();
      }

      await page.getByRole('heading', { name: 'Recovered unsaved collection changes' }).waitFor();
      assert.equal(
        await page.getByRole('spinbutton', { name: 'Owned' }).count(),
        0,
        `${name}: unresolved recovery withholds quantity controls`,
      );
      assert.equal(
        await page.getByRole('radio', { name: 'Have' }).count(),
        0,
        `${name}: unresolved recovery withholds status controls`,
      );

      await page.getByRole('button', { name: 'Adopt recovered changes' }).click();
      await page.getByRole('heading', { name: 'Recovered unsaved collection changes' }).waitFor({ state: 'detached' });
      const controls = controlsForItem(page, synthetic.itemId);
      await controls.locator('.quantity-control summary').click();
      const owned = controls.getByRole('spinbutton', { name: 'Owned' });
      assert.equal(await owned.isEnabled(), true, `${name}: successful adoption re-enables collection edits`);
      assert.equal(
        await page.evaluate(
          ({ key, itemId }) =>
            JSON.parse(localStorage.getItem(key) ?? '{}').items?.find((item) => item.itemId === itemId)?.note,
          { key: PRIVATE_STATE_KEY, itemId: synthetic.itemId },
        ),
        'recovered browser draft',
        `${name}: adoption commits the recovered draft`,
      );
    } finally {
      await page.close();
    }
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
      const requestedPaths = [];
      page.on('pageerror', (error) => failures.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') failures.push(message.text());
      });
      page.on('request', (request) => {
        requestedPaths.push(new URL(request.url()).pathname);
        if (!request.url().startsWith(baseUrl)) unexpectedRequests.push(request.url());
      });
      const home = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      assert.equal(home?.status(), 200, `${name}: home status`);
      assert.equal(await page.title(), 'Snoredex Checklist', `${name}: home title`);
      assert.equal(await page.locator("a[href='collection/']").count(), 2, `${name}: collection links`);
      await page.locator('.localization-group').first().waitFor();
      assert.match(
        await page.locator('.proof-list').innerText(),
        /Per-item statuses, quantities, and notes stay local; selected filter criteria are shareable/u,
        `${name}: public status criterion is distinguished from private records`,
      );
      assert.match(
        await page.locator('.provenance-disclosure > summary').innerText(),
        /^Catalogue (?:verified|fixture) · Data as of /u,
        `${name}: human catalogue summary`,
      );
      await assertSecurityBoundary(page, `${name}/home`);
      assert.equal(
        requestedPaths.some((path) => path.endsWith('/snapshot.js') || path.endsWith('/migrations.js')),
        false,
        `${name}: home omits full catalogue payloads`,
      );
      const rollbackPage = await browser.newPage();
      const rollbackRequests = [];
      rollbackPage.on('request', (request) => rollbackRequests.push(new URL(request.url()).pathname));
      await rollbackPage.route('**/assets/directory.js', (route) => route.abort());
      await rollbackPage.route('**/assets/directory-snapshot.js', (route) => route.abort());
      const rollbackHome = await rollbackPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      assert.equal(rollbackHome?.status(), 200, `${name}: rollback fallback home status`);
      await rollbackPage.locator('.localization-group').first().waitFor();
      assert.equal(
        rollbackRequests.some((path) => path.endsWith('/snapshot.js')),
        true,
        `${name}: rollback fallback uses the compatible full snapshot`,
      );
      await rollbackPage.close();
      const staleValidatorPage = await browser.newPage();
      const staleValidatorRequests = [];
      staleValidatorPage.on('request', (request) => staleValidatorRequests.push(new URL(request.url()).pathname));
      await staleValidatorPage.route('**/assets/directory.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript; charset=utf-8',
          body: 'export async function validateDirectorySnapshot() { return true; }',
        }),
      );
      await staleValidatorPage.route('**/assets/directory-snapshot.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript; charset=utf-8',
          body: corruptedDirectorySnapshotSource,
        }),
      );
      const staleValidatorHome = await staleValidatorPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      assert.equal(staleValidatorHome?.status(), 200, `${name}: stale validator home status`);
      assert.equal(
        await staleValidatorPage.locator('[data-view] h2').textContent(),
        'Invalid checklist link',
        `${name}: stable entry point rejects digest mismatch despite a permissive cached validator`,
      );
      assert.equal(
        staleValidatorRequests.some((path) => path.endsWith('/snapshot.js')),
        false,
        `${name}: digest mismatch fails closed instead of accepting or falling back`,
      );
      await staleValidatorPage.close();
      const staleProvenancePage = await browser.newPage();
      const staleProvenanceRequests = [];
      staleProvenancePage.on('request', (request) => staleProvenanceRequests.push(new URL(request.url()).pathname));
      await staleProvenancePage.route('**/assets/directory-snapshot.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript; charset=utf-8',
          body: staleProvenanceDirectorySnapshotSource,
        }),
      );
      const staleProvenanceHome = await staleProvenancePage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      assert.equal(staleProvenanceHome?.status(), 200, `${name}: stale provenance home status`);
      assert.equal(
        await staleProvenancePage.locator('[data-view] h2').textContent(),
        'Invalid checklist link',
        `${name}: directory envelope rejects internally consistent stale provenance`,
      );
      assert.equal(
        staleProvenanceRequests.some((path) => path.endsWith('/snapshot.js')),
        false,
        `${name}: stale provenance fails closed instead of accepting or falling back`,
      );
      await staleProvenancePage.close();
      await page.locator("a[href='collection/']").first().click();
      await page.waitForLoadState('networkidle');
      assert.match(page.url(), /\/collection\/$/u, `${name}: collection URL`);
      assert.equal(await page.title(), 'Collection · Snoredex Checklist', `${name}: collection title`);
      assert.equal(
        requestedPaths.some((path) => path.endsWith('/snapshot.js')),
        true,
        `${name}: collection loads full catalogue`,
      );
      assert.equal(
        requestedPaths.some((path) => path.endsWith('/migrations.js')),
        true,
        `${name}: collection loads migrations`,
      );
      await assertSecurityBoundary(page, `${name}/collection`);
      assert.equal(await page.locator('.query-primary input[name="q"]').isVisible(), true, `${name}: primary search`);
      assert.equal(
        await page.locator('.query-advanced').getAttribute('open'),
        null,
        `${name}: advanced filters closed`,
      );
      assert.equal(await page.locator('[data-view] > .empty-state').count(), 1, `${name}: neutral initial state`);
      assert.equal(await page.locator('[data-view]').getAttribute('aria-live'), null, `${name}: results are not live`);
      assert.equal(
        await page.locator('[data-view-status]').getAttribute('role'),
        'status',
        `${name}: scoped view status`,
      );
      assert.match(
        await page.locator('[data-view-status]').textContent(),
        /Collection ready/u,
        `${name}: concise neutral announcement`,
      );
      assert.equal(await page.locator('.state-retry:visible').count(), 0, `${name}: no idle retry controls`);
      assert.match(
        await page.locator('.provenance-disclosure > summary').innerText(),
        /^Catalogue (?:verified|fixture) · Data as of /u,
        `${name}: collection catalogue summary`,
      );
      assert.equal(
        await page.getByText('Backup and recovery', { exact: true }).count(),
        1,
        `${name}: recovery disclosure`,
      );
      await page.getByText('Backup and recovery', { exact: true }).click();
      assert.equal(
        await page.getByRole('button', { name: 'Choose backup to preview' }).count(),
        1,
        `${name}: import entry point`,
      );
      assert.equal(
        await page.getByRole('button', { name: 'Clear collection' }).count(),
        1,
        `${name}: clear entry point`,
      );
      const synthetic = await page.evaluate(async () => {
        const module = await import('/assets/snapshot.js');
        const catalogue = module.default;
        const trackable = catalogue.items.filter(
          (candidate) => candidate.active && candidate.progressClass === 'current-known',
        );
        const item =
          trackable.find(
            (candidate) => trackable.filter((other) => other.localizationId === candidate.localizationId).length > 1,
          ) ?? trackable[0];
        if (!item) return null;
        return {
          fingerprint: catalogue.meta.catalogueFingerprint,
          itemId: item.itemId,
          localizationId: item.localizationId,
          localizationItemCount: catalogue.items.filter(
            (candidate) => candidate.active && candidate.localizationId === item.localizationId,
          ).length,
          secondItemId: trackable.find(
            (candidate) => candidate.localizationId === item.localizationId && candidate.itemId !== item.itemId,
          )?.itemId,
          research: catalogue.items.find(
            (candidate) =>
              candidate.active &&
              candidate.progressClass === 'research' &&
              candidate.setEditionId &&
              !candidate.localSetCode &&
              !candidate.localSetName,
          ),
        };
      });
      assert.notEqual(synthetic, null, `${name}: synthetic trackable item`);
      if (synthetic !== null) {
        await page.evaluate(({ fingerprint, itemId }) => {
          localStorage.setItem(
            'snoredex-checklist.private-state',
            JSON.stringify({
              schema: 'snoredex-collection-state',
              schemaVersion: '1.0.0',
              datasetId: 'snoredex-data/snorlax-current-known',
              catalogueFingerprint: fingerprint,
              items: [
                { itemId, status: 'have', quantityOwned: 1, quantityOrdered: 0, note: 'synthetic browser smoke' },
              ],
            }),
          );
        }, synthetic);
        await page.goto(`${baseUrl}/collection/?localization=${encodeURIComponent(synthetic.localizationId)}`, {
          waitUntil: 'networkidle',
        });
        assert.equal(
          await page.locator('[data-view] [data-item-id]').count(),
          Math.min(24, synthetic.localizationItemCount),
          `${name}: initial result chunk`,
        );
        if (synthetic.localizationItemCount > 24) {
          const showMore = page.locator('[data-show-more]');
          assert.equal(await showMore.count(), 1, `${name}: progressive result control`);
          await showMore.click();
          assert.equal(
            await page.locator('[data-view] [data-item-id]').count(),
            Math.min(48, synthetic.localizationItemCount),
            `${name}: second result chunk`,
          );
          assert.equal(
            await page.evaluate(() => document.activeElement?.matches('[data-show-more], [data-results-progress]')),
            true,
            `${name}: progressive result focus`,
          );
          while ((await showMore.count()) > 0) await showMore.click();
          assert.equal(
            await page.locator('[data-view] [data-item-id]').count(),
            synthetic.localizationItemCount,
            `${name}: complete progressive results`,
          );
          assert.equal(
            await page.evaluate(() => document.activeElement?.matches('[data-results-progress]')),
            true,
            `${name}: final progressive result focus`,
          );
          assert.match(
            await page.locator('[data-results-progress]').innerText(),
            new RegExp(`Showing all ${synthetic.localizationItemCount} matching catalogue items\\.`, 'u'),
            `${name}: final progressive result summary`,
          );
        }
        await page.reload({ waitUntil: 'networkidle' });
        await page.getByText('Backup and recovery', { exact: true }).click();
        const exportButton = page.getByRole('button', { name: 'Export collection' });
        assert.equal(await exportButton.isEnabled(), true, `${name}: export enabled for synthetic state`);
        const downloadPromise = page.waitForEvent('download');
        await exportButton.click();
        const download = await downloadPromise;
        const stream = await download.createReadStream();
        assert.ok(stream, `${name}: backup download stream`);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const backup = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.equal(backup.catalogueFingerprint, synthetic.fingerprint, `${name}: exported fingerprint`);
        const beforeImport = await page.evaluate(() => localStorage.getItem('snoredex-checklist.private-state'));
        await page.locator('input[type="file"]').setInputFiles({
          name: 'synthetic.snoredex-private.json',
          mimeType: 'application/json',
          buffer: Buffer.from(JSON.stringify(backup), 'utf8'),
        });
        await page.getByRole('heading', { name: /^(?:Import|Replace) preview$/u }).waitFor();
        assert.equal(await page.getByText('Records in backup').count(), 1, `${name}: import preview aggregates`);
        assert.equal(
          await page.evaluate(() => localStorage.getItem('snoredex-checklist.private-state')),
          beforeImport,
          `${name}: preview is mutation-free`,
        );
        await page.locator('input[type="file"]').setInputFiles({
          name: 'invalid.json',
          mimeType: 'application/json',
          buffer: Buffer.from('{"schema":', 'utf8'),
        });
        await page
          .locator('[data-recovery-status]')
          .filter({ hasText: 'The selected file is not valid JSON.' })
          .waitFor();
        assert.equal(
          await page.getByRole('heading', { name: /^(?:Import|Replace) preview$/u }).count(),
          0,
          `${name}: invalid import clears preview`,
        );
        await page.locator('input[type="file"]').setInputFiles({
          name: 'oversized.json',
          mimeType: 'application/json',
          buffer: Buffer.alloc(16 * 1024 * 1024 + 1),
        });
        await page
          .locator('[data-recovery-status]')
          .filter({ hasText: 'The selected file is larger than the 16 MiB safety limit.' })
          .waitFor();
        assert.equal(
          await page.getByRole('heading', { name: /^(?:Import|Replace) preview$/u }).count(),
          0,
          `${name}: oversized import clears preview`,
        );
        await page.getByRole('button', { name: 'Clear collection' }).click();
        const confirmation = page.getByRole('dialog', { name: 'Clear collection?' });
        await confirmation.waitFor();
        assert.equal(
          await confirmation.getByRole('heading', { name: 'Clear collection?' }).count(),
          1,
          `${name}: confirmation name`,
        );
        await confirmation.getByRole('button', { name: 'Cancel' }).click();
        await assertCollectionEditStateMachine(browser, name, synthetic);
        assert.notEqual(synthetic.research, undefined, `${name}: synthetic research item`);
        if (synthetic.research?.setEditionId) {
          await page.goto(
            `${baseUrl}/collection/?localization=${encodeURIComponent(synthetic.research.localizationId)}&edition=${encodeURIComponent(synthetic.research.setEditionId)}`,
            { waitUntil: 'networkidle' },
          );
          assert.equal(await page.getByRole('combobox', { name: 'Set' }).count(), 1, `${name}: compact set picker`);
          assert.equal(
            await page.getByRole('navigation', { name: 'Localities, sets and editions' }).count(),
            0,
            `${name}: full catalogue tree removed`,
          );
          assert.equal(
            await page.getByRole('heading', { name: 'Research-only view' }).count(),
            1,
            `${name}: research-only explanation`,
          );
          assert.equal(await page.getByRole('progressbar').count(), 0, `${name}: no zero-total progressbar`);
          assert.equal(await page.getByRole('radio').count(), 0, `${name}: research remains read-only`);
          const visibleText = await page.locator('main').innerText();
          assert.doesNotMatch(visibleText, /(?:LOCALSET|EDITION):/u, `${name}: opaque IDs stay out of visible UI`);
          assert.match(visibleText, /Unidentified set/u, `${name}: neutral unresolved label`);

          await page.goto(`${baseUrl}/collection/?edition=${encodeURIComponent(synthetic.research.setEditionId)}`, {
            waitUntil: 'networkidle',
          });
          const recoveryLink = page.getByRole('link', { name: 'Show trackable items in this localization' });
          assert.equal(await recoveryLink.count(), 1, `${name}: edition-only recovery stays in localization`);
          const recoveryHref = await recoveryLink.getAttribute('href');
          assert.notEqual(recoveryHref, null, `${name}: edition-only recovery link target`);
          const recoveryUrl = new URL(recoveryHref, page.url());
          assert.equal(
            recoveryUrl.searchParams.get('localization'),
            synthetic.research.localizationId,
            `${name}: edition-only recovery preserves localization`,
          );
          assert.equal(recoveryUrl.searchParams.get('research'), 'false', `${name}: recovery excludes research`);
        }
      }
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
