import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium, firefox, webkit } from '@playwright/test';

import { PRIVATE_STATE_LOCK_NAME } from '../src/state/storage.ts';

const root = resolve(process.env.SNOREDEX_SITE_ROOT ?? 'dist/site');
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
        const item = catalogue.items.find(
          (candidate) => candidate.active && candidate.progressClass === 'current-known',
        );
        if (!item) return null;
        return {
          fingerprint: catalogue.meta.catalogueFingerprint,
          itemId: item.itemId,
          localizationId: item.localizationId,
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
        await page.goto(`${baseUrl}/collection/?localization=${encodeURIComponent(synthetic.localizationId)}`, {
          waitUntil: 'networkidle',
        });
        const ownedQuantity = page.getByRole('spinbutton', { name: 'Owned' }).first();
        const collectionControls = ownedQuantity.locator(
          'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " collection-controls ")]',
        );
        const quantityFeedback = collectionControls.locator('.state-feedback');
        const privateNote = collectionControls.getByRole('textbox', { name: /^Private note for /u });
        const invalidQuantityMessage =
          'Quantity is invalid. Enter a whole number from 0 through 9999. This draft was not saved, and the previous collection value remains unchanged. Error code: EDIT_INVALID_QUANTITY';
        const saveFailedMessage = 'Save failed. Your draft is still visible; retry when ready.';
        const beforeInvalidQuantity = await page.evaluate(() =>
          localStorage.getItem('snoredex-checklist.private-state'),
        );
        await ownedQuantity.fill('10000');
        await ownedQuantity.blur();
        await page.getByText(invalidQuantityMessage, { exact: true }).waitFor();
        assert.equal(await ownedQuantity.getAttribute('aria-invalid'), 'true', `${name}: invalid quantity marked`);
        assert.equal(await page.locator('.state-retry:visible').count(), 0, `${name}: invalid input has no retry`);
        assert.equal(
          await page.evaluate(() => localStorage.getItem('snoredex-checklist.private-state')),
          beforeInvalidQuantity,
          `${name}: invalid quantity leaves storage unchanged`,
        );
        await page.evaluate(async (lockName) => {
          let lockAcquired;
          const acquired = new Promise((resolve) => {
            lockAcquired = resolve;
          });
          void navigator.locks.request(lockName, async () => {
            await new Promise((resolve) => {
              globalThis.__snoredexReleaseNoteLock = resolve;
              lockAcquired();
            });
          });
          await acquired;
        }, PRIVATE_STATE_LOCK_NAME);
        await privateNote.fill('synthetic pending note save');
        assert.equal(await ownedQuantity.inputValue(), '1', `${name}: controller reset restores persisted quantity`);
        assert.equal(
          await ownedQuantity.getAttribute('aria-invalid'),
          null,
          `${name}: controller reset clears stale invalid state`,
        );
        await ownedQuantity.fill('10000');
        await ownedQuantity.blur();
        await page.getByText(invalidQuantityMessage, { exact: true }).waitFor();
        await page.evaluate(() => globalThis.__snoredexReleaseNoteLock?.());
        await page.waitForFunction(
          (previous) => localStorage.getItem('snoredex-checklist.private-state') !== previous,
          beforeInvalidQuantity,
        );
        assert.equal(
          await quantityFeedback.textContent(),
          invalidQuantityMessage,
          `${name}: invalid feedback survives older note save completion`,
        );
        await page.evaluate(async (lockName) => {
          let lockAcquired;
          const acquired = new Promise((resolve) => {
            lockAcquired = resolve;
          });
          void navigator.locks.request(lockName, async () => {
            await new Promise((resolve) => {
              globalThis.__snoredexReleaseFailedNoteLock = resolve;
              lockAcquired();
            });
          });
          await acquired;
        }, PRIVATE_STATE_LOCK_NAME);
        await page.evaluate(() => {
          const setItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function failNextStateWrite(key, value) {
            if (key === 'snoredex-checklist.private-state') {
              Storage.prototype.setItem = setItem;
              globalThis.__snoredexFailedStateWrite = true;
              throw new Error('synthetic state write failure');
            }
            return setItem.call(this, key, value);
          };
        });
        await privateNote.fill('synthetic failed note save');
        await ownedQuantity.fill('10000');
        await ownedQuantity.blur();
        await page.getByText(invalidQuantityMessage, { exact: true }).waitFor();
        await page.evaluate(() => globalThis.__snoredexReleaseFailedNoteLock?.());
        await page.waitForFunction(() => globalThis.__snoredexFailedStateWrite === true);
        assert.equal(
          await quantityFeedback.textContent(),
          invalidQuantityMessage,
          `${name}: quantity feedback remains primary while note save fails`,
        );
        await ownedQuantity.fill('1');
        await page.getByText(saveFailedMessage, { exact: true }).waitFor();
        const retrySave = collectionControls.getByRole('button', { name: 'Retry save' });
        assert.equal(
          await retrySave.isVisible(),
          true,
          `${name}: failed note save becomes recoverable after quantity correction`,
        );
        assert.equal(
          await ownedQuantity.evaluate((input) => document.activeElement === input),
          true,
          `${name}: quantity remains focused before programmatic retry`,
        );
        await retrySave.evaluate((button) => button.click());
        await page.getByText('Saved', { exact: true }).first().waitFor();
        assert.equal(
          await ownedQuantity.evaluate((input) => document.activeElement === input),
          true,
          `${name}: retry succeeds without quantity blur or change`,
        );
        await page.evaluate(async (lockName) => {
          let lockAcquired;
          const acquired = new Promise((resolve) => {
            lockAcquired = resolve;
          });
          void navigator.locks.request(lockName, async () => {
            await new Promise((resolve) => {
              globalThis.__snoredexReleaseQuantityLock = resolve;
              lockAcquired();
            });
          });
          await acquired;
        }, PRIVATE_STATE_LOCK_NAME);
        await ownedQuantity.fill('2');
        await ownedQuantity.blur();
        await page.getByText('Saving…', { exact: true }).first().waitFor();
        await ownedQuantity.fill('10000');
        await ownedQuantity.blur();
        await page.getByText(invalidQuantityMessage, { exact: true }).waitFor();
        await page.evaluate(() => globalThis.__snoredexReleaseQuantityLock?.());
        await page.waitForFunction(
          (previous) => localStorage.getItem('snoredex-checklist.private-state') !== previous,
          beforeInvalidQuantity,
        );
        assert.equal(
          await quantityFeedback.textContent(),
          invalidQuantityMessage,
          `${name}: newer invalid feedback survives older save completion`,
        );
        await ownedQuantity.fill('3');
        await ownedQuantity.blur();
        await page.getByText('Saved', { exact: true }).first().waitFor();
        assert.equal(await ownedQuantity.getAttribute('aria-invalid'), null, `${name}: corrected quantity is valid`);
        assert.notEqual(
          await page.evaluate(() => localStorage.getItem('snoredex-checklist.private-state')),
          beforeInvalidQuantity,
          `${name}: corrected quantity saves`,
        );
        const secondOwnedQuantity = page.getByRole('spinbutton', { name: 'Owned' }).nth(1);
        assert.equal(await secondOwnedQuantity.count(), 1, `${name}: second trackable card for overlapping saves`);
        const secondCollectionControls = secondOwnedQuantity.locator(
          'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " collection-controls ")]',
        );
        const secondQuantityFeedback = secondCollectionControls.locator('.state-feedback');
        await page.evaluate(async (lockName) => {
          let lockAcquired;
          const acquired = new Promise((resolve) => {
            lockAcquired = resolve;
          });
          void navigator.locks.request(lockName, async () => {
            await new Promise((resolve) => {
              globalThis.__snoredexReleaseOverlappingLock = resolve;
              lockAcquired();
            });
          });
          await acquired;
        }, PRIVATE_STATE_LOCK_NAME);
        await page.evaluate(() => {
          const setItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function failOverlappingStateWrite(key, value) {
            if (key === 'snoredex-checklist.private-state') {
              Storage.prototype.setItem = setItem;
              globalThis.__snoredexFailedOverlappingWrite = true;
              throw new Error('synthetic overlapping state write failure');
            }
            return setItem.call(this, key, value);
          };
        });
        await ownedQuantity.fill('4');
        await ownedQuantity.blur();
        await quantityFeedback.filter({ hasText: 'Saving…' }).waitFor();
        await secondOwnedQuantity.fill('2');
        await secondOwnedQuantity.blur();
        await secondQuantityFeedback.filter({ hasText: 'Saving…' }).waitFor();
        await ownedQuantity.fill('10000');
        await ownedQuantity.blur();
        await quantityFeedback.filter({ hasText: invalidQuantityMessage }).waitFor();
        await page.evaluate(() => globalThis.__snoredexReleaseOverlappingLock?.());
        await page.waitForFunction(() => globalThis.__snoredexFailedOverlappingWrite === true);
        await ownedQuantity.fill('4');
        await quantityFeedback.filter({ hasText: saveFailedMessage }).waitFor();
        const overlappingRetry = collectionControls.getByRole('button', { name: 'Retry save' });
        assert.equal(await overlappingRetry.isVisible(), true, `${name}: overlapping failure exposes retry`);
        await overlappingRetry.evaluate((button) => button.click());
        await quantityFeedback.filter({ hasText: 'Saved' }).waitFor();
        assert.equal(
          await ownedQuantity.evaluate((input) => document.activeElement === input),
          true,
          `${name}: overlapping immediate retry succeeds without quantity change`,
        );
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
