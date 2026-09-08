import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';

import { runtimeShellBindings, sha256 } from '../scripts/runtime-assets.mjs';

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
const snapshotSource = await readFile(join(root, 'assets/snapshot.js'), 'utf8');
const migrationsSource = await readFile(join(root, 'assets/migrations.js'), 'utf8');
const moduleManifest = JSON.parse(await readFile(join(root, 'assets/module-manifest.json'), 'utf8'));
const runtimeManifest = JSON.parse(
  await readFile(join(root, 'assets', moduleManifest.runtimeAssetSet.path, 'manifest.json'), 'utf8'),
);
const homeBindings = runtimeShellBindings(runtimeManifest, `assets/${moduleManifest.runtimeAssetSet.path}/`);
const collectionBindings = runtimeShellBindings(runtimeManifest, `../assets/${moduleManifest.runtimeAssetSet.path}/`);

// A second complete runtime generation, with independently bound module bytes and
// the same catalogue identity. Serve it in memory like a retained deployment.
async function retainedRuntimeFixture() {
  const revision = runtimeManifest.runtime.appRevision === 'f'.repeat(40) ? 'e'.repeat(40) : 'f'.repeat(40);
  const directory = await import(pathToFileURL(join(root, 'assets/directory-snapshot.js')));
  const { directoryEnvelopeDigest } = await import(pathToFileURL(join(root, 'assets/directory.js')));
  const digest = await directoryEnvelopeDigest(directory.default, { ...directory.provenance, appRevision: revision });
  const modules = new Map(
    await Promise.all(
      runtimeManifest.modules.map(async ({ path }) => [
        path,
        (await readFile(join(root, 'assets', moduleManifest.runtimeAssetSet.path, path), 'utf8')).replaceAll(
          runtimeManifest.runtime.appRevision,
          revision,
        ),
      ]),
    ),
  );
  const manifest = {
    ...runtimeManifest,
    runtime: { ...runtimeManifest.runtime, appRevision: revision },
    modules: [...modules].map(([path, source]) => ({
      path,
      byteLength: Buffer.byteLength(source),
      sha256: sha256(Buffer.from(source)),
    })),
  };
  const runtimePath = `assets/${moduleManifest.runtimeAssetSet.path.replace(runtimeManifest.runtime.appRevision, revision)}/`;
  const shells = new Map();
  for (const [route, file, original, prefix] of [
    ['/', 'index.html', homeBindings, runtimePath],
    ['/collection/', 'collection/index.html', collectionBindings, `../${runtimePath}`],
  ]) {
    const bindings = runtimeShellBindings(manifest, prefix);
    shells.set(
      route,
      (await readFile(join(root, file), 'utf8'))
        .replace(original.importMap, bindings.importMap)
        .replaceAll(original.importMapCsp, bindings.importMapCsp)
        .replaceAll(original.appIntegrity, bindings.appIntegrity)
        .replaceAll(original.themeIntegrity, bindings.themeIntegrity)
        .replaceAll(runtimeManifest.runtime.appRevision, revision)
        .replace(/(name="snoredex-directory-sha256" content=")[^"]+/u, `$1${digest}`),
    );
  }
  return { modules, shells, runtimePath };
}
const retainedRuntime = await retainedRuntimeFixture();

async function probePrivateAccess(page) {
  await page.addInitScript(() => {
    window.privateAccesses = 0;
    for (const method of ['getItem', 'setItem', 'removeItem']) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (key, ...args) {
        if (String(key).startsWith('snoredex-checklist.private-state')) window.privateAccesses++;
        return original.call(this, key, ...args);
      };
    }
  });
}

async function assertRetainedRoutes(browser, name) {
  const page = await browser.newPage();
  try {
    let retainedShell = false;
    const requests = [];
    page.on('request', (request) => requests.push(new URL(request.url()).pathname));
    await page.route(`${baseUrl}/${retainedRuntime.runtimePath}**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(retainedRuntime.runtimePath.length + 1);
      const body = retainedRuntime.modules.get(path);
      assert.notEqual(body, undefined, `${name}: exact retained runtime membership`);
      await route.fulfill({ contentType: 'text/javascript', body });
    });
    for (const path of ['/', '/collection/']) {
      await page.route(`${baseUrl}${path}`, (route) =>
        retainedShell
          ? route.fulfill({ contentType: 'text/html', body: retainedRuntime.shells.get(path) })
          : route.continue(),
      );
    }
    await page.goto(`${baseUrl}/missing`);
    const state = JSON.stringify({
      schema: 'snoredex-collection-state',
      schemaVersion: '1.0.0',
      datasetId: 'snoredex-data/snorlax-current-known',
      catalogueFingerprint: runtimeManifest.runtime.catalogueFingerprint,
      items: [],
    });
    await page.evaluate((value) => localStorage.setItem('snoredex-checklist.private-state', value), state);
    for (const retained of [false, true, false]) {
      retainedShell = retained;
      for (const path of ['/', '/collection/']) {
        requests.length = 0;
        await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
        await page
          .locator(path === '/' ? '.localization-group' : '.query-primary')
          .first()
          .waitFor();
        const prefix = `/${retained ? retainedRuntime.runtimePath : `assets/${moduleManifest.runtimeAssetSet.path}/`}`;
        assert.ok(
          requests
            .filter((request) => request.includes('/assets/runtime/'))
            .every((request) => request.startsWith(prefix)),
          `${name}: coherent ${retained ? 'retained' : 'active'} route`,
        );
        assert.equal(
          await page.evaluate(() => localStorage.getItem('snoredex-checklist.private-state')),
          state,
          `${name}: forward/rollback/restoration conserves synthetic state`,
        );
      }
    }
    await probePrivateAccess(page);
    for (const retained of [false, true]) {
      retainedShell = retained;
      for (const [path, module] of [
        ['/', 'home.js'],
        ['/collection/', 'collection.js'],
      ]) {
        const target = `${baseUrl}/${retained ? retainedRuntime.runtimePath : `assets/${moduleManifest.runtimeAssetSet.path}/`}${module}`;
        const body = retained
          ? await readFile(join(root, 'assets', module), 'utf8')
          : retainedRuntime.modules.get(module);
        let intercepted = false;
        await page.route(target, (route) => {
          intercepted = true;
          return route.fulfill({ contentType: 'text/javascript', body });
        });
        await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
        assert.ok(intercepted, `${name}: mixed ${retained ? 'retained' : 'active'} ${module} bytes requested`);
        assert.equal(
          await page.locator(path === '/' ? '.localization-group' : '.query-primary').count(),
          0,
          `${name}: cross-generation ${module} rejected in both directions`,
        );
        assert.equal(
          await page.evaluate(() => window.privateAccesses),
          0,
          `${name}: mixed route never accesses private state`,
        );
        await page.unroute(target);
      }
    }
  } finally {
    await page.close();
  }
}
const staleRuntimeSnapshotSource = snapshotSource.replace(
  /"appRevision":"[0-9a-f]{40}"/u,
  `"appRevision":"${'e'.repeat(40)}"`,
);
const staleRuntimeMigrationsSource = migrationsSource.replace(
  /"appRevision":"[0-9a-f]{40}"/u,
  `"appRevision":"${'e'.repeat(40)}"`,
);
assert.notEqual(staleRuntimeSnapshotSource, snapshotSource, 'snapshot runtime fixture must change its revision');
assert.notEqual(staleRuntimeMigrationsSource, migrationsSource, 'migration runtime fixture must change its revision');
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
async function assertSecurityBoundary(page, name) {
  const bindings =
    (await page.locator('body').getAttribute('data-page')) === 'collection' ? collectionBindings : homeBindings;
  const expectedCsp = `default-src 'none'; base-uri 'none'; form-action 'self'; img-src 'self'; script-src 'self' '${bindings.importMapCsp}'; style-src 'self'; connect-src 'none'; object-src 'none'; worker-src 'none'; frame-src 'none'; font-src 'self'; media-src 'none'; manifest-src 'none'`;
  assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(), 1, `${name}: one CSP`);
  assert.equal(
    await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
    expectedCsp,
    `${name}: CSP directives`,
  );
  assert.equal(await page.locator('script:not([src]):not([type="importmap"])').count(), 0, `${name}: no inline code`);
  assert.equal(await page.locator('script[type="importmap"]:not([src])').count(), 1, `${name}: one integrity map`);
  assert.equal(
    await page.locator('script[type="importmap"]').textContent(),
    bindings.importMap,
    `${name}: exact integrity map`,
  );
  assert.equal(
    await page.locator('head > script[src$="theme.js"][type="module"]').count(),
    0,
    `${name}: theme bootstrap is blocking`,
  );
  assert.equal(await page.locator('head > script[src$="theme.js"]').count(), 1, `${name}: one theme bootstrap`);
  assert.equal(
    await page.locator('head > script[src$="theme.js"]').getAttribute('integrity'),
    bindings.themeIntegrity,
    `${name}: theme integrity`,
  );
  assert.equal(
    await page.locator('script[type="module"][src$="app.js"]').getAttribute('integrity'),
    bindings.appIntegrity,
    `${name}: app integrity`,
  );
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
  const scripts = await page
    .locator('script')
    .evaluateAll((elements) => elements.map((script) => ({ source: script.getAttribute('src'), type: script.type })));
  assert.ok(
    scripts.length > 0 &&
      scripts.every(({ source, type }) =>
        type === 'importmap' ? source === null : typeof source === 'string' && source.length > 0,
      ),
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
    assert.equal(
      await page.locator('script:not([src]):not([type="importmap"])').count(),
      0,
      `${name}: hostile query did not create executable script`,
    );
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
      await assertRetainedRoutes(browser, name);
      const page = await browser.newPage();
      await probePrivateAccess(page);
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
        await page.evaluate(() => window.privateAccesses),
        0,
        `${name}: homepage never accesses private state`,
      );
      assert.equal(
        requestedPaths.some(
          (path) =>
            path.includes('/state/') ||
            [
              'collection.js',
              'collection-state.js',
              'private-state.js',
              'results.js',
              'filter.js',
              'snapshot.js',
              'migrations.js',
            ].some((name) => path.endsWith(`/${name}`)),
        ),
        false,
        `${name}: home omits collection controllers, state/storage/backup and full catalogue payloads`,
      );
      const rollbackPage = await browser.newPage();
      const rollbackRequests = [];
      rollbackPage.on('request', (request) => rollbackRequests.push(new URL(request.url()).pathname));
      const legacyShell = (await readFile(join(root, 'index.html'), 'utf8')).replace(
        /<meta name="snoredex-directory-sha256" content="sha256:[0-9a-f]{64}" \/>/u,
        '',
      );
      assert.ok(!legacyShell.includes('name="snoredex-directory-sha256"'));
      await rollbackPage.route(`${baseUrl}/`, (route) =>
        route.fulfill({ contentType: 'text/html', body: legacyShell }),
      );
      await rollbackPage.route('**/assets/runtime/**/directory.js', (route) => route.abort());
      await rollbackPage.route('**/assets/runtime/**/directory-snapshot.js', (route) => route.abort());
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
      await staleValidatorPage.route('**/assets/runtime/**/directory.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript; charset=utf-8',
          body: 'export async function validateDirectorySnapshot() { return true; }',
        }),
      );
      await staleValidatorPage.route('**/assets/runtime/**/directory-snapshot.js', (route) =>
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
      await staleProvenancePage.route('**/assets/runtime/**/directory-snapshot.js', (route) =>
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
      const tamperedBootstrapPage = await browser.newPage();
      await tamperedBootstrapPage.route('**/assets/runtime/**/app.js', (route) =>
        route.fulfill({
          contentType: 'text/javascript; charset=utf-8',
          body: `
            const expectedDigest = document.querySelector('meta[name="snoredex-directory-sha256"]')?.content;
            const [directoryModule, snapshotModule] = await Promise.all([
              import('./directory.js'),
              import('./directory-snapshot.js'),
            ]);
            document.body.dataset.legacyDigestResult = String(
              await directoryModule.validateDirectorySnapshot(snapshotModule.default, expectedDigest),
            );
          `,
        }),
      );
      const tamperedBootstrapHome = await tamperedBootstrapPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      assert.equal(tamperedBootstrapHome?.status(), 200, `${name}: tampered bootstrap home status`);
      assert.equal(
        await tamperedBootstrapPage.locator('body').getAttribute('data-legacy-digest-result'),
        null,
        `${name}: SRI blocks a changed entry module before execution`,
      );
      await tamperedBootstrapPage.close();
      for (const [modulePath, source] of [
        ['app.js', `localStorage.setItem('${PRIVATE_STATE_KEY}', 'mutated');`],
        [
          'collection.js',
          `localStorage.setItem('${PRIVATE_STATE_KEY}', 'mutated'); export async function startCollection() {}`,
        ],
        [
          'private-state.js',
          `localStorage.setItem('${PRIVATE_STATE_KEY}', 'mutated'); export async function readPrivateState() { return { readable: true, hasActiveState: false, statuses: new Map() }; }`,
        ],
      ]) {
        const integrityPage = await browser.newPage();
        await integrityPage.goto(`${baseUrl}/missing`, { waitUntil: 'domcontentloaded' });
        const privateStateBefore = JSON.stringify({ schema: 'synthetic-private-state', marker: modulePath });
        await integrityPage.evaluate(({ key, value }) => localStorage.setItem(key, value), {
          key: PRIVATE_STATE_KEY,
          value: privateStateBefore,
        });
        await integrityPage.route(`**/assets/runtime/**/${modulePath}`, (route) =>
          route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: source }),
        );
        const integrityCollection = await integrityPage.goto(`${baseUrl}/collection/`, { waitUntil: 'networkidle' });
        assert.equal(integrityCollection?.status(), 200, `${name}: tampered ${modulePath} collection status`);
        assert.equal(
          await integrityPage.evaluate((key) => localStorage.getItem(key), PRIVATE_STATE_KEY),
          privateStateBefore,
          `${name}: SRI blocks tampered ${modulePath} before private-state access`,
        );
        await integrityPage.close();
      }
      for (const [modulePath, source] of [
        ['snapshot.js', staleRuntimeSnapshotSource],
        ['migrations.js', staleRuntimeMigrationsSource],
      ]) {
        const mixedRuntimePage = await browser.newPage();
        await probePrivateAccess(mixedRuntimePage);
        await mixedRuntimePage.route(`**/assets/runtime/**/${modulePath}`, (route) =>
          route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: source }),
        );
        await mixedRuntimePage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
        const privateStateBefore = JSON.stringify({ schema: 'synthetic-private-state', marker: modulePath });
        await mixedRuntimePage.evaluate(({ key, value }) => localStorage.setItem(key, value), {
          key: PRIVATE_STATE_KEY,
          value: privateStateBefore,
        });
        const mixedRuntimeCollection = await mixedRuntimePage.goto(`${baseUrl}/collection/`, {
          waitUntil: 'networkidle',
        });
        assert.equal(mixedRuntimeCollection?.status(), 200, `${name}: mixed ${modulePath} collection status`);
        assert.equal(
          await mixedRuntimePage.evaluate(() => window.privateAccesses),
          0,
          `${name}: tuple failure precedes every private-state access`,
        );
        assert.equal(
          await mixedRuntimePage.locator('[data-view] h2').textContent(),
          'Invalid checklist link',
          `${name}: mixed ${modulePath} fails closed`,
        );
        assert.equal(
          await mixedRuntimePage.evaluate((key) => localStorage.getItem(key), PRIVATE_STATE_KEY),
          privateStateBefore,
          `${name}: mixed ${modulePath} leaves private state untouched`,
        );
        await mixedRuntimePage.close();
      }
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
      assert.equal(
        await page.getByRole('heading', { name: 'Collection progress' }).count(),
        1,
        `${name}: overall progress overview`,
      );
      assert.equal(
        await page.locator('[data-progress-overview] > .progress-overview').count(),
        1,
        `${name}: progress overview landmark wrapper`,
      );
      assert.equal(
        await page.locator('.progress-overview').getAttribute('aria-labelledby'),
        'progress-overview-title',
        `${name}: progress overview accessible name`,
      );
      assert.ok((await page.locator('.progress-card').count()) > 1, `${name}: localization progress cards`);
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
        const focusItem =
          trackable.find(
            (candidate) => trackable.filter((other) => other.localizationId === candidate.localizationId).length > 24,
          ) ??
          trackable.find(
            (candidate) => trackable.filter((other) => other.localizationId === candidate.localizationId).length === 3,
          );
        const activeEditionIds = new Set(
          catalogue.items
            .filter((candidate) => candidate.active && candidate.setEditionId)
            .map((candidate) => candidate.setEditionId),
        );
        const emptyEdition = catalogue.setEditions.find((edition) => !activeEditionIds.has(edition.setEditionId));
        const emptyBrowseEditions = emptyEdition
          ? catalogue.setEditions.filter((edition) => edition.localizationId === emptyEdition.localizationId)
          : [];
        return {
          fingerprint: catalogue.meta.catalogueFingerprint,
          itemId: item.itemId,
          localizationId: item.localizationId,
          focusLocalizationId: focusItem?.localizationId,
          focusLocalizationItemCount: focusItem
            ? catalogue.items.filter(
                (candidate) => candidate.active && candidate.localizationId === focusItem.localizationId,
              ).length
            : 0,
          localizationItemCount: catalogue.items.filter(
            (candidate) => candidate.active && candidate.localizationId === item.localizationId,
          ).length,
          secondItemId: trackable.find(
            (candidate) => candidate.localizationId === item.localizationId && candidate.itemId !== item.itemId,
          )?.itemId,
          singletonEdition: trackable.find(
            (candidate) =>
              candidate.setEditionId &&
              trackable.filter((other) => other.setEditionId === candidate.setEditionId).length === 1,
          )
            ? {
                edition: trackable.find(
                  (candidate) =>
                    candidate.setEditionId &&
                    trackable.filter((other) => other.setEditionId === candidate.setEditionId).length === 1,
                ).setEditionId,
                itemId: trackable.find(
                  (candidate) =>
                    candidate.setEditionId &&
                    trackable.filter((other) => other.setEditionId === candidate.setEditionId).length === 1,
                ).itemId,
              }
            : undefined,
          emptyBrowse: emptyEdition
            ? {
                localizationId: emptyEdition.localizationId,
                editionCount: emptyBrowseEditions.length,
                setCount: new Set(emptyBrowseEditions.map((edition) => edition.localSetId)).size,
                emptyEditionCount: emptyBrowseEditions.filter((edition) => !activeEditionIds.has(edition.setEditionId))
                  .length,
              }
            : undefined,
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
        await page.evaluate(
          ({ fingerprint, itemId }) => {
            localStorage.setItem(
              'snoredex-checklist.private-state',
              JSON.stringify({
                schema: 'snoredex-collection-state',
                schemaVersion: '1.0.0',
                datasetId: 'snoredex-data/snorlax-current-known',
                catalogueFingerprint: fingerprint,
                items: [{ itemId, status: 'have', quantityOwned: 1, quantityOrdered: 0 }],
              }),
            );
            const event = new Event('pageshow');
            Object.defineProperty(event, 'persisted', { value: true });
            window.dispatchEvent(event);
          },
          { fingerprint: synthetic.fingerprint, itemId: synthetic.itemId },
        );
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.progress-card')].some((card) => /1 Have/u.test(card.textContent ?? '')),
        );
        assert.equal(
          (await page.locator('.progress-card').filter({ hasText: '1 Have' }).count()) > 0,
          true,
          `${name}: persisted pageshow refreshes overview`,
        );
        const overviewContext = await browser.newContext();
        const overviewTab = await overviewContext.newPage();
        const overviewWriter = await overviewContext.newPage();
        try {
          await overviewTab.goto(`${baseUrl}/collection/`, { waitUntil: 'networkidle' });
          await overviewWriter.goto(`${baseUrl}/collection/`, { waitUntil: 'networkidle' });
          await overviewWriter.evaluate(
            (value) => {
              localStorage.setItem('snoredex-checklist.private-state', JSON.stringify(value));
            },
            {
              schema: 'snoredex-collection-state',
              schemaVersion: '1.0.0',
              datasetId: 'snoredex-data/snorlax-current-known',
              catalogueFingerprint: synthetic.fingerprint,
              items: [{ itemId: synthetic.itemId, status: 'have', quantityOwned: 1, quantityOrdered: 0 }],
            },
          );
          await overviewTab.waitForFunction(() => {
            const overall = [...document.querySelectorAll('.progress-card')].find(
              (card) => card.querySelector('h3')?.textContent === 'Overall',
            );
            return /1 Have/u.test(overall?.textContent ?? '');
          });
          await overviewWriter.evaluate((key) => localStorage.removeItem(key), PRIVATE_STATE_KEY);
          await overviewTab.waitForFunction(() => {
            const overall = [...document.querySelectorAll('.progress-card')].find(
              (card) => card.querySelector('h3')?.textContent === 'Overall',
            );
            return /0 Have/u.test(overall?.textContent ?? '');
          });
        } finally {
          await overviewContext.close();
        }
        await page.evaluate(() => {
          for (const key of Object.keys(localStorage))
            if (key.startsWith('snoredex-checklist.private-state')) localStorage.removeItem(key);
        });
        await page.goto(`${baseUrl}/collection/?localization=${encodeURIComponent(synthetic.localizationId)}`, {
          waitUntil: 'networkidle',
        });
        const firstSaveControls = controlsForItem(page, synthetic.itemId);
        while ((await firstSaveControls.count()) === 0 && (await page.locator('[data-show-more]').count()) > 0)
          await page.locator('[data-show-more]').click();
        await page.getByText('Backup and recovery', { exact: true }).click();
        const firstSaveExport = page.getByRole('button', { name: 'Export collection' });
        assert.equal(
          await firstSaveExport.isEnabled(),
          false,
          `${name}: recovery export starts disabled without confirmed state`,
        );
        await page.evaluate((key) => {
          const original = Storage.prototype.setItem;
          globalThis.__snoredexRestoreSetItem = () => {
            Storage.prototype.setItem = original;
          };
          globalThis.__snoredexFailNextStateWrite = true;
          Storage.prototype.setItem = function failOneStateWrite(candidate, value) {
            if (candidate === key && globalThis.__snoredexFailNextStateWrite) {
              globalThis.__snoredexFailNextStateWrite = false;
              globalThis.__snoredexFailedStateWrite = true;
              throw new Error('synthetic state write failure');
            }
            return original.call(this, candidate, value);
          };
        }, PRIVATE_STATE_KEY);
        await firstSaveControls.getByRole('radio', { name: 'Have' }).check();
        await page.waitForFunction(() => globalThis.__snoredexFailedStateWrite === true);
        await firstSaveControls.locator('.state-feedback').filter({ hasText: 'Save failed.' }).waitFor();
        assert.equal(await firstSaveExport.isEnabled(), false, `${name}: failed save does not enable recovery export`);
        await page.evaluate(() => globalThis.__snoredexRestoreSetItem?.());
        await firstSaveControls.getByRole('button', { name: 'Retry save' }).click();
        await firstSaveControls.locator('.state-feedback').filter({ hasText: 'Saved' }).waitFor();
        assert.equal(
          await firstSaveExport.isEnabled(),
          true,
          `${name}: recovery export follows a successful save without reload`,
        );
        const crossTabContext = await browser.newContext();
        const firstTab = await crossTabContext.newPage();
        const secondTab = await crossTabContext.newPage();
        try {
          await firstTab.goto(`${baseUrl}/collection/?localization=${encodeURIComponent(synthetic.localizationId)}`, {
            waitUntil: 'networkidle',
          });
          await firstTab.getByText('Backup and recovery', { exact: true }).click();
          const firstTabExport = firstTab.getByRole('button', { name: 'Export collection' });
          await secondTab.goto(`${baseUrl}/collection/?localization=${encodeURIComponent(synthetic.localizationId)}`, {
            waitUntil: 'networkidle',
          });
          const secondTabControls = controlsForItem(secondTab, synthetic.itemId);
          while ((await secondTabControls.count()) === 0 && (await secondTab.locator('[data-show-more]').count()) > 0)
            await secondTab.locator('[data-show-more]').click();
          await secondTabControls.getByRole('radio', { name: 'Have' }).check();
          await secondTabControls.locator('.state-feedback').filter({ hasText: 'Saved' }).waitFor();
          await firstTab.waitForFunction(() => {
            return [...document.querySelectorAll('button')].some(
              (candidate) => candidate.textContent === 'Export collection' && !candidate.disabled,
            );
          });
          assert.equal(
            await firstTabExport.isEnabled(),
            true,
            `${name}: recovery export follows a confirmed save from another tab`,
          );
          await secondTab.evaluate((key) => localStorage.removeItem(key), PRIVATE_STATE_KEY);
          await firstTab.waitForFunction(() =>
            [...document.querySelectorAll('button')].some(
              (candidate) => candidate.textContent === 'Export collection' && candidate.disabled,
            ),
          );
          assert.equal(
            await firstTabExport.isEnabled(),
            false,
            `${name}: recovery export follows a clear from another tab`,
          );
        } finally {
          await crossTabContext.close();
        }

        assert.notEqual(synthetic.emptyBrowse, undefined, `${name}: localization with an empty edition`);
        if (synthetic.emptyBrowse !== undefined) {
          assert.ok(synthetic.emptyBrowse.emptyEditionCount > 0, `${name}: empty edition regression fixture`);
          await page.goto(
            `${baseUrl}/collection/?localization=${encodeURIComponent(synthetic.emptyBrowse.localizationId)}`,
            { waitUntil: 'networkidle' },
          );
          assert.equal(
            await page.locator('[data-view] .result-edition').count(),
            synthetic.emptyBrowse.editionCount,
            `${name}: plain localization browse retains every producer-known edition`,
          );
          assert.equal(
            await page.locator('[data-view] .result-set').count(),
            synthetic.emptyBrowse.setCount,
            `${name}: plain localization browse retains every producer-known set`,
          );
        }
        await page.evaluate(({ fingerprint, itemId }) => {
          for (const key of Object.keys(localStorage))
            if (key.startsWith('snoredex-checklist.private-state')) localStorage.removeItem(key);
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
        const firstIdentityRow = page.locator('[data-view] [data-item-id]').first();
        assert.match(
          await firstIdentityRow.locator('.item-identity').innerText(),
          /Size:\s*standard/u,
          `${name}: primary identity exposes producer card size`,
        );
        assert.ok(
          (await page.locator('[data-view] .item-cue').allTextContents()).includes('Verified printing'),
          `${name}: primary tags expose producer item kind`,
        );
        await firstIdentityRow.locator('.item-details > summary').click();
        assert.match(
          await firstIdentityRow.locator('.item-detail-list').innerText(),
          /Edition\n(?:Not recorded|[^\n]+)/u,
          `${name}: details expose the producer edition field`,
        );
        assert.equal(
          await page.locator('[data-view] [data-item-id]').count(),
          Math.min(24, synthetic.localizationItemCount),
          `${name}: initial result chunk`,
        );
        if (synthetic.localizationItemCount > 24) {
          const assertNoVisibleEmptyLists = async () => {
            assert.equal(
              await page
                .locator('[data-view] ul.item-list')
                .evaluateAll(
                  (lists) => lists.filter((list) => !list.closest('[hidden]') && list.childElementCount === 0).length,
                ),
              0,
              `${name}: pending editions expose headings without empty lists`,
            );
          };
          await assertNoVisibleEmptyLists();
          const showMore = page.locator('[data-show-more]');
          assert.equal(await showMore.count(), 1, `${name}: progressive result control`);
          const mountedRows = await page.locator('[data-view] [data-item-id]').elementHandles();
          const editableRow = page
            .locator('[data-view] .item-row')
            .filter({ has: page.locator('.collection-controls') })
            .first();
          const quantity = editableRow.locator('.quantity-control');
          await editableRow.getByRole('radio', { name: 'Have', exact: true }).check();
          await quantity.locator('summary').click();
          const ownedDraft = quantity.locator('input').first();
          await ownedDraft.fill('7');
          await showMore.click();
          await assertNoVisibleEmptyLists();
          for (const row of mountedRows)
            assert.equal(
              await row.evaluate((node) => node.isConnected),
              true,
              `${name}: reveal preserves mounted rows`,
            );
          assert.equal(
            await firstIdentityRow.locator('.item-details').getAttribute('open'),
            '',
            `${name}: reveal preserves open evidence`,
          );
          assert.equal(await quantity.getAttribute('open'), '', `${name}: reveal preserves open quantities`);
          assert.equal(await ownedDraft.inputValue(), '7', `${name}: reveal preserves the quantity draft`);
          assert.equal(
            await page.locator('[data-view] [data-item-id]').count(),
            Math.min(48, synthetic.localizationItemCount),
            `${name}: second result chunk`,
          );
          if (synthetic.localizationItemCount > 48) {
            const firstNewItemId = await page
              .locator('[data-view] [data-item-id]')
              .nth(24)
              .getAttribute('data-item-id');
            assert.equal(
              await page.evaluate(() =>
                document.activeElement?.closest('[data-item-id]')?.getAttribute('data-item-id'),
              ),
              firstNewItemId,
              `${name}: non-final reveal focuses the first newly mounted item`,
            );
          } else {
            assert.equal(
              await page.evaluate(() => document.activeElement?.matches('[data-results-progress]')),
              true,
              `${name}: final first reveal focuses the completion target`,
            );
          }
          while ((await showMore.count()) > 0) {
            const existing = await page.locator('[data-view] [data-item-id]').elementHandles();
            await showMore.click();
            await assertNoVisibleEmptyLists();
            for (const row of existing) {
              assert.equal(
                await row.evaluate((node) => node.isConnected),
                true,
                `${name}: every reveal only appends rows`,
              );
              await row.dispose();
            }
          }
          for (const row of mountedRows) await row.dispose();
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
          console.log(`${name}: progressive results preserve each of ${synthetic.localizationItemCount} row instances`);
        }

        assert.notEqual(synthetic.focusLocalizationId, undefined, `${name}: focus localization fixture`);
        const focusUrl = `${baseUrl}/collection/?localization=${encodeURIComponent(synthetic.focusLocalizationId)}&status=need`;
        await page.evaluate(() => {
          for (const key of Object.keys(localStorage))
            if (key.startsWith('snoredex-checklist.private-state')) localStorage.removeItem(key);
        });
        await page.goto(focusUrl, { waitUntil: 'networkidle' });
        const focusIds = await page
          .locator('[data-view] [data-item-id]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-item-id')));
        assert.ok(focusIds.length >= 3, `${name}: focus fixture has first, middle, and last rows`);
        const selectHaveWithoutWaitingForDetach = async (itemId) =>
          page.evaluate((targetItemId) => {
            const input = [...document.querySelectorAll('input[type="radio"]')].find(
              (candidate) => candidate.name === `status-${targetItemId}` && candidate.value === 'have',
            );
            if (!(input instanceof HTMLInputElement)) throw new Error(`missing status input for ${targetItemId}`);
            input.focus();
            input.checked = true;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }, itemId);
        const focusCases = [
          [0, 1],
          [1, 2],
        ];
        if (synthetic.focusLocalizationItemCount <= focusIds.length)
          focusCases.push([focusIds.length - 1, focusIds.length - 2]);
        for (const [index, expectedIndex] of focusCases) {
          await page.evaluate(() => {
            for (const key of Object.keys(localStorage))
              if (key.startsWith('snoredex-checklist.private-state')) localStorage.removeItem(key);
          });
          await page.goto(focusUrl, { waitUntil: 'networkidle' });
          const targetId = focusIds[index];
          const expectedId = focusIds[expectedIndex];
          const targetControls = controlsForItem(page, targetId);
          await targetControls.getByRole('radio', { name: 'Have' }).waitFor();
          await selectHaveWithoutWaitingForDetach(targetId);
          await page.waitForFunction(
            (itemId) => [...document.querySelectorAll('[data-item-id]')].every((row) => row.dataset.itemId !== itemId),
            targetId,
          );
          assert.equal(
            await page.evaluate(() => document.activeElement?.closest('[data-item-id]')?.getAttribute('data-item-id')),
            expectedId,
            `${name}: filtered row removal preserves ${index === focusIds.length - 1 ? 'previous' : 'next'} row focus`,
          );
          assert.match(
            await page.locator('[data-view-status]').textContent(),
            /Status updated\./u,
            `${name}: filtered row removal announces the update`,
          );
        }
        await page.evaluate(() => {
          for (const key of Object.keys(localStorage))
            if (key.startsWith('snoredex-checklist.private-state')) localStorage.removeItem(key);
        });
        await page.goto(focusUrl, { waitUntil: 'networkidle' });
        await page.evaluate(
          ([focusedId, removedId]) => {
            const selectHave = (itemId, focus) => {
              const input = [...document.querySelectorAll('input[type="radio"]')].find(
                (candidate) => candidate.name === `status-${itemId}` && candidate.value === 'have',
              );
              if (!(input instanceof HTMLInputElement)) throw new Error(`missing status input for ${itemId}`);
              if (focus) input.focus();
              input.checked = true;
              input.dispatchEvent(new Event('change', { bubbles: true }));
            };
            selectHave(focusedId, true);
            selectHave(removedId, false);
          },
          [focusIds[1], focusIds[0]],
        );
        await page.waitForFunction(
          ([focusedId, removedId]) =>
            [...document.querySelectorAll('[data-item-id]')].every(
              (row) => row.dataset.itemId !== focusedId && row.dataset.itemId !== removedId,
            ),
          [focusIds[1], focusIds[0]],
        );
        assert.equal(
          await page.evaluate(() => document.activeElement?.closest('[data-item-id]')?.getAttribute('data-item-id')),
          focusIds[2],
          `${name}: batched removals focus the first surviving successor`,
        );
        if (synthetic.focusLocalizationItemCount > 24 && focusIds.length === 24) {
          await page.evaluate(() => {
            for (const key of Object.keys(localStorage))
              if (key.startsWith('snoredex-checklist.private-state')) localStorage.removeItem(key);
          });
          await page.goto(focusUrl, { waitUntil: 'networkidle' });
          const paginatedTargetId = focusIds[focusIds.length - 1];
          const paginatedPredecessorId = focusIds[focusIds.length - 2];
          await controlsForItem(page, paginatedTargetId).getByRole('radio', { name: 'Have' }).waitFor();
          await selectHaveWithoutWaitingForDetach(paginatedTargetId);
          await page.waitForFunction(
            (itemId) => [...document.querySelectorAll('[data-item-id]')].every((row) => row.dataset.itemId !== itemId),
            paginatedTargetId,
          );
          const revealedSuccessorId = await page
            .locator('[data-view] [data-item-id]')
            .nth(23)
            .getAttribute('data-item-id');
          assert.notEqual(
            revealedSuccessorId,
            paginatedPredecessorId,
            `${name}: paginated removal reveals a distinct successor`,
          );
          assert.equal(
            await page.evaluate(() => document.activeElement?.closest('[data-item-id]')?.getAttribute('data-item-id')),
            revealedSuccessorId,
            `${name}: paginated removal focuses the newly revealed successor`,
          );
        }
        assert.notEqual(synthetic.singletonEdition, undefined, `${name}: singleton focus fixture`);
        if (synthetic.singletonEdition !== undefined) {
          await page.evaluate(() => {
            for (const key of Object.keys(localStorage))
              if (key.startsWith('snoredex-checklist.private-state')) localStorage.removeItem(key);
          });
          await page.goto(
            `${baseUrl}/collection/?edition=${encodeURIComponent(synthetic.singletonEdition.edition)}&status=need`,
            { waitUntil: 'networkidle' },
          );
          assert.equal(
            await page.locator('[data-view] [data-item-id]').count(),
            1,
            `${name}: singleton filtered row fixture`,
          );
          const singletonControls = controlsForItem(page, synthetic.singletonEdition.itemId);
          await singletonControls.getByRole('radio', { name: 'Have' }).waitFor();
          await selectHaveWithoutWaitingForDetach(synthetic.singletonEdition.itemId);
          await page.waitForFunction(
            (itemId) => [...document.querySelectorAll('[data-item-id]')].every((row) => row.dataset.itemId !== itemId),
            synthetic.singletonEdition.itemId,
          );
          assert.equal(
            await page.evaluate(() => document.activeElement?.matches('[data-results-summary]')),
            true,
            `${name}: removing the only filtered row focuses the result summary`,
          );
        }
        await page.evaluate(({ fingerprint, itemId }) => {
          localStorage.setItem(
            'snoredex-checklist.private-state',
            JSON.stringify({
              schema: 'snoredex-collection-state',
              schemaVersion: '1.0.0',
              datasetId: 'snoredex-data/snorlax-current-known',
              catalogueFingerprint: fingerprint,
              items: [{ itemId, status: 'have', quantityOwned: 1, quantityOrdered: 0 }],
            }),
          );
        }, synthetic);
        await page.goto(`${baseUrl}/collection/?localization=${encodeURIComponent(synthetic.localizationId)}`, {
          waitUntil: 'networkidle',
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.getByText('Backup and recovery', { exact: true }).click();
        const exportButton = page.getByRole('button', { name: 'Export collection' });
        assert.equal(await exportButton.isEnabled(), true, `${name}: export enabled for synthetic state`);
        const exportRecoveryButton = page.getByRole('button', { name: 'Export recovery snapshot' });
        const importButton = page.getByRole('button', { name: 'Choose backup to preview' });
        const clearButton = page.getByRole('button', { name: 'Clear collection' });
        const restoreButton = page.getByRole('button', { name: 'Restore previous snapshot' });
        const recoveryStatus = page.locator('[data-recovery-status]');
        const openRecoveryTools = async () => {
          await page.reload({ waitUntil: 'networkidle' });
          await page.getByText('Backup and recovery', { exact: true }).click();
        };
        await page.evaluate(() => {
          localStorage.setItem('snoredex-checklist.private-state', '{malformed');
          localStorage.removeItem('snoredex-checklist.private-state.recovery');
          localStorage.removeItem('snoredex-checklist.private-state.recovery-records');
        });
        await openRecoveryTools();
        await recoveryStatus.filter({ hasText: 'Saved collection is unreadable.' }).waitFor();
        assert.equal(await exportButton.isEnabled(), false, `${name}: unreadable active disables active export`);
        assert.equal(
          await exportRecoveryButton.isEnabled(),
          false,
          `${name}: unreadable active disables recovery export`,
        );
        assert.equal(await clearButton.isEnabled(), false, `${name}: unreadable active disables clear`);
        assert.equal(await restoreButton.isEnabled(), false, `${name}: unreadable active disables restore`);
        assert.equal(await importButton.isEnabled(), true, `${name}: unreadable active keeps import available`);
        await page.evaluate(() => {
          localStorage.setItem(
            'snoredex-checklist.private-state',
            JSON.stringify({ schema: 'snoredex-collection-state', schemaVersion: '9.0.0' }),
          );
        });
        await openRecoveryTools();
        await recoveryStatus.filter({ hasText: 'Saved collection uses an unsupported format.' }).waitFor();
        assert.equal(await importButton.isEnabled(), false, `${name}: unsupported active disables import`);
        assert.equal(await clearButton.isEnabled(), false, `${name}: unsupported active disables clear`);
        assert.equal(await restoreButton.isEnabled(), false, `${name}: unsupported active disables restore`);
        await page.evaluate(({ fingerprint, itemId }) => {
          localStorage.setItem(
            'snoredex-checklist.private-state',
            JSON.stringify({
              schema: 'snoredex-collection-state',
              schemaVersion: '1.0.0',
              datasetId: 'snoredex-data/snorlax-current-known',
              catalogueFingerprint: fingerprint,
              items: [{ itemId, status: 'have', quantityOwned: 1, quantityOrdered: 0 }],
            }),
          );
          localStorage.setItem('snoredex-checklist.private-state.recovery', '{malformed');
          localStorage.removeItem('snoredex-checklist.private-state.recovery-records');
        }, synthetic);
        await openRecoveryTools();
        await recoveryStatus.filter({ hasText: 'Recovery snapshot is unreadable.' }).waitFor();
        assert.equal(await exportButton.isEnabled(), true, `${name}: readable active keeps active export`);
        assert.equal(
          await exportRecoveryButton.isEnabled(),
          false,
          `${name}: unreadable recovery disables recovery export`,
        );
        assert.equal(await clearButton.isEnabled(), false, `${name}: unreadable recovery disables clear`);
        assert.equal(await restoreButton.isEnabled(), false, `${name}: unreadable recovery disables restore`);
        assert.equal(await importButton.isEnabled(), true, `${name}: unreadable recovery keeps import available`);
        await page.evaluate(({ fingerprint, itemId }) => {
          const valid = {
            schema: 'snoredex-collection-state',
            schemaVersion: '1.0.0',
            datasetId: 'snoredex-data/snorlax-current-known',
            catalogueFingerprint: fingerprint,
            items: [{ itemId, status: 'have', quantityOwned: 1, quantityOrdered: 0 }],
          };
          localStorage.setItem('snoredex-checklist.private-state', JSON.stringify(valid));
          localStorage.setItem('snoredex-checklist.private-state.recovery', JSON.stringify(valid));
          localStorage.setItem('snoredex-checklist.private-state.recovery-records', '{malformed');
        }, synthetic);
        await openRecoveryTools();
        await recoveryStatus.filter({ hasText: 'Recovery ledger is unreadable.' }).waitFor();
        assert.equal(await restoreButton.isEnabled(), true, `${name}: unreadable ledger keeps restore available`);
        await restoreButton.click();
        const ledgerConfirmation = page.getByRole('dialog', { name: 'Restore previous snapshot?' });
        await ledgerConfirmation.waitFor();
        assert.match(
          await ledgerConfirmation.innerText(),
          /unreadable recovery ledger.*preserved in quarantine.*rebuilt from this restore/u,
          `${name}: restore confirmation names unreadable ledger handling`,
        );
        await ledgerConfirmation.getByRole('button', { name: 'Cancel' }).click();
        await page.evaluate(({ fingerprint, itemId }) => {
          localStorage.setItem(
            'snoredex-checklist.private-state',
            JSON.stringify({
              schema: 'snoredex-collection-state',
              schemaVersion: '1.0.0',
              datasetId: 'snoredex-data/snorlax-current-known',
              catalogueFingerprint: fingerprint,
              items: [{ itemId, status: 'have', quantityOwned: 1, quantityOrdered: 0 }],
            }),
          );
          localStorage.removeItem('snoredex-checklist.private-state.recovery');
          localStorage.removeItem('snoredex-checklist.private-state.recovery-records');
        }, synthetic);
        await openRecoveryTools();
        const downloadPromise = page.waitForEvent('download');
        await exportButton.click();
        const download = await downloadPromise;
        const stream = await download.createReadStream();
        assert.ok(stream, `${name}: backup download stream`);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const backup = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.equal(backup.catalogueFingerprint, synthetic.fingerprint, `${name}: exported fingerprint`);
        await page.evaluate(() => {
          localStorage.setItem('snoredex-checklist.private-state', '{malformed');
          localStorage.setItem('snoredex-checklist.private-state.recovery', '{malformed');
          localStorage.removeItem('snoredex-checklist.private-state.recovery-records');
        });
        await openRecoveryTools();
        assert.match(
          await recoveryStatus.innerText(),
          /Saved collection and recovery snapshot are unreadable/u,
          `${name}: combined unreadable status names both components`,
        );
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
        const applyImport = page.getByRole('button', { name: /^(?:Import|Replace) collection$/u });
        await applyImport.click();
        const combinedConfirmation = page.getByRole('dialog', { name: /^(?:Import|Replace) collection\?$/u });
        await combinedConfirmation.waitFor();
        assert.match(
          await combinedConfirmation.innerText(),
          /saved collection and recovery snapshot are unreadable.*replaces both components/u,
          `${name}: combined unreadable confirmation names both components`,
        );
        await combinedConfirmation.getByRole('button', { name: 'Cancel' }).click();
        await page.evaluate(({ fingerprint, itemId }) => {
          localStorage.setItem(
            'snoredex-checklist.private-state',
            JSON.stringify({
              schema: 'snoredex-collection-state',
              schemaVersion: '1.0.0',
              datasetId: 'snoredex-data/snorlax-current-known',
              catalogueFingerprint: fingerprint,
              items: [{ itemId, status: 'have', quantityOwned: 1, quantityOrdered: 0 }],
            }),
          );
          localStorage.removeItem('snoredex-checklist.private-state.recovery');
          localStorage.removeItem('snoredex-checklist.private-state.recovery-records');
        }, synthetic);
        await openRecoveryTools();
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
