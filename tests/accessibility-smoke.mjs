import assert from 'node:assert/strict';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium, firefox, webkit } from '@playwright/test';
import { startStaticServer } from './static-server.mjs';

const { server, baseUrl } = await startStaticServer();
const { default: builtSnapshot } = await import('../dist/site/assets/snapshot.js');
const scopeItem = builtSnapshot.items.find((item) => item.active && item.progressClass === 'current-known');
const collectionScope = scopeItem
  ? `/collection/?localization=${encodeURIComponent(scopeItem.localizationId)}`
  : '/collection/?q=Snorlax';
const researchItem = builtSnapshot.items.find(
  (item) =>
    item.active &&
    item.progressClass === 'research' &&
    item.setEditionId &&
    !builtSnapshot.items.some(
      (candidate) =>
        candidate.active && candidate.progressClass === 'current-known' && candidate.setEditionId === item.setEditionId,
    ),
);
const researchScope = researchItem
  ? `/collection/?localization=${encodeURIComponent(researchItem.localizationId)}&edition=${encodeURIComponent(researchItem.setEditionId)}`
  : collectionScope;
const engines = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
];
const viewports = [
  ['desktop', { width: 1280, height: 900 }],
  ['narrow', { width: 320, height: 736 }],
  ['phone', { width: 360, height: 800 }],
  ['tablet', { width: 736, height: 900 }],
];
const violations = [];

function recordUnexpectedRequests(page, origin) {
  const unexpected = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(origin)) unexpected.push(request.url());
  });
  return unexpected;
}

async function expectNoSeriousAxeViolations(page, engine, viewport, route) {
  const result = await new AxeBuilder({ page }).analyze();
  const serious = result.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact));
  if (serious.length > 0) violations.push({ engine, viewport, route, serious });
}

async function expectTouchTargets(page, engine, viewport, route) {
  const shortTargets = await page
    .locator(
      'a:visible, summary:visible, button:visible, select:visible, input:not([type="radio"]):visible, textarea:visible',
    )
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            text: element.textContent?.trim(),
            width: rect.width,
            height: rect.height,
          };
        })
        .filter(({ width, height }) => width < 44 || height < 44),
    );
  assert.deepEqual(shortTargets, [], `${engine}/${viewport}/${route}: touch targets`);
  assert.equal(
    await page.locator('input[type="radio"]:visible').evaluateAll((elements) =>
      elements.every((element) => {
        const rect = element.closest('label')?.getBoundingClientRect();
        return rect !== undefined && rect.width >= 44 && rect.height >= 44;
      }),
    ),
    true,
    `${engine}/${viewport}/${route}: radio touch targets`,
  );
}

async function inspectPage(page, engine, viewport, path) {
  const route = path === '/' ? 'index' : 'collection';
  const home = await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
  assert.equal(home?.status(), 200, `${engine}/${viewport}/${route}: status`);
  assert.equal(await page.locator('main#main-content').count(), 1, `${engine}/${viewport}/${route}: main landmark`);
  assert.equal(await page.locator('h1').count(), 1, `${engine}/${viewport}/${route}: one h1`);
  assert.equal(
    await page
      .locator('a:visible, button:visible, input:visible, select:visible, textarea:visible')
      .evaluateAll((elements) =>
        elements.every((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }),
      ),
    true,
    `${engine}/${viewport}/${route}: visible controls`,
  );
  await expectTouchTargets(page, engine, viewport, route);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    `${engine}/${viewport}/${route}: no horizontal overflow`,
  );
  await expectNoSeriousAxeViolations(page, engine, viewport, route);
  return route;
}

try {
  for (const [engineName, engine] of engines) {
    let browser;
    try {
      browser = await engine.launch({ headless: true });
    } catch (error) {
      throw new Error(`BROWSER_${engineName.toUpperCase()}_INSTALL_MISSING: run npx playwright install ${engineName}`, {
        cause: error,
      });
    }
    try {
      const themeContext = await browser.newContext({ viewport: { width: 360, height: 800 }, colorScheme: 'dark' });
      const themePage = await themeContext.newPage();
      await themePage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      assert.equal(
        await themePage.evaluate(() => document.documentElement.dataset.theme),
        'dark',
        `${engineName}: system dark theme`,
      );
      const systemThemeToggle = themePage.getByRole('button', { name: 'Dark theme' });
      assert.equal(await systemThemeToggle.getAttribute('aria-pressed'), 'true', `${engineName}: system theme state`);
      await systemThemeToggle.click();
      assert.equal(
        await themePage.evaluate(() => document.documentElement.dataset.theme),
        'light',
        `${engineName}: manual theme override`,
      );
      await themePage.reload({ waitUntil: 'networkidle' });
      assert.equal(
        await themePage.evaluate(() => document.documentElement.dataset.theme),
        'light',
        `${engineName}: stored theme override`,
      );
      await themeContext.close();
      for (const [viewportName, viewport] of viewports) {
        const context = await browser.newContext({ viewport, hasTouch: true });
        const page = await context.newPage();
        const unexpected = recordUnexpectedRequests(page, baseUrl);
        await inspectPage(page, engineName, viewportName, '/');
        const themeToggle = page.getByRole('button', { name: 'Dark theme' });
        await themeToggle.click();
        assert.equal(
          await themeToggle.getAttribute('aria-pressed'),
          'true',
          `${engineName}/${viewportName}: dark theme state`,
        );
        await expectNoSeriousAxeViolations(page, engineName, viewportName, 'index-dark');
        assert.equal(
          await page.getByRole('link', { name: 'Open collection' }).count(),
          1,
          `${engineName}/${viewportName}: keyboard route target`,
        );
        const skipLink = page.getByRole('link', { name: 'Skip to content' });
        await skipLink.focus();
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute('href') === '#main-content'),
          true,
          `${engineName}/${viewportName}: skip-link focus`,
        );
        const collectionLink = page.getByRole('link', { name: 'Open collection' });
        await collectionLink.focus();
        await Promise.all([page.waitForURL(/\/collection\/$/u), collectionLink.press('Enter')]);
        await page.waitForLoadState('networkidle');
        assert.match(page.url(), /\/collection\/$/u, `${engineName}/${viewportName}: keyboard navigation`);
        await inspectPage(page, engineName, viewportName, collectionScope);
        assert.equal(
          await page.getByRole('heading', { name: 'Current-known progress' }).count(),
          1,
          `${engineName}/${viewportName}: progress heading`,
        );
        assert.equal(
          (await page.getByRole('button', { name: 'Inspect image', exact: false }).count()) > 0,
          true,
          `${engineName}/${viewportName}: image inspection control`,
        );
        const imageButton = page.getByRole('button', { name: 'Inspect image', exact: false }).first();
        await imageButton.hover();
        assert.notEqual(
          await imageButton.locator('img').evaluate((image) => getComputedStyle(image).transform),
          'none',
          `${engineName}/${viewportName}: hover image inspection`,
        );
        await imageButton.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog');
        await dialog.waitFor({ state: 'visible' });
        await expectNoSeriousAxeViolations(page, engineName, viewportName, 'collection-dialog');
        assert.equal(
          await dialog.getByRole('button', { name: 'Close image' }).count(),
          1,
          `${engineName}/${viewportName}: dialog close`,
        );
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        await imageButton.tap();
        await dialog.waitFor({ state: 'visible' });
        await dialog.getByRole('button', { name: 'Close image' }).tap();
        await dialog.waitFor({ state: 'hidden' });
        const have = page.getByRole('radio', { name: 'Have' }).first();
        await have.check();
        await page
          .getByRole('status')
          .filter({ hasText: /Saving|Saved/u })
          .first()
          .waitFor();
        const addNote = page.getByRole('button', { name: 'Add note' }).first();
        await addNote.click();
        const note = page.getByRole('textbox', { name: /Private note/u }).first();
        await note.fill('synthetic keyboard edit');
        await note.blur();
        await page
          .getByRole('status')
          .filter({ hasText: /Saving|Saved/u })
          .first()
          .waitFor();
        await page
          .locator('.item-identity')
          .first()
          .evaluate((element) => {
            const localName = document.createElement('span');
            localName.className = 'item-local-name';
            localName.textContent = '超長いローカライズ名 — 非常に長い表示テキスト';
            element.append(localName);
          });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(
          await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
          true,
          `${engineName}/${viewportName}: reduced motion media`,
        );
        assert.ok(
          (await page
            .locator('.image-button img')
            .first()
            .evaluate((image) => Number.parseFloat(getComputedStyle(image).transitionDuration))) <= 0.01,
          `${engineName}/${viewportName}: reduced motion transition`,
        );
        assert.equal(
          await page
            .locator('.image-button img')
            .first()
            .evaluate((image) => getComputedStyle(image).transform),
          'none',
          `${engineName}/${viewportName}: reduced motion transform`,
        );
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });
        const textResizeOverflow = await page.evaluate(() =>
          [...document.querySelectorAll('*')]
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return { element: element.tagName.toLowerCase(), className: element.className, right: rect.right };
            })
            .filter(({ right }) => right > window.innerWidth + 1),
        );
        assert.deepEqual(textResizeOverflow, [], `${engineName}/${viewportName}: 200% text reflow`);
        await page.goto(`${baseUrl}${researchScope}&research=true`, { waitUntil: 'networkidle' });
        await page.getByRole('combobox', { name: 'Research' }).selectOption('true');
        await Promise.all([
          page.waitForURL(/research=true/u),
          page.getByRole('button', { name: 'Show collection' }).click(),
        ]);
        await page.waitForLoadState('networkidle');
        assert.equal(
          (await page.getByText('Research (read-only)').count()) > 0,
          true,
          `${engineName}/${viewportName}: research state`,
        );
        assert.equal(
          await page.getByRole('heading', { name: 'Research (read-only)', level: 3 }).count(),
          1,
          `${engineName}/${viewportName}: selected-edition heading order`,
        );
        assert.equal(
          await page.getByRole('heading', { name: 'Research-only view' }).count(),
          1,
          `${engineName}/${viewportName}: research-only explanation`,
        );
        assert.equal(
          await page.getByRole('progressbar').count(),
          0,
          `${engineName}/${viewportName}: no zero-total progressbar`,
        );
        assert.doesNotMatch(
          await page.locator('main').innerText(),
          /(?:LOCALSET|EDITION):/u,
          `${engineName}/${viewportName}: no opaque IDs in visible UI`,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
          true,
          `${engineName}/${viewportName}: research-only reflow`,
        );
        await page.goto(`${baseUrl}/collection/?localization=unknown`, { waitUntil: 'networkidle' });
        assert.equal(
          await page.getByRole('heading', { name: 'Invalid checklist link' }).count(),
          1,
          `${engineName}/${viewportName}: invalid-link recovery`,
        );
        assert.equal(unexpected.length, 0, `${engineName}/${viewportName}: unexpected network requests`);
        await context.close();
        console.log(`accessibility smoke ok: ${engineName}/${viewportName}`);
      }
    } finally {
      await browser.close();
    }
  }
  assert.deepEqual(violations, [], JSON.stringify(violations, null, 2));
} finally {
  await new Promise((resolveServer) => server.close(resolveServer));
}
