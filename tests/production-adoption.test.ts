import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { validateRuntimeAssetSetDirectory, writeRuntimeAssetSet } from '../scripts/runtime-assets.mjs';

const root = resolve(import.meta.dirname, '..');

test('upgrades a validated pre-integrity rollback shell before publication', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'snoredex-runtime-promotion-'));
  try {
    const lock = JSON.parse(await readFile(resolve(root, 'catalogue.lock.json'), 'utf8'));
    const appRevision = 'a'.repeat(40);
    const runtime = {
      appRevision,
      producerRevision: lock.producerRevision,
      contractVersion: lock.contractVersion,
      catalogueFingerprint: lock.catalogueFingerprint,
      catalogueByteSha256: lock.catalogueByteSha256,
      catalogueByteLength: lock.catalogueByteLength,
      migrationByteSha256: lock.migrationByteSha256,
      migrationByteLength: lock.migrationByteLength,
    };
    const assets = resolve(directory, 'assets');
    const modulePaths = ['app.js', 'snapshot.js', 'migrations.js'];
    await mkdir(resolve(directory, 'collection'), { recursive: true });
    await mkdir(assets, { recursive: true });
    for (const path of modulePaths) await writeFile(resolve(assets, path), `export const path = '${path}';\n`);
    const pointer = await writeRuntimeAssetSet({ assetsRoot: assets, modulePaths, runtime });
    await writeFile(
      resolve(assets, 'module-manifest.json'),
      JSON.stringify({
        schema: 'snoredex-site-module-manifest',
        schemaVersion: '2.0.0',
        appRevision,
        runtimeAssetSet: pointer,
        retainedRuntimeAssetSets: [],
        legacyModules: modulePaths,
      }),
    );
    await writeFile(
      resolve(directory, 'provenance.json'),
      JSON.stringify({
        schema: 'snoredex-site-provenance',
        schemaVersion: '1.0.0',
        appRevision,
        catalogue: {
          mode: 'pinned-snapshot',
          sourceCommit: lock.producerRevision,
          sourceRepository: lock.sourceRepository,
          contractVersion: lock.contractVersion,
          catalogueFingerprint: lock.catalogueFingerprint,
          catalogueByteSha256: lock.catalogueByteSha256,
          catalogueByteLength: lock.catalogueByteLength,
          migrationByteSha256: lock.migrationByteSha256,
          migrationByteLength: lock.migrationByteLength,
          lock,
        },
      }),
    );
    const theme = `document.documentElement.dataset.theme = 'light';\n/* snoredex-app-revision:${appRevision} */\n`;
    const csp = "default-src 'none'; script-src 'self'; style-src 'self'";
    const shell = (prefix: string) =>
      `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><script src="${prefix}theme.js"></script></head><body><script type="module" src="${prefix}assets/${pointer.path}/app.js"></script></body>`;
    await Promise.all([
      writeFile(resolve(directory, 'theme.js'), theme),
      writeFile(resolve(directory, 'collection/theme.js'), theme),
      writeFile(resolve(directory, 'index.html'), shell('')),
      writeFile(resolve(directory, 'collection/index.html'), shell('../')),
    ]);

    const publicationId = 'pages-test-rollback-1';
    const env: NodeJS.ProcessEnv = { ...process.env, SNOREDEX_PUBLICATION_ID: publicationId };
    delete env.SNOREDEX_CURRENT_DEPLOYMENT_PATH;
    delete env.SNOREDEX_PAGE_URL;
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/retain-runtime-assets.mjs'), directory], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const promotedModuleManifest = JSON.parse(await readFile(resolve(assets, 'module-manifest.json'), 'utf8'));
    const promotedProvenance = JSON.parse(await readFile(resolve(directory, 'provenance.json'), 'utf8'));
    const promotedRuntimeManifest = JSON.parse(
      await readFile(resolve(assets, promotedModuleManifest.runtimeAssetSet.path, 'manifest.json'), 'utf8'),
    );
    assert.equal(promotedProvenance.publicationId, publicationId);
    assert.equal(promotedModuleManifest.publicationId, publicationId);
    assert.equal(promotedModuleManifest.runtimeAssetSet.publicationId, publicationId);
    assert.equal(promotedRuntimeManifest.publicationId, publicationId);
    const deploymentResult = spawnSync(
      process.execPath,
      [resolve(root, 'scripts/create-deployment-manifest.mjs'), directory],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...env, SNOREDEX_PAGE_URL: 'https://m4s-ai.github.io/snoredex-checklist/' },
      },
    );
    assert.equal(deploymentResult.status, 0, `${deploymentResult.stdout}${deploymentResult.stderr}`);
    const deployment = JSON.parse(await readFile(resolve(directory, 'deployment.json'), 'utf8'));
    assert.equal(deployment.publicationId, publicationId);
    assert.deepEqual(deployment.runtimeAssetSet, promotedModuleManifest.runtimeAssetSet);
    assert.ok(promotedRuntimeManifest.modules.some((module: { path: string }) => module.path === 'theme.js'));
    assert.equal(await validateRuntimeAssetSetDirectory(assets, promotedModuleManifest.runtimeAssetSet, runtime), true);
    for (const page of ['index.html', 'collection/index.html']) {
      const html = await readFile(resolve(directory, page), 'utf8');
      assert.match(html, /<script type="importmap">\{"integrity":/u);
      assert.match(html, /integrity="sha256-[A-Za-z\d+/]+=*"/u);
      assert.doesNotMatch(html, /src="(?:\.\.\/)?theme\.js"/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('upgrades a transitional pointer whose publication ID predates manifest binding', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'snoredex-runtime-transition-'));
  const oldAssets = await mkdtemp(resolve(tmpdir(), 'snoredex-runtime-old-assets-'));
  const oldSource = await mkdtemp(resolve(tmpdir(), 'snoredex-runtime-old-source-'));
  const originalFetch = globalThis.fetch;
  const originalArgv = [...process.argv];
  const originalEnvironment = { ...process.env };
  try {
    const lock = JSON.parse(await readFile(resolve(root, 'catalogue.lock.json'), 'utf8'));
    const currentRevision = 'a'.repeat(40);
    const previousRevision = 'b'.repeat(40);
    const runtimeFor = (appRevision: string) => ({
      appRevision,
      producerRevision: lock.producerRevision,
      contractVersion: '1.0.0' as const,
      catalogueFingerprint: lock.catalogueFingerprint,
      catalogueByteSha256: lock.catalogueByteSha256,
      catalogueByteLength: lock.catalogueByteLength,
      migrationByteSha256: lock.migrationByteSha256,
      migrationByteLength: lock.migrationByteLength,
    });
    const currentRuntime = runtimeFor(currentRevision);
    const previousRuntime = runtimeFor(previousRevision);
    const modulePaths = ['app.js', 'snapshot.js', 'migrations.js', 'theme.js'];
    for (const path of modulePaths) await writeFile(resolve(oldSource, path), `export const path = '${path}';\n`);
    const writePublishedRuntimeAssetSet = writeRuntimeAssetSet as unknown as (options: {
      assetsRoot: string;
      sourceRoot?: string;
      modulePaths: string[];
      runtime: typeof previousRuntime;
      publicationId?: string;
    }) => Promise<{
      appRevision: string;
      path: string;
      manifestSha256: string;
      manifestByteLength: number;
      publicationId?: string;
    }>;
    const oldPointer = await writePublishedRuntimeAssetSet({
      assetsRoot: oldAssets,
      sourceRoot: oldSource,
      modulePaths,
      runtime: previousRuntime,
      publicationId: undefined,
    });
    const oldManifestBytes = await readFile(resolve(oldAssets, oldPointer.path, 'manifest.json'));
    const oldModuleBytes = new Map(
      await Promise.all(
        modulePaths.map(async (path) => [path, await readFile(resolve(oldAssets, oldPointer.path, path))] as const),
      ),
    );
    const assets = resolve(directory, 'assets');
    await mkdir(assets, { recursive: true });
    for (const path of modulePaths) await writeFile(resolve(assets, path), `export const path = 'current-${path}';\n`);
    const activeLegacyPointer = await writePublishedRuntimeAssetSet({
      assetsRoot: assets,
      modulePaths,
      runtime: currentRuntime,
      publicationId: undefined,
    });
    const activePointer = { ...activeLegacyPointer, publicationId: 'pages-current' };
    await writeFile(
      resolve(assets, 'module-manifest.json'),
      JSON.stringify({
        schema: 'snoredex-site-module-manifest',
        schemaVersion: '2.0.0',
        publicationFormat: 'provenance-history-v1',
        publicationId: 'pages-current',
        appRevision: currentRevision,
        runtimeAssetSet: activePointer,
        retainedRuntimeAssetSets: [],
        legacyModules: modulePaths,
      }),
    );
    await writeFile(
      resolve(directory, 'provenance.json'),
      JSON.stringify({
        schema: 'snoredex-site-provenance',
        schemaVersion: '1.0.0',
        publicationFormat: 'provenance-history-v1',
        publicationId: 'pages-current',
        appRevision: currentRevision,
        catalogue: {
          mode: 'pinned-snapshot',
          sourceCommit: lock.producerRevision,
          sourceRepository: lock.sourceRepository,
          contractVersion: lock.contractVersion,
          catalogueFingerprint: lock.catalogueFingerprint,
          catalogueByteSha256: lock.catalogueByteSha256,
          catalogueByteLength: lock.catalogueByteLength,
          migrationByteSha256: lock.migrationByteSha256,
          migrationByteLength: lock.migrationByteLength,
          lock,
        },
      }),
    );
    const previousPath = resolve(directory, 'previous-deployment.json');
    await writeFile(
      previousPath,
      JSON.stringify({
        schema: 'snoredex-checklist-deployment',
        schemaVersion: '1.0.0',
        pageUrl: 'https://m4s-ai.github.io/snoredex-checklist/',
        publishedAt: '2026-08-30T00:00:00.000Z',
        appRevision: previousRevision,
        producerRevision: lock.producerRevision,
        contractVersion: '1.0.0',
        catalogueFingerprint: lock.catalogueFingerprint,
        catalogueByteSha256: lock.catalogueByteSha256,
        catalogueByteLength: lock.catalogueByteLength,
        migrationByteSha256: lock.migrationByteSha256,
        migrationByteLength: lock.migrationByteLength,
        runtimeAssetSet: { ...oldPointer, publicationId: 'pages-previous' },
        sourceFingerprints: [lock.catalogueFingerprint],
      }),
    );
    globalThis.fetch = (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/manifest.json')) return new Response(oldManifestBytes, { status: 200 });
      const modulePath = path.slice(path.lastIndexOf('/') + 1);
      const bytes = oldModuleBytes.get(modulePath);
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes, { status: 200 });
    }) as typeof fetch;
    process.argv.length = 2;
    process.argv.push(directory);
    process.env = {
      ...process.env,
      SNOREDEX_PAGE_URL: 'https://m4s-ai.github.io/snoredex-checklist/',
      SNOREDEX_PUBLICATION_ID: 'pages-current',
      SNOREDEX_CURRENT_DEPLOYMENT_PATH: previousPath,
    };
    await import(`../scripts/retain-runtime-assets.mjs?transition=${Date.now()}`);
    const moduleManifest = JSON.parse(await readFile(resolve(assets, 'module-manifest.json'), 'utf8'));
    const activeManifest = JSON.parse(
      await readFile(resolve(assets, moduleManifest.runtimeAssetSet.path, 'manifest.json'), 'utf8'),
    );
    const retained = moduleManifest.retainedRuntimeAssetSets[0];
    const retainedManifest = JSON.parse(await readFile(resolve(assets, retained.path, 'manifest.json'), 'utf8'));
    assert.equal(activeManifest.publicationId, 'pages-current');
    assert.equal(retainedManifest.publicationId, 'pages-previous');
    assert.notEqual(retained.manifestSha256, oldPointer.manifestSha256);
    assert.equal(await validateRuntimeAssetSetDirectory(assets, retained, previousRuntime), true);
    const divergentFingerprint = `sha256:${'f'.repeat(64)}`;
    await writeFile(
      previousPath,
      JSON.stringify({
        schema: 'snoredex-checklist-deployment',
        schemaVersion: '1.0.0',
        pageUrl: 'https://m4s-ai.github.io/snoredex-checklist/',
        publishedAt: '2026-08-30T00:00:00.000Z',
        appRevision: previousRevision,
        producerRevision: lock.producerRevision,
        contractVersion: '1.0.0',
        catalogueFingerprint: divergentFingerprint,
        catalogueByteSha256: lock.catalogueByteSha256,
        catalogueByteLength: lock.catalogueByteLength,
        migrationByteSha256: lock.migrationByteSha256,
        migrationByteLength: lock.migrationByteLength,
        runtimeAssetSet: { ...oldPointer, publicationId: 'pages-previous' },
        sourceFingerprints: [divergentFingerprint],
      }),
    );
    await assert.rejects(
      import(`../scripts/retain-runtime-assets.mjs?divergent=${Date.now()}`),
      /RUNTIME_PREVIOUS_MANIFEST_INVALID/u,
    );
    await writeFile(
      previousPath,
      JSON.stringify({
        schema: 'snoredex-checklist-deployment',
        schemaVersion: '1.0.0',
        pageUrl: 'https://m4s-ai.github.io/snoredex-checklist/',
        publishedAt: '2026-08-30T00:00:00.000Z',
        appRevision: currentRevision,
        producerRevision: lock.producerRevision,
        contractVersion: '1.0.0',
        catalogueFingerprint: lock.catalogueFingerprint,
        catalogueByteSha256: lock.catalogueByteSha256,
        catalogueByteLength: lock.catalogueByteLength,
        migrationByteSha256: lock.migrationByteSha256,
        migrationByteLength: lock.migrationByteLength,
        runtimeAssetSet: { ...oldPointer, publicationId: 'pages-previous' },
        sourceFingerprints: [lock.catalogueFingerprint],
      }),
    );
    await assert.rejects(
      import(`../scripts/retain-runtime-assets.mjs?same-revision=${Date.now()}`),
      /RUNTIME_PREVIOUS_POINTER_INVALID/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.argv.length = 0;
    process.argv.push(...originalArgv);
    process.env = originalEnvironment;
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(oldAssets, { recursive: true, force: true }),
      rm(oldSource, { recursive: true, force: true }),
    ]);
  }
});

test('production adoption validates the reviewed target migration without requiring the fixture as a source', async () => {
  const scriptPath = resolve(root, 'scripts/check-production-adoption.mjs');
  const manifestScriptPath = resolve(root, 'scripts/create-deployment-manifest.mjs');
  const smokeScriptPath = resolve(root, 'scripts/smoke-pages.mjs');
  const workflowPath = resolve(root, '.github/workflows/deploy-pages.yml');
  const script = await readFile(scriptPath, 'utf8');
  const manifestScript = await readFile(manifestScriptPath, 'utf8');
  const smokeScript = await readFile(smokeScriptPath, 'utf8');
  const lock = JSON.parse(await readFile(resolve(root, 'catalogue.lock.json'), 'utf8'));
  const workflow = await readFile(workflowPath, 'utf8');
  assert.doesNotMatch(script, /collector-catalogue\.fixture/u);
  assert.match(script, /candidate\?\.toFingerprint === targetFingerprint/u);
  assert.match(script, /sourceFingerprints/u);
  assert.match(manifestScript, /SNOREDEX_CURRENT_DEPLOYMENT_PATH/u);
  assert.match(manifestScript, /sourceFingerprints/);
  assert.match(manifestScript, /manifest\.rollback = \{ \.\.\.rollback, runtimeAssetSet: retained \}/u);
  assert.match(
    manifestScript,
    /rollbackSource && lock\.catalogueFingerprint === rollbackSource\.catalogueFingerprint/u,
  );
  assert.match(workflow, /rollback target must match the exact published recovery tuple/u);
  assert.match(workflow, /consumer_revision lacks recoverable deployment provenance/u);
  assert.match(
    workflow,
    /sameCatalogueDeployment = current\?\.catalogueFingerprint === previous\?\.catalogueFingerprint/u,
  );
  assert.match(workflow, /new Set\(sources\)\.size !== sources\.length \|\|\s+!sameCatalogueDeployment/u);
  assert.match(workflow, /!digest\.test\(current\.catalogueFingerprint \?\? ''\)/u);
  assert.match(workflow, /push:\s+branches:\s+- main/u);
  assert.match(workflow, /name: Trigger independent catalogue intake/u);
  assert.match(workflow, /gh workflow run catalogue-release\.yml --repo "\$GITHUB_REPOSITORY" --ref main/u);
  assert.match(workflow, /actions: write/u);
  assert.doesNotMatch(workflow, /uses: \.\/\.github\/workflows\/catalogue-release\.yml/u);
  assert.match(workflow, /run-name: Deploy Pages \/ \$\{\{/u);
  assert.match(workflow, /group: pages-\$\{\{/u);
  assert.match(workflow, /deployment-lane:/u);
  assert.match(workflow, /automatic adoption deferred while a rollback run is queued or active/u);
  assert.match(workflow, /activeStatuses = new Set\(\['queued', 'in_progress', 'waiting', 'pending'\]\)/u);
  assert.match(workflow, /const isRollbackRun = \(run\) => run\.event === 'workflow_dispatch'/u);
  assert.match(workflow, /const activeRuns = runs\.filter\(\(run\) => !isRollbackRun\(run\)\)/u);
  assert.match(workflow, /\.\.\.currentRuns\(\)\.filter\(\(run\) => !isRollbackRun\(run\)\)/u);
  assert.match(workflow, /needs: deployment-lane/u);
  assert.match(workflow, /if: needs\.deployment-lane\.outputs\.proceed == 'true'/u);
  assert.match(
    workflow,
    /description: Optional full consumer commit SHA \(rollback only; adopt uses the workflow revision\)/u,
  );
  assert.match(workflow, /description: Explicitly authorize first publication when no production manifest exists/u);
  assert.match(workflow, /bootstrap authorization requires workflow_dispatch/u);
  assert.match(workflow, /state=missing/u);
  assert.match(workflow, /provenance_status=.*provenance\.json/u);
  assert.match(workflow, /current production publication evidence exists despite a missing deployment manifest/u);
  assert.match(workflow, /provenance_curl_status/);
  assert.match(
    workflow,
    /SNOREDEX_CURRENT_PROVENANCE_PATH: \$\{\{ steps\.current-production\.outputs\.provenance_path \}\}/u,
  );
  assert.match(
    workflow,
    /SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: \$\{\{ steps\.current-production\.outputs\.module_manifest_path \}\}/u,
  );
  assert.match(script, /SNOREDEX_CURRENT_MODULE_MANIFEST_PATH/u);
  assert.match(manifestScript, /publicationFormat: 'provenance-history-v1'/u);
  assert.match(
    workflow,
    /SNOREDEX_BOOTSTRAP_AUTHORIZED: \$\{\{ steps\.deployment-inputs\.outputs\.bootstrap_authorized \}\}/u,
  );
  assert.match(workflow, /required: false/u);
  assert.match(workflow, /consumer_revision is required for rollback/u);
  assert.match(workflow, /consumer_revision="\$\{CONSUMER_REVISION_INPUT:-\$WORKFLOW_REVISION\}"/u);
  assert.match(
    workflow,
    /git show "\$WORKFLOW_REVISION:scripts\/check-production-adoption\.mjs" > "\$RUNNER_TEMP\/check-production-adoption\.mjs"/u,
  );
  assert.match(workflow, /run: node "\$RUNNER_TEMP\/check-production-adoption\.mjs"/u);
  assert.match(workflow, /SNOREDEX_REPOSITORY_ROOT: \$\{\{ github\.workspace \}\}/u);
  assert.match(workflow, /SNOREDEX_PUBLICATION_ID: pages-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(
    workflow,
    /SNOREDEX_EXPECTED_GITHUB_SHA: \$\{\{ steps\.deployment-inputs\.outputs\.consumer_revision \}\}/u,
  );
  const deployedSmokeStep = workflow.slice(workflow.indexOf('- name: Smoke-test deployed Pages site'));
  assert.match(deployedSmokeStep, /dist\/site\/provenance\.json/u);
  assert.doesNotMatch(deployedSmokeStep, /catalogue\.lock\.json/u);
  assert.match(smokeScript, /readRuntimeAssetSet\(\s*pointer,\s*runtime,\s*getRuntimeBytes,?\s*\)/u);
  assert.match(smokeScript, /readRuntimeAssetSet\(\s*retained\[0\],\s*deployment\.rollback,\s*getRuntimeBytes,?\s*\)/u);
  assert.match(smokeScript, /runtimeShellBindings\(activeRuntimeManifest/u);
  assert.doesNotMatch(workflow, /git merge-base --is-ancestor/u);
  assert.match(
    workflow,
    /name: Require reviewed producer migration target\s+if: steps\.deployment-inputs\.outputs\.deployment_mode == 'adopt' \|\| steps\.deployment-inputs\.outputs\.deployment_mode == 'rollback'/u,
  );

  const run = (currentFingerprint?: string, bootstrapAuthorized = false) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SNOREDEX_DEPLOYMENT_MODE: 'adopt',
      SNOREDEX_BOOTSTRAP_AUTHORIZED: String(bootstrapAuthorized),
    };
    if (currentFingerprint === undefined) delete env.SNOREDEX_CURRENT_CATALOGUE_FINGERPRINT;
    else env.SNOREDEX_CURRENT_CATALOGUE_FINGERPRINT = currentFingerprint;
    return spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8', env });
  };

  const unapprovedBootstrap = run();
  assert.notEqual(unapprovedBootstrap.status, 0);
  assert.match(
    `${unapprovedBootstrap.stdout}${unapprovedBootstrap.stderr}`,
    /PRODUCTION_ADOPTION_BLOCKED_BOOTSTRAP_REQUIRES_AUTHORIZATION/u,
  );

  const initial = run(undefined, true);
  assert.equal(initial.status, 0, `${initial.stdout}${initial.stderr}`);

  const target = 'sha256:c9b59276dadaf321b39ada5d17eaea74c4beecd00f8dc0cae0a46fc37afb8f15';
  const reviewedSourceFingerprint = 'sha256:3298f2574d6b35c9a5f93e6de6189127ee741c1d78aace39d12b67c286b8854f';
  const reviewedSource = run(reviewedSourceFingerprint);
  assert.equal(reviewedSource.status, 0, `${reviewedSource.stdout}${reviewedSource.stderr}`);

  const unchanged = run(target);
  assert.equal(unchanged.status, 0, `${unchanged.stdout}${unchanged.stderr}`);

  const rollbackWithoutDeployment = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SNOREDEX_DEPLOYMENT_MODE: 'rollback' },
  });
  assert.notEqual(rollbackWithoutDeployment.status, 0);
  assert.match(
    `${rollbackWithoutDeployment.stdout}${rollbackWithoutDeployment.stderr}`,
    /PRODUCTION_ADOPTION_BLOCKED_ROLLBACK_REQUIRES_PUBLISHED_DEPLOYMENT/u,
  );

  const unrelated = run(`sha256:${'b'.repeat(64)}`);
  assert.notEqual(unrelated.status, 0);
  assert.match(`${unrelated.stdout}${unrelated.stderr}`, /PRODUCTION_ADOPTION_BLOCKED_MISSING_REVIEWED_TRANSITION/u);

  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'snoredex-adoption-'));
  try {
    const copiedGuardPath = resolve(temporaryDirectory, 'check-production-adoption.mjs');
    await writeFile(copiedGuardPath, script);
    const currentManifestPath = resolve(temporaryDirectory, 'deployment.json');
    const moduleManifestPath = resolve(temporaryDirectory, 'module-manifest.json');
    const previousAppRevision = 'b'.repeat(40);
    const appRevision = 'a'.repeat(40);
    const legacyAppRevision = 'ac8a5c5eb76439d5b024564b694a20447722a2df';
    const runtime = {
      appRevision,
      producerRevision: lock.producerRevision,
      contractVersion: lock.contractVersion,
      catalogueFingerprint: lock.catalogueFingerprint,
      catalogueByteSha256: lock.catalogueByteSha256,
      catalogueByteLength: lock.catalogueByteLength,
      migrationByteSha256: lock.migrationByteSha256,
      migrationByteLength: lock.migrationByteLength,
    };
    const assets = resolve(temporaryDirectory, 'assets');
    await mkdir(assets, { recursive: true });
    for (const path of ['app.js', 'snapshot.js', 'migrations.js']) {
      await writeFile(resolve(assets, path), `export const fixture = '${path}';\n`, 'utf8');
    }
    const activeRuntimeAssetSet = await writeRuntimeAssetSet({
      assetsRoot: assets,
      modulePaths: ['app.js', 'snapshot.js', 'migrations.js'],
      runtime,
    });
    const rollbackRuntimeAssetSet = await writeRuntimeAssetSet({
      assetsRoot: assets,
      modulePaths: ['app.js', 'snapshot.js', 'migrations.js'],
      runtime: { ...runtime, appRevision: previousAppRevision },
    });
    await writeFile(
      resolve(assets, 'module-manifest.json'),
      JSON.stringify({
        schema: 'snoredex-site-module-manifest',
        schemaVersion: '2.0.0',
        appRevision,
        runtimeAssetSet: activeRuntimeAssetSet,
        retainedRuntimeAssetSets: [rollbackRuntimeAssetSet],
        legacyModules: ['app.js', 'snapshot.js', 'migrations.js'],
      }),
      'utf8',
    );
    const previousDeployment = {
      schema: 'snoredex-checklist-deployment',
      schemaVersion: '1.0.0',
      pageUrl: 'https://m4s-ai.github.io/snoredex-checklist/',
      publishedAt: '2026-08-30T00:00:00.000Z',
      appRevision: previousAppRevision,
      producerRevision: lock.producerRevision,
      contractVersion: lock.contractVersion,
      catalogueFingerprint: lock.catalogueFingerprint,
      catalogueByteSha256: lock.catalogueByteSha256,
      catalogueByteLength: lock.catalogueByteLength,
      migrationByteSha256: lock.migrationByteSha256,
      migrationByteLength: lock.migrationByteLength,
      runtimeAssetSet: rollbackRuntimeAssetSet,
      sourceFingerprints: [],
    };
    const provenancePath = resolve(temporaryDirectory, 'provenance.json');
    await writeFile(
      provenancePath,
      JSON.stringify({
        schema: 'snoredex-site-provenance',
        schemaVersion: '1.0.0',
        appRevision,
        catalogue: {
          mode: 'pinned-snapshot',
          sourceCommit: lock.producerRevision,
          sourceRepository: 'https://github.com/m4s-ai/snoredex-data',
          contractVersion: lock.contractVersion,
          catalogueFingerprint: lock.catalogueFingerprint,
          catalogueByteSha256: lock.catalogueByteSha256,
          catalogueByteLength: lock.catalogueByteLength,
          migrationByteSha256: lock.migrationByteSha256,
          migrationByteLength: lock.migrationByteLength,
          lock,
        },
      }),
      'utf8',
    );
    const changedCatalogueDeployment = { ...previousDeployment, catalogueFingerprint: reviewedSourceFingerprint };
    await writeFile(currentManifestPath, JSON.stringify(changedCatalogueDeployment), 'utf8');
    const changedCatalogue = spawnSync(process.execPath, [manifestScriptPath, temporaryDirectory], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_PAGE_URL: 'https://m4s-ai.github.io/snoredex-checklist/',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
      },
    });
    assert.equal(changedCatalogue.status, 0, `${changedCatalogue.stdout}${changedCatalogue.stderr}`);
    const changedCatalogueManifest = JSON.parse(await readFile(resolve(temporaryDirectory, 'deployment.json'), 'utf8'));
    assert.equal(changedCatalogueManifest.rollback, undefined);
    assert.deepEqual(changedCatalogueManifest.sourceFingerprints, [reviewedSourceFingerprint]);

    await writeFile(
      currentManifestPath,
      JSON.stringify({
        ...previousDeployment,
        catalogueFingerprint: reviewedSourceFingerprint,
        sourceFingerprints: [reviewedSourceFingerprint],
      }),
      'utf8',
    );
    const changedWithRecovery = spawnSync(process.execPath, [manifestScriptPath, temporaryDirectory], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_PAGE_URL: 'https://m4s-ai.github.io/snoredex-checklist/',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
      },
    });
    assert.equal(changedWithRecovery.status, 0, `${changedWithRecovery.stdout}${changedWithRecovery.stderr}`);
    const changedWithRecoveryManifest = JSON.parse(
      await readFile(resolve(temporaryDirectory, 'deployment.json'), 'utf8'),
    );
    assert.equal(changedWithRecoveryManifest.rollback, undefined);
    assert.deepEqual(changedWithRecoveryManifest.sourceFingerprints, [reviewedSourceFingerprint]);

    await writeFile(currentManifestPath, JSON.stringify(previousDeployment), 'utf8');
    const generated = spawnSync(process.execPath, [manifestScriptPath, temporaryDirectory], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_PAGE_URL: 'https://m4s-ai.github.io/snoredex-checklist/',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
      },
    });
    assert.equal(generated.status, 0, `${generated.stdout}${generated.stderr}`);
    const generatedDeployment = JSON.parse(await readFile(resolve(temporaryDirectory, 'deployment.json'), 'utf8'));
    assert.deepEqual(generatedDeployment.rollback, {
      appRevision: previousAppRevision,
      producerRevision: lock.producerRevision,
      contractVersion: lock.contractVersion,
      catalogueFingerprint: lock.catalogueFingerprint,
      catalogueByteSha256: lock.catalogueByteSha256,
      catalogueByteLength: lock.catalogueByteLength,
      migrationByteSha256: lock.migrationByteSha256,
      migrationByteLength: lock.migrationByteLength,
      runtimeAssetSet: rollbackRuntimeAssetSet,
    });
    assert.deepEqual(generatedDeployment.sourceFingerprints, [lock.catalogueFingerprint]);
    assert.equal(generatedDeployment.publicationFormat, 'provenance-history-v1');
    const generatedProvenance = JSON.parse(await readFile(provenancePath, 'utf8'));
    assert.deepEqual(generatedProvenance.sourceFingerprints, generatedDeployment.sourceFingerprints);

    await writeFile(
      currentManifestPath,
      JSON.stringify({ ...previousDeployment, sourceFingerprints: [reviewedSourceFingerprint] }),
      'utf8',
    );
    const divergent = spawnSync(process.execPath, [manifestScriptPath, temporaryDirectory], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_PAGE_URL: 'https://m4s-ai.github.io/snoredex-checklist/',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
      },
    });
    assert.equal(divergent.status, 0, `${divergent.stdout}${divergent.stderr}`);
    const divergentDeployment = JSON.parse(await readFile(resolve(temporaryDirectory, 'deployment.json'), 'utf8'));
    assert.deepEqual(divergentDeployment.rollback, {
      appRevision: previousAppRevision,
      producerRevision: lock.producerRevision,
      contractVersion: lock.contractVersion,
      catalogueFingerprint: lock.catalogueFingerprint,
      catalogueByteSha256: lock.catalogueByteSha256,
      catalogueByteLength: lock.catalogueByteLength,
      migrationByteSha256: lock.migrationByteSha256,
      migrationByteLength: lock.migrationByteLength,
      runtimeAssetSet: rollbackRuntimeAssetSet,
    });
    assert.deepEqual(divergentDeployment.sourceFingerprints, [reviewedSourceFingerprint, lock.catalogueFingerprint]);

    const currentDeployment = {
      ...previousDeployment,
      sourceFingerprints: [target, reviewedSourceFingerprint],
      catalogueFingerprint: target,
    };
    type DeploymentFixture = {
      appRevision: string;
      producerRevision: string;
      contractVersion: string;
      catalogueFingerprint: string;
      catalogueByteSha256: string;
      catalogueByteLength: number;
      migrationByteSha256: string;
      migrationByteLength: number;
      sourceFingerprints: string[];
      runtimeAssetSet?: { appRevision: string; path: string; manifestSha256: string; manifestByteLength: number };
      publicationId?: string;
    };
    const provenanceFor = (deployment: DeploymentFixture) => ({
      schema: 'snoredex-site-provenance',
      schemaVersion: '1.0.0',
      publicationId: deployment.publicationId,
      appRevision: deployment.appRevision,
      catalogue: {
        mode: 'pinned-snapshot',
        sourceCommit: deployment.producerRevision,
        sourceRepository: 'https://github.com/m4s-ai/snoredex-data',
        contractVersion: deployment.contractVersion,
        catalogueFingerprint: deployment.catalogueFingerprint,
        catalogueByteSha256: deployment.catalogueByteSha256,
        catalogueByteLength: deployment.catalogueByteLength,
        migrationByteSha256: deployment.migrationByteSha256,
        migrationByteLength: deployment.migrationByteLength,
        lock: {
          ...lock,
          producerRevision: deployment.producerRevision,
          contractVersion: deployment.contractVersion,
          catalogueFingerprint: deployment.catalogueFingerprint,
          catalogueByteSha256: deployment.catalogueByteSha256,
          catalogueByteLength: deployment.catalogueByteLength,
          migrationByteSha256: deployment.migrationByteSha256,
          migrationByteLength: deployment.migrationByteLength,
        },
      },
      sourceFingerprints: [...deployment.sourceFingerprints],
    });
    const moduleManifestFor = (deployment: DeploymentFixture, marked = true) => ({
      schema: 'snoredex-site-module-manifest',
      schemaVersion: '2.0.0',
      ...(marked ? { publicationFormat: 'provenance-history-v1' } : {}),
      publicationId: deployment.publicationId,
      appRevision: deployment.appRevision,
      runtimeAssetSet: deployment.runtimeAssetSet,
    });
    const runAgainstManifest = async (value: string | object) => {
      await writeFile(currentManifestPath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
      if (typeof value !== 'string') {
        await writeFile(provenancePath, JSON.stringify(provenanceFor(value as DeploymentFixture)));
        await writeFile(moduleManifestPath, JSON.stringify(moduleManifestFor(value as DeploymentFixture, false)));
      }
      return spawnSync(process.execPath, [scriptPath], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          SNOREDEX_DEPLOYMENT_MODE: 'adopt',
          SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
          SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
          SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
          SNOREDEX_BOOTSTRAP_AUTHORIZED: 'false',
        },
      });
    };
    const bootstrapWithPublishedProvenance = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
        SNOREDEX_BOOTSTRAP_AUTHORIZED: 'true',
      },
    });
    assert.notEqual(bootstrapWithPublishedProvenance.status, 0);
    assert.match(
      `${bootstrapWithPublishedProvenance.stdout}${bootstrapWithPublishedProvenance.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    const emptyManifest = await runAgainstManifest('');
    assert.notEqual(emptyManifest.status, 0);
    assert.match(
      `${emptyManifest.stdout}${emptyManifest.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    const wrongPage = await runAgainstManifest({ ...currentDeployment, pageUrl: 'https://example.invalid/' });
    assert.notEqual(wrongPage.status, 0);
    assert.match(`${wrongPage.stdout}${wrongPage.stderr}`, /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u);
    const wrongIdentity = await runAgainstManifest({ ...currentDeployment, appRevision: 'invalid' });
    assert.notEqual(wrongIdentity.status, 0);
    assert.match(
      `${wrongIdentity.stdout}${wrongIdentity.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    const inconsistentHistory = await runAgainstManifest({
      ...currentDeployment,
      sourceFingerprints: [target, target],
    });
    assert.notEqual(inconsistentHistory.status, 0);
    assert.match(
      `${inconsistentHistory.stdout}${inconsistentHistory.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    const truncatedHistory = { ...currentDeployment, sourceFingerprints: [] };
    await writeFile(currentManifestPath, JSON.stringify(truncatedHistory), 'utf8');
    await writeFile(provenancePath, JSON.stringify(provenanceFor(currentDeployment)));
    const mismatchedHistory = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.notEqual(mismatchedHistory.status, 0);
    assert.match(
      `${mismatchedHistory.stdout}${mismatchedHistory.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    const modernGeneration = {
      ...currentDeployment,
      publicationFormat: undefined,
      publicationId: 'pages-test-1',
      runtimeAssetSet: { ...currentDeployment.runtimeAssetSet, publicationId: 'pages-test-1' },
      sourceFingerprints: [],
    };
    await writeFile(currentManifestPath, JSON.stringify(modernGeneration));
    await writeFile(
      provenancePath,
      JSON.stringify({ ...provenanceFor(modernGeneration), sourceFingerprints: undefined }),
    );
    await writeFile(moduleManifestPath, JSON.stringify(moduleManifestFor(modernGeneration, false)));
    const modernGenerationWithoutMarkers = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.notEqual(modernGenerationWithoutMarkers.status, 0);
    assert.match(
      `${modernGenerationWithoutMarkers.stdout}${modernGenerationWithoutMarkers.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    await writeFile(currentManifestPath, JSON.stringify(currentDeployment));
    await writeFile(provenancePath, JSON.stringify(provenanceFor(currentDeployment)));
    await writeFile(moduleManifestPath, JSON.stringify(moduleManifestFor(currentDeployment, false)));
    const legacyDeployment = {
      ...currentDeployment,
      appRevision: legacyAppRevision,
      runtimeAssetSet: {
        ...currentDeployment.runtimeAssetSet,
        appRevision: legacyAppRevision,
        path: `runtime/${legacyAppRevision}`,
      },
    };
    await writeFile(currentManifestPath, JSON.stringify(legacyDeployment));
    await writeFile(moduleManifestPath, JSON.stringify(moduleManifestFor(legacyDeployment, false)));
    await writeFile(
      provenancePath,
      JSON.stringify({ ...provenanceFor(legacyDeployment), sourceFingerprints: undefined }),
    );
    const legacyProvenance = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.equal(legacyProvenance.status, 0, `${legacyProvenance.stdout}${legacyProvenance.stderr}`);
    await writeFile(
      moduleManifestPath,
      JSON.stringify({
        ...moduleManifestFor(legacyDeployment, false),
        runtimeAssetSet: { ...legacyDeployment.runtimeAssetSet, manifestSha256: `sha256:${'d'.repeat(64)}` },
      }),
    );
    const staleLegacyModule = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.notEqual(staleLegacyModule.status, 0);
    assert.match(
      `${staleLegacyModule.stdout}${staleLegacyModule.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    await writeFile(moduleManifestPath, JSON.stringify(moduleManifestFor(legacyDeployment, false)));
    await writeFile(
      moduleManifestPath,
      JSON.stringify({ ...moduleManifestFor(legacyDeployment, false), appRevision: currentDeployment.appRevision }),
    );
    const mixedLegacyPublication = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.notEqual(mixedLegacyPublication.status, 0);
    assert.match(
      `${mixedLegacyPublication.stdout}${mixedLegacyPublication.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    await writeFile(moduleManifestPath, JSON.stringify(moduleManifestFor(legacyDeployment, false)));
    const postUpgradeDeployment = {
      ...currentDeployment,
      appRevision: '934acd3d5d29202b728e164584749d0675666b463',
      publicationFormat: 'provenance-history-v1',
      runtimeAssetSet: {
        ...currentDeployment.runtimeAssetSet,
        appRevision: '934acd3d5d29202b728e164584749d0675666b463',
        path: 'runtime/934acd3d5d29202b728e164584749d0675666b463',
      },
    };
    await writeFile(currentManifestPath, JSON.stringify(postUpgradeDeployment));
    await writeFile(
      provenancePath,
      JSON.stringify({ ...provenanceFor(postUpgradeDeployment), sourceFingerprints: undefined }),
    );
    const postUpgradeMissingHistory = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.notEqual(postUpgradeMissingHistory.status, 0);
    assert.match(
      `${postUpgradeMissingHistory.stdout}${postUpgradeMissingHistory.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    const rollbackWithLegacyRevision = { ...legacyDeployment, publicationFormat: 'provenance-history-v1' };
    await writeFile(currentManifestPath, JSON.stringify(rollbackWithLegacyRevision));
    await writeFile(
      provenancePath,
      JSON.stringify({ ...provenanceFor(rollbackWithLegacyRevision), sourceFingerprints: undefined }),
    );
    const markedLegacyMissingHistory = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.notEqual(markedLegacyMissingHistory.status, 0);
    assert.match(
      `${markedLegacyMissingHistory.stdout}${markedLegacyMissingHistory.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    await writeFile(moduleManifestPath, JSON.stringify(moduleManifestFor(currentDeployment, false)));
    await writeFile(
      currentManifestPath,
      JSON.stringify({ ...currentDeployment, catalogueFingerprint: reviewedSourceFingerprint }),
      'utf8',
    );
    await writeFile(provenancePath, JSON.stringify(provenanceFor(currentDeployment)));
    const mismatchedTuple = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.notEqual(mismatchedTuple.status, 0);
    assert.match(
      `${mismatchedTuple.stdout}${mismatchedTuple.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    await writeFile(currentManifestPath, JSON.stringify(currentDeployment), 'utf8');
    await writeFile(provenancePath, JSON.stringify(provenanceFor(currentDeployment)));
    const rollback = spawnSync(process.execPath, [copiedGuardPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'rollback',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
        SNOREDEX_REPOSITORY_ROOT: root,
      },
    });
    assert.equal(rollback.status, 0, `${rollback.stdout}${rollback.stderr}`);

    await writeFile(currentManifestPath, JSON.stringify({ ...currentDeployment, sourceFingerprints: [] }));
    const rollbackWithTruncatedHistory = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'rollback',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.notEqual(rollbackWithTruncatedHistory.status, 0);
    assert.match(
      `${rollbackWithTruncatedHistory.stdout}${rollbackWithTruncatedHistory.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_INVALID_CURRENT_DEPLOYMENT/u,
    );
    await writeFile(currentManifestPath, JSON.stringify(currentDeployment), 'utf8');

    const fromBothSources = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.equal(fromBothSources.status, 0, `${fromBothSources.stdout}${fromBothSources.stderr}`);

    const emptyRecoveryDeployment = {
      ...currentDeployment,
      sourceFingerprints: [],
      catalogueFingerprint: reviewedSourceFingerprint,
    };
    await writeFile(currentManifestPath, JSON.stringify(emptyRecoveryDeployment), 'utf8');
    await writeFile(provenancePath, JSON.stringify(provenanceFor(emptyRecoveryDeployment)));
    const fromEmptyRecoverySet = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.equal(fromEmptyRecoverySet.status, 0, `${fromEmptyRecoverySet.stdout}${fromEmptyRecoverySet.stderr}`);

    const missingSourceDeployment = {
      ...currentDeployment,
      sourceFingerprints: [target, `sha256:${'b'.repeat(64)}`],
      catalogueFingerprint: target,
    };
    await writeFile(currentManifestPath, JSON.stringify(missingSourceDeployment), 'utf8');
    await writeFile(provenancePath, JSON.stringify(provenanceFor(missingSourceDeployment)));
    const missingSourceRoute = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SNOREDEX_DEPLOYMENT_MODE: 'adopt',
        SNOREDEX_CURRENT_DEPLOYMENT_PATH: currentManifestPath,
        SNOREDEX_CURRENT_PROVENANCE_PATH: provenancePath,
        SNOREDEX_CURRENT_MODULE_MANIFEST_PATH: moduleManifestPath,
      },
    });
    assert.notEqual(missingSourceRoute.status, 0);
    assert.match(
      `${missingSourceRoute.stdout}${missingSourceRoute.stderr}`,
      /PRODUCTION_ADOPTION_BLOCKED_MISSING_REVIEWED_TRANSITION/u,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
