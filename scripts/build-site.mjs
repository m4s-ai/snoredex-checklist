import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { replaceOutput } from './site-output.ts';
import { buildValidatedSourceMembershipIndex } from './migration-membership.ts';
import {
  runtimeShellBindings,
  runtimeTupleFromProvenance,
  validateRuntimeAssetSetDirectory,
  writeRuntimeAssetSet,
} from './runtime-assets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.argv[2] === '--out-dir' ? process.argv[3] : 'dist/site');
const fontAssets = [
  {
    name: 'nunito-sans-latin-400-normal.woff2',
    byteLength: 13892,
    sha256: 'd9976dd1dc9c0d65046b52810e7cc69cfc229ee9939628ffe637e17efe4ef1ed',
  },
  {
    name: 'nunito-sans-latin-500-normal.woff2',
    byteLength: 13968,
    sha256: '48dded5f1bd76377af9bd7da7da1433080e275bb26a81f1c1ae0dce3564d3f52',
  },
];
const validator = await import(pathToFileURL(resolve(root, 'src/catalogue/validate.ts')));
const sync = await import(pathToFileURL(resolve(root, 'src/catalogue/sync.ts')));
const committed = await sync.readCommittedCataloguePair(root);
let catalogue;
let provenance;
if (committed.ok) {
  try {
    catalogue = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(committed.bytes));
  } catch {
    throw new Error('BUILD_CATALOGUE_PAIR_INVALID');
  }
  provenance = {
    mode: 'pinned-snapshot',
    sourceCommit: committed.lock.producerRevision,
    contractVersion: committed.lock.contractVersion,
    sourceRepository: committed.lock.sourceRepository,
    catalogueFingerprint: committed.lock.catalogueFingerprint,
    catalogueByteSha256: committed.lock.catalogueByteSha256,
    catalogueByteLength: committed.lock.catalogueByteLength,
    lock: committed.lock,
  };
} else {
  throw new Error(`BUILD_CATALOGUE_PAIR_INVALID: ${committed.code}`);
}
const validated = validator.validateCatalogue(catalogue);
if (!validated.ok) throw new Error(`catalogue rejected: ${validated.errors.join(', ')}`);

const migrationPath = resolve(root, 'vendor/snoredex-data/collector_migrations.json');
const migrationBytes = await readFile(migrationPath);
const migrationDigest = `sha256:${createHash('sha256').update(migrationBytes).digest('hex')}`;
const expectedMigrationDigest = committed.lock.migrationByteSha256;
const expectedMigrationLength = committed.lock.migrationByteLength;
if (
  typeof committed.lock.migrationArtifactUrl !== 'string' ||
  !committed.lock.migrationArtifactUrl.endsWith('/collector_migrations.json') ||
  migrationBytes.byteLength !== expectedMigrationLength ||
  migrationDigest !== expectedMigrationDigest
) {
  throw new Error('BUILD_MIGRATION_ARTIFACT_DIGEST_MISMATCH');
}
let migrationManifest;
try {
  migrationManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(migrationBytes));
} catch {
  throw new Error('BUILD_MIGRATION_ARTIFACT_INVALID');
}
if (
  migrationManifest?.meta?.toFingerprint !== committed.lock.catalogueFingerprint ||
  migrationManifest?.meta?.schemaVersion !== '1.1.0' ||
  !Array.isArray(migrationManifest?.catalogueTransitions) ||
  migrationManifest.catalogueTransitions.length === 0
) {
  throw new Error('BUILD_MIGRATION_ARTIFACT_INVALID');
}

const staging = `${output}.staging-${process.pid}`;
const previous = `${output}.previous-${process.pid}`;
const requestedAppRevision = process.env.SNOREDEX_APP_REVISION ?? process.env.GITHUB_SHA;
const gitResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const gitRevision = requestedAppRevision ?? (gitResult.status === 0 ? gitResult.stdout.trim() : '');
if (!/^[0-9a-f]{40}$/u.test(gitRevision)) throw new Error('BUILD_APP_REVISION_INVALID');
provenance.appRevision = gitRevision;
async function copyRevisionShell(source, destination, replacements = {}) {
  const shell = await readFile(source, 'utf8');
  if (!shell.includes('__SNOREDEX_APP_REVISION__')) throw new Error('BUILD_APP_REVISION_MARKER_MISSING');
  let rendered = shell.replaceAll('__SNOREDEX_APP_REVISION__', gitRevision);
  for (const [marker, value] of Object.entries(replacements)) {
    if (!rendered.includes(marker)) throw new Error('BUILD_SHELL_MARKER_MISSING');
    rendered = rendered.replaceAll(marker, value);
  }
  await writeFile(destination, rendered, 'utf8');
}
async function copyRevisionScript(source, destination) {
  const script = await readFile(source, 'utf8');
  await writeFile(destination, `${script}\n/* snoredex-app-revision:${gitRevision} */\n`, 'utf8');
}
async function copyRevisionStylesheet(source, destination) {
  const stylesheet = await readFile(source, 'utf8');
  await writeFile(destination, `${stylesheet}\n/* snoredex-app-revision:${gitRevision} */\n`, 'utf8');
}
async function copyRevisionGuide(source, destination) {
  const guide = await readFile(source, 'utf8');
  await writeFile(destination, `${guide}\n<!-- snoredex-app-revision:${gitRevision} -->\n`, 'utf8');
}
async function stampJavascriptAssets(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await stampJavascriptAssets(target, relativePath)));
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      const source = await readFile(target, 'utf8');
      await writeFile(target, `${source}\n/* snoredex-app-revision:${gitRevision} */\n`, 'utf8');
      paths.push(relativePath);
    }
  }
  return paths;
}
const assets = resolve(staging, 'assets');
await rm(staging, { recursive: true, force: true });
await rm(previous, { recursive: true, force: true });
try {
  await mkdir(assets, { recursive: true });
  for (const font of fontAssets) {
    const source = resolve(root, 'site-src/assets/fonts', font.name);
    const bytes = await readFile(source);
    if (bytes.byteLength !== font.byteLength || createHash('sha256').update(bytes).digest('hex') !== font.sha256) {
      throw new Error(`site font digest mismatch for ${font.name}`);
    }
    const destination = resolve(assets, 'fonts', font.name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
  const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', resolve(root, 'tsconfig.site.json'), '--outDir', assets], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`site TypeScript build failed with status ${result.status ?? 'unknown'}`);
  const stateResult = spawnSync(
    process.execPath,
    [tsc, '-p', resolve(root, 'tsconfig.site-state.json'), '--outDir', resolve(assets, 'state')],
    { cwd: root, stdio: 'inherit' },
  );
  if (stateResult.status !== 0)
    throw new Error(`browser state read API build failed with status ${stateResult.status ?? 'unknown'}`);
  await cp(resolve(root, 'site-src/theme.js'), resolve(assets, 'theme.js'));
  const siteAssets = await import(pathToFileURL(resolve(assets, 'assets.js')));
  const placeholderAssets = Object.values(siteAssets.PLACEHOLDER_ASSETS ?? {});
  if (placeholderAssets.length === 0) throw new Error('site image manifest has no placeholders');
  const imageManifest = [];
  for (const asset of placeholderAssets) {
    if (
      typeof asset.path !== 'string' ||
      !asset.path.startsWith('images/') ||
      asset.path.includes('..') ||
      asset.path.includes('\\') ||
      asset.path.includes('//') ||
      asset.placeholder !== true ||
      asset.mimeType !== 'image/svg+xml' ||
      !['exact-printing', 'card-release'].includes(asset.imageScope) ||
      typeof asset.altTextBasis !== 'string' ||
      !asset.attribution ||
      asset.attribution.rightsStatus !== 'project-authored-placeholder' ||
      asset.attribution.licenceRef !== 'LICENSE.md' ||
      asset.attribution.noticeRef !== 'THIRD_PARTY_NOTICES.md'
    ) {
      throw new Error(`unsafe site image path for ${asset.assetId}`);
    }
    const source = resolve(root, 'site-src/assets', asset.path);
    const bytes = await readFile(source);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== asset.sha256) throw new Error(`site image digest mismatch for ${asset.assetId}`);
    const destination = resolve(assets, asset.path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    imageManifest.push(asset);
  }
  await writeFile(
    resolve(assets, 'image-manifest.json'),
    `${JSON.stringify(
      {
        schema: 'snoredex-site-image-manifest',
        schemaVersion: '1.0.0',
        assets: imageManifest,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await writeFile(
    resolve(assets, 'snapshot.js'),
    `export const provenance = Object.freeze(${JSON.stringify(provenance)});\nexport default Object.freeze(${JSON.stringify(catalogue)});\n`,
    'utf8',
  );
  const directorySnapshot = {
    meta: {
      schema: catalogue.meta.schema,
      schemaVersion: catalogue.meta.schemaVersion,
      catalogueFingerprint: catalogue.meta.catalogueFingerprint,
      sourceRepository: catalogue.meta.sourceRepository,
      dataAsOf: catalogue.meta.dataAsOf,
    },
    localizations: catalogue.localizations,
  };
  const directoryModule = await import(pathToFileURL(resolve(assets, 'directory.js')));
  const directoryProjectionSha256 = await directoryModule.directoryProjectionDigest(directorySnapshot);
  if (typeof directoryProjectionSha256 !== 'string') throw new Error('site directory digest failed');
  const directoryEnvelopeSha256 = await directoryModule.directoryEnvelopeDigest(directorySnapshot, provenance);
  if (typeof directoryEnvelopeSha256 !== 'string') throw new Error('site directory envelope digest failed');
  await writeFile(
    resolve(assets, 'directory-snapshot.js'),
    `export const provenance = Object.freeze(${JSON.stringify(provenance)});\nexport default Object.freeze(${JSON.stringify(directorySnapshot)});\n`,
    'utf8',
  );
  const catalogueTransitions = migrationManifest.catalogueTransitions;
  const knownSourceIdsByFingerprint = buildValidatedSourceMembershipIndex(migrationManifest, catalogue);
  const serializedKnownSourceIdsByFingerprint = [...knownSourceIdsByFingerprint.entries()].map(
    ([fingerprint, itemIds]) => [fingerprint, [...itemIds]],
  );
  await writeFile(
    resolve(assets, 'migrations.js'),
    `export const migrationManifest = Object.freeze(${JSON.stringify({ catalogueTransitions })});\nexport const knownSourceItemIdsByFingerprint = new Map(${JSON.stringify(serializedKnownSourceIdsByFingerprint)}.map(([fingerprint, itemIds]) => [fingerprint, new Set(itemIds)]));\nexport const runtimeIdentity = Object.freeze(${JSON.stringify({ appRevision: gitRevision, catalogueFingerprint: catalogue.meta.catalogueFingerprint, migrationByteSha256: migrationDigest, migrationByteLength: migrationBytes.byteLength })});\n`,
    'utf8',
  );
  const javascriptModules = await stampJavascriptAssets(assets);
  const runtime = runtimeTupleFromProvenance({
    schema: 'snoredex-site-provenance',
    schemaVersion: '1.0.0',
    appRevision: gitRevision,
    catalogue: {
      mode: provenance.mode,
      sourceCommit: provenance.sourceCommit,
      sourceRepository: provenance.sourceRepository,
      contractVersion: provenance.contractVersion,
      catalogueFingerprint: catalogue.meta.catalogueFingerprint,
      catalogueByteSha256: provenance.catalogueByteSha256,
      catalogueByteLength: provenance.catalogueByteLength,
      lock: provenance.lock,
    },
  });
  const runtimeAssetSet = await writeRuntimeAssetSet({
    assetsRoot: assets,
    modulePaths: javascriptModules,
    runtime,
  });
  const runtimeManifest = JSON.parse(await readFile(resolve(assets, runtimeAssetSet.path, 'manifest.json'), 'utf8'));
  await writeFile(
    resolve(assets, 'module-manifest.json'),
    `${JSON.stringify(
      {
        schema: 'snoredex-site-module-manifest',
        schemaVersion: '2.0.0',
        appRevision: gitRevision,
        runtimeAssetSet,
        retainedRuntimeAssetSets: [],
        legacyModules: javascriptModules,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    resolve(staging, 'provenance.json'),
    `${JSON.stringify(
      {
        schema: 'snoredex-site-provenance',
        schemaVersion: '1.0.0',
        appRevision: gitRevision,
        catalogue: {
          mode: provenance.mode,
          sourceCommit: provenance.sourceCommit,
          sourceRepository: provenance.sourceRepository,
          contractVersion: provenance.contractVersion,
          catalogueFingerprint: catalogue.meta.catalogueFingerprint,
          catalogueByteSha256: provenance.catalogueByteSha256 ?? null,
          catalogueByteLength: provenance.catalogueByteLength ?? null,
          migrationByteSha256: migrationDigest,
          migrationByteLength: migrationBytes.byteLength,
          lock: provenance.lock,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const catalogueModule = await import(pathToFileURL(resolve(assets, 'catalogue.js')));
  const snapshotModule = await import(pathToFileURL(resolve(assets, 'snapshot.js')));
  const directorySnapshotModule = await import(pathToFileURL(resolve(assets, 'directory-snapshot.js')));
  if (!(await catalogueModule.validateSnapshot(snapshotModule.default)).ok)
    throw new Error('site snapshot failed browser boundary validation');
  if (
    !(await directoryModule.validateDirectorySnapshot(directorySnapshotModule.default, directoryProjectionSha256)) ||
    !catalogueModule.validateProvenance(directorySnapshotModule.provenance, directorySnapshotModule.default)
  ) {
    throw new Error('site directory snapshot failed browser boundary validation');
  }
  if (!(await validateRuntimeAssetSetDirectory(assets, runtimeAssetSet, runtime))) {
    throw new Error('site runtime asset set failed validation');
  }

  const homeBindings = runtimeShellBindings(runtimeManifest, `assets/${runtimeAssetSet.path}/`);
  const collectionBindings = runtimeShellBindings(runtimeManifest, `../assets/${runtimeAssetSet.path}/`);
  await copyRevisionShell(resolve(root, 'site-src/index.html'), resolve(staging, 'index.html'), {
    __SNOREDEX_DIRECTORY_SHA256__: directoryEnvelopeSha256,
    __SNOREDEX_RUNTIME_IMPORT_MAP__: homeBindings.importMap,
    __SNOREDEX_IMPORT_MAP_CSP__: homeBindings.importMapCsp,
    __SNOREDEX_APP_INTEGRITY__: homeBindings.appIntegrity,
    __SNOREDEX_THEME_INTEGRITY__: homeBindings.themeIntegrity,
  });
  await cp(resolve(assets, 'theme.js'), resolve(staging, 'theme.js'));
  await mkdir(resolve(staging, 'collection'), { recursive: true });
  await copyRevisionShell(resolve(root, 'site-src/collection/index.html'), resolve(staging, 'collection/index.html'), {
    __SNOREDEX_RUNTIME_IMPORT_MAP__: collectionBindings.importMap,
    __SNOREDEX_IMPORT_MAP_CSP__: collectionBindings.importMapCsp,
    __SNOREDEX_APP_INTEGRITY__: collectionBindings.appIntegrity,
    __SNOREDEX_THEME_INTEGRITY__: collectionBindings.themeIntegrity,
  });
  await cp(resolve(assets, 'theme.js'), resolve(staging, 'collection/theme.js'));
  await copyRevisionGuide(resolve(root, 'site-src/llms.txt'), resolve(staging, 'llms.txt'));
  await copyRevisionStylesheet(resolve(root, 'site-src/styles.css'), resolve(staging, 'styles.css'));
  await cp(resolve(root, 'LICENSE.md'), resolve(staging, 'LICENSE.md'));
  await cp(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(staging, 'THIRD_PARTY_NOTICES.md'));
  await cp(resolve(root, 'LICENSES'), resolve(staging, 'LICENSES'), { recursive: true });

  await replaceOutput({ output, previous, staging });
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}
console.log(`Built static site at ${output}`);
