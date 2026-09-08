import assert from 'node:assert/strict';
import { parseArtifactHtml, hasActiveCsp } from '../scripts/artifact-html.mjs';

export async function assertArtifactHtmlBrowserBoundary(browser, baseUrl, engine) {
  const csp = "default-src 'none'; script-src 'self'";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const cases = [
    `<head><!-- <!--> <head>${meta}</head> --></head>`,
    `<template><script src="theme.js"><!--<script>--></script></template><head>${meta}</head></script></template>`,
    `<head>${meta}</head><frameset><xmp><script src="/outside.js"></script>`,
  ];
  for (const html of cases) {
    const page = await browser.newPage();
    const scripts = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(request.url());
    });
    await page.route(`${baseUrl}/parser-boundary`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
    try {
      await page.goto(`${baseUrl}/parser-boundary`, { waitUntil: 'networkidle' });
      assert.equal(hasActiveCsp(parseArtifactHtml(html).activeElements, csp), true);
      assert.equal(await page.locator('head meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), csp);
      assert.deepEqual(scripts, [], `${engine}: discarded/inert script tokens never request code`);
      assert.equal(
        await page.evaluate(() => {
          const script = document.createElement('script');
          script.textContent = 'window.syntheticCspProbe = true';
          document.head.append(script);
          return window.syntheticCspProbe === true;
        }),
        false,
        `${engine}: parser-recognized head CSP actually blocks inline execution`,
      );
    } finally {
      await page.close();
    }
  }
}
