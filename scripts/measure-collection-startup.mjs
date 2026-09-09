import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { parseArtifactHtml } from './artifact-html.mjs';
import { artifactIdentity } from './browser-gates.mjs';

// Fresh, synthetic-only browser contexts. Never attach to a user's browser.
const root = resolve(process.argv[2] ?? 'dist/site');
const hosted = process.argv[3];
const repetitions = Number(process.env.SNOREDEX_MEASURE_SAMPLES ?? 3);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
const provenance = JSON.parse(await readFile(resolve(root, 'provenance.json'), 'utf8'));
const identity = await artifactIdentity(root, provenance.appRevision);
if (hosted) {
  const response = await fetch(new URL('provenance.json', hosted));
  assert.ok(response.ok);
  const deployed = await response.json();
  assert.equal(deployed.appRevision, provenance.appRevision);
  assert.deepEqual(deployed.catalogue, provenance.catalogue);
}
const profile = { cpuRate: 4, latencyMs: 150, downloadBytesPerSecond: 200000, uploadBytesPerSecond: 93750 };
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
let variant = 'baseline';
const files = new Map();
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(root, `.${pathname}${pathname.endsWith('/') ? 'index.html' : ''}`);
    assert.ok(file.startsWith(`${root}${sep}`));
    const key = `${variant}:${file}`;
    if (!files.has(key)) {
      let bytes = await readFile(file);
      if (pathname === '/collection/') {
        const html = bytes.toString('utf8');
        const { activeElements } = parseArtifactHtml(html);
        const preloads = activeElements.filter(
          (node) =>
            node.tagName === 'link' && node.attrs.some((attr) => attr.name === 'rel' && attr.value === 'modulepreload'),
        );
        if (variant === 'baseline') {
          let stripped = html;
          for (const node of preloads.sort(
            (a, b) => b.sourceCodeLocation.startOffset - a.sourceCodeLocation.startOffset,
          )) {
            const { startOffset, endOffset } = node.sourceCodeLocation;
            stripped = stripped.slice(0, startOffset) + stripped.slice(endOffset);
          }
          bytes = Buffer.from(stripped);
        } else assert.equal(preloads.length, 4, 'Build the preload candidate before measuring');
      }
      files.set(key, gzipSync(bytes));
    }
    response
      .writeHead(200, {
        'content-type': mime[extname(file)] ?? 'application/octet-stream',
        'content-encoding': 'gzip',
        'cache-control': 'public, max-age=3600',
      })
      .end(files.get(key));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const local = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const results = [];
try {
  for (let sample = 0; sample < repetitions; sample++) {
    // Alternate local order to reduce systematic warm-host bias.
    const variants = sample % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    if (hosted) variants.push('hosted');
    for (variant of variants) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      await page.addInitScript(() => {
        const observer = new MutationObserver(() => {
          if (!document.querySelector('[data-item-id] .status-controls input:enabled')) return;
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => performance.mark('first-usable-row')));
        });
        observer.observe(document, { childList: true, subtree: true });
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.clearBrowserCache');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: profile.latencyMs,
        downloadThroughput: profile.downloadBytesPerSecond,
        uploadThroughput: profile.uploadBytesPerSecond,
        connectionType: 'cellular4g',
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuRate });
      await cdp.send('Performance.enable');
      await cdp.send('Profiler.enable');
      const failures = [];
      page.on('pageerror', (error) => failures.push(error.message));
      for (const cache of ['cold', 'warm']) {
        const traceMs = {};
        const trace = ({ value }) => {
          for (const event of value) {
            if (event.ph === 'X' && /compile|parse|EvaluateScript|evaluateModule/iu.test(event.name)) {
              traceMs[event.name] = (traceMs[event.name] ?? 0) + event.dur / 1000;
            }
          }
        };
        cdp.on('Tracing.dataCollected', trace);
        await cdp.send('Tracing.start', { categories: 'v8,devtools.timeline', transferMode: 'ReportEvents' });
        await cdp.send('Profiler.start');
        await page.goto(new URL('collection/?research=false', variant === 'hosted' ? hosted : local).href, {
          waitUntil: 'commit',
        });
        await page.waitForFunction(() => performance.getEntriesByName('first-usable-row').length === 1);
        const firstUsableRowMs = await page.evaluate(
          () => performance.getEntriesByName('first-usable-row')[0].startTime,
        );
        await page.waitForLoadState('networkidle');
        assert.equal(
          await page.locator('meta[name="snoredex-app-revision"]').getAttribute('content'),
          provenance.appRevision,
        );
        assert.deepEqual(failures, []);
        const { profile: samples } = await cdp.send('Profiler.stop');
        const traceDone = new Promise((done) => cdp.once('Tracing.tracingComplete', done));
        await cdp.send('Tracing.end');
        await traceDone;
        cdp.off('Tracing.dataCollected', trace);
        const { metrics } = await cdp.send('Performance.getMetrics');
        const parents = new Map();
        const nodes = new Map(samples.nodes.map((node) => [node.id, node]));
        for (const node of samples.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
        const sampledMs = {};
        for (let i = 0; i < samples.samples.length; i++) {
          let id = samples.samples[i];
          const leaf = nodes.get(id).callFrame;
          let category = leaf.functionName === '(idle)' ? 'idle' : 'other';
          while (id !== undefined) {
            const frame = nodes.get(id).callFrame;
            const name = frame.functionName;
            if (name === 'validateSnapshot') {
              category = 'catalogueValidation';
              break;
            }
            if (name === 'prepareCatalogueResults' || name === 'buildCatalogueResult') {
              category = 'resultPreparation';
              break;
            }
            if (
              name === 'readPrivateState' ||
              name === 'createCollectionStateController' ||
              frame.url.includes('/state/')
            ) {
              category = 'privateState';
              break;
            }
            if (frame.url.endsWith('/migrations.js')) {
              category = 'migrationEvaluation';
              break;
            }
            if (name.startsWith('render') || name === 'text') {
              category = 'rendering';
              break;
            }
            id = parents.get(id);
          }
          sampledMs[category] = (sampledMs[category] ?? 0) + samples.timeDeltas[i] / 1000;
        }
        const resources = await page.evaluate(() =>
          [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')].map((r) => ({
            path: new URL(r.name).pathname.replace(/\/runtime\/[a-f0-9]{40}\//u, '/runtime/'),
            initiator: r.initiatorType,
            encoded: r.encodedBodySize,
            decoded: r.decodedBodySize,
            transfer: r.transferSize,
            startMs: r.startTime,
            endMs: r.responseEnd,
          })),
        );
        const row = {
          sample,
          variant,
          cache,
          firstUsableRowMs,
          sampledMs,
          metrics: Object.fromEntries(
            metrics
              .filter((m) =>
                [
                  'ScriptDuration',
                  'TaskDuration',
                  'LayoutDuration',
                  'RecalcStyleDuration',
                  'V8CompileDuration',
                ].includes(m.name),
              )
              .map((m) => [m.name, m.value * 1000]),
          ),
          resources,
        };
        row.traceMs = traceMs;
        results.push(row);
        console.error(`${variant} ${cache} ${sample + 1}: ${Math.round(firstUsableRowMs)}ms`);
      }
      await context.close();
    }
  }
  assert.deepEqual(
    await artifactIdentity(root, provenance.appRevision),
    identity,
    'Artifact changed during measurement',
  );
  console.log(
    JSON.stringify(
      {
        appRevision: provenance.appRevision,
        catalogue: provenance.catalogue,
        browser: browser.version(),
        platform: process.platform,
        profile,
        repetitions,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
