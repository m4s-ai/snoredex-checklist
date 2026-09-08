import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CatalogueSnapshot } from '../src/site/catalogue.ts';
import { matchesResearch } from '../src/site/filter.ts';
import { buildCatalogueResult, prepareCatalogueResults } from '../src/site/results.ts';
import type { QueryCriteria } from '../src/site/query.ts';

// Compare public result computation only; these are not browser or hosted timings.
const baseline = process.argv[2];
if (!baseline || !/^[0-9a-f]{40}$/u.test(baseline)) throw new Error('FULL_BASELINE_REVISION_REQUIRED');
const directory = await mkdtemp(join(tmpdir(), 'snoredex-results-'));
try {
  const oldFile = join(directory, 'results.ts');
  await writeFile(oldFile, execFileSync('git', ['show', `${baseline}:src/site/results.ts`]));
  const old = (await import(pathToFileURL(oldFile).href)) as typeof import('../src/site/results.ts');
  const catalogue = JSON.parse(
    await readFile('vendor/snoredex-data/collector_catalogue.json', 'utf8'),
  ) as CatalogueSnapshot;
  const start = performance.now();
  const prepared = prepareCatalogueResults(catalogue);
  const preparationMs = performance.now() - start;
  const criteria: QueryCriteria[] = [
    {},
    { q: Array(12).fill('Snorlax').join(' ') },
    { q: 'Pokémon reverse-holo' },
    { research: 'true' },
    { research: 'false' },
    { status: 'need' },
    ...catalogue.localizations.map(({ localizationId }) => ({ localization: localizationId })),
    ...catalogue.setEditions.map(({ setEditionId }) => ({ edition: setEditionId })),
  ];
  for (const query of criteria) {
    const actual = buildCatalogueResult(query, prepared, matchesResearch);
    const expected = old.buildResultViewModel(query, catalogue, matchesResearch);
    assert.deepEqual(actual, { ...expected, groups: old.buildBrowseHierarchy(query, catalogue, matchesResearch) });
  }
  const median = (run: () => unknown): number => {
    for (let i = 0; i < 5; i++) run();
    const samples = Array.from({ length: 30 }, () => {
      const start = performance.now();
      run();
      return performance.now() - start;
    }).sort((a, b) => a - b);
    return samples[15]!;
  };
  const measurements = criteria.slice(0, 2).map((query) => ({
    query,
    beforeMs: median(() => {
      old.buildResultViewModel(query, catalogue, matchesResearch);
      old.buildBrowseHierarchy(query, catalogue, matchesResearch);
    }),
    afterMs: median(() => buildCatalogueResult(query, prepared, matchesResearch)),
  }));
  console.log(
    JSON.stringify(
      {
        baseline,
        node: process.version,
        fingerprint: catalogue.meta.catalogueFingerprint,
        items: catalogue.items.length,
        comparedViews: criteria.length,
        preparationMs,
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
