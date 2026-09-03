import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  runtimeShellBindings,
  runtimeTupleFromProvenance,
  sha256,
  validateRuntimeAssetSetDirectory,
  validateRuntimeAssetSetManifest,
  validateRuntimeAssetSetPointer,
  validateRuntimeTuple,
  writeRuntimeAssetSet,
} from './runtime-assets.mjs';

const root = resolve(process.cwd(), process.argv[2] ?? 'dist/site');
const assets = join(root, 'assets');
const pageUrl = process.env.SNOREDEX_PAGE_URL;
const previousPath = process.env.SNOREDEX_CURRENT_DEPLOYMENT_PATH;

function isModulePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[a-z0-9][a-z0-9._/-]*\.js$/u.test(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

function makeLegacyModuleRevisionSafe(modulePath, bytes) {
  if (modulePath !== 'assets.js') return bytes;
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const legacy = 'return new URL(path, moduleUrl).href;';
  if (!source.includes(legacy)) throw new Error('RUNTIME_LEGACY_ASSET_RESOLUTION_UNKNOWN');
  return Buffer.from(
    source.replace(
      legacy,
      'const url = new URL(moduleUrl); const marker = "/assets/"; const assetsIndex = url.pathname.lastIndexOf(marker); if (assetsIndex < 0) return new URL(path, url).href; url.pathname = `${url.pathname.slice(0, assetsIndex + marker.length)}${path}`; url.search = ""; url.hash = ""; return url.href;',
    ),
    'utf8',
  );
}

async function readJson(path, code) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(code);
  }
}

async function fetchBytes(relativePath) {
  if (pageUrl !== 'https://m4s-ai.github.io/snoredex-checklist/') throw new Error('RUNTIME_PAGE_URL_INVALID');
  const response = await fetch(new URL(relativePath, pageUrl), { cache: 'no-store' });
  if (!response.ok) throw new Error('RUNTIME_PREVIOUS_ASSET_UNAVAILABLE');
  return Buffer.from(await response.arrayBuffer());
}

async function fetchJson(relativePath) {
  const bytes = await fetchBytes(relativePath);
  try {
    return { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    throw new Error('RUNTIME_PREVIOUS_ASSET_INVALID');
  }
}

async function retainLegacyTheme(candidate, manifest) {
  const modulePaths = manifest.modules.map((module) => (typeof module === 'string' ? module : module.path));
  if (modulePaths.includes('theme.js')) return;
  const [theme, collectionTheme] = await Promise.all([fetchBytes('theme.js'), fetchBytes('collection/theme.js')]);
  const marker = Buffer.from(`snoredex-app-revision:${candidate.appRevision}`, 'utf8');
  if (!theme.equals(collectionTheme) || !theme.includes(marker)) throw new Error('RUNTIME_PREVIOUS_THEME_INVALID');
  await writeFile(join(root, 'theme.js'), theme);
  await writeFile(join(root, 'collection/theme.js'), theme);
}

async function promoteActiveShellIntegrity(pointer, runtime, modulePaths) {
  const [theme, collectionTheme] = await Promise.all([
    readFile(join(root, 'theme.js')),
    readFile(join(root, 'collection/theme.js')),
  ]);
  const marker = Buffer.from(`snoredex-app-revision:${runtime.appRevision}`, 'utf8');
  if (!theme.equals(collectionTheme) || !theme.includes(marker)) throw new Error('RUNTIME_ACTIVE_THEME_INVALID');
  const directory = join(assets, ...pointer.path.split('/'));
  await writeFile(join(directory, 'theme.js'), theme);
  const promotedPaths = [...new Set([...modulePaths, 'theme.js'])];
  const promotedPointer = await writeRuntimeAssetSet({
    assetsRoot: assets,
    sourceRoot: directory,
    modulePaths: promotedPaths,
    runtime,
  });
  const promotedManifest = await readJson(join(directory, 'manifest.json'), 'RUNTIME_ACTIVE_MANIFEST_INVALID');
  for (const relativePath of ['index.html', 'collection/index.html']) {
    const path = join(root, relativePath);
    const prefix = relativePath === 'index.html' ? '' : '../';
    const shell = await readFile(path, 'utf8');
    const bindings = runtimeShellBindings(promotedManifest, `${prefix}assets/${promotedPointer.path}/`);
    const themeScript = `<script src="${prefix}theme.js"></script>`;
    const appScript = `<script type="module" src="${prefix}assets/${pointer.path}/app.js"></script>`;
    if (!shell.includes("script-src 'self';") || !shell.includes(themeScript) || !shell.includes(appScript)) {
      throw new Error('RUNTIME_ACTIVE_SHELL_INVALID');
    }
    await writeFile(
      path,
      shell
        .replace("script-src 'self';", `script-src 'self' '${bindings.importMapCsp}';`)
        .replace(
          themeScript,
          `<script type="importmap">${bindings.importMap}</script>\n    <script src="${prefix}assets/${promotedPointer.path}/theme.js" integrity="${bindings.themeIntegrity}"></script>`,
        )
        .replace(
          appScript,
          `<script type="module" src="${prefix}assets/${promotedPointer.path}/app.js" integrity="${bindings.appIntegrity}"></script>`,
        ),
      'utf8',
    );
  }
  return { pointer: promotedPointer, runtime, legacyModules: promotedPaths };
}

async function promoteLegacyActiveSet(provenance, manifest) {
  if (
    manifest?.schema !== 'snoredex-site-module-manifest' ||
    manifest?.schemaVersion !== '1.0.0' ||
    manifest?.appRevision !== provenance.appRevision ||
    !Array.isArray(manifest.modules)
  ) {
    throw new Error('RUNTIME_ACTIVE_MANIFEST_INVALID');
  }
  const runtime = runtimeTupleFromProvenance(provenance);
  if (manifest.modules.includes('assets.js')) {
    const path = join(assets, 'assets.js');
    await writeFile(path, makeLegacyModuleRevisionSafe('assets.js', await readFile(path)));
  }
  const pointer = await writeRuntimeAssetSet({
    assetsRoot: assets,
    modulePaths: manifest.modules,
    runtime,
  });
  for (const relativePath of ['index.html', 'collection/index.html']) {
    const path = join(root, relativePath);
    const shell = await readFile(path, 'utf8');
    const prefix = relativePath === 'index.html' ? '' : '../';
    const legacySource = `${prefix}assets/app.js`;
    if (!shell.includes(`src="${legacySource}"`)) throw new Error('RUNTIME_ACTIVE_SHELL_INVALID');
    await writeFile(
      path,
      shell.replace(`src="${legacySource}"`, `src="${prefix}assets/${pointer.path}/app.js"`),
      'utf8',
    );
  }
  return promoteActiveShellIntegrity(pointer, runtime, manifest.modules);
}

async function loadActiveSet(provenance, manifest) {
  if (manifest?.schemaVersion === '1.0.0') return promoteLegacyActiveSet(provenance, manifest);
  const runtime = runtimeTupleFromProvenance(provenance);
  if (
    manifest?.schema !== 'snoredex-site-module-manifest' ||
    manifest?.schemaVersion !== '2.0.0' ||
    manifest.appRevision !== provenance.appRevision ||
    !validateRuntimeAssetSetPointer(manifest.runtimeAssetSet, provenance.appRevision) ||
    !(await validateRuntimeAssetSetDirectory(assets, manifest.runtimeAssetSet, runtime))
  ) {
    throw new Error('RUNTIME_ACTIVE_MANIFEST_INVALID');
  }
  const directory = join(assets, ...manifest.runtimeAssetSet.path.split('/'));
  const runtimeManifest = await readJson(join(directory, 'manifest.json'), 'RUNTIME_ACTIVE_MANIFEST_INVALID');
  const modulePaths = runtimeManifest.modules.map((module) => module.path);
  if (!modulePaths.includes('theme.js')) {
    return promoteActiveShellIntegrity(manifest.runtimeAssetSet, runtime, modulePaths);
  }
  return { pointer: manifest.runtimeAssetSet, runtime, legacyModules: manifest.legacyModules ?? [] };
}

function previousTuple(previous, currentRuntime) {
  const tuple = {
    appRevision: previous.appRevision,
    producerRevision: previous.producerRevision,
    contractVersion: previous.contractVersion,
    catalogueFingerprint: previous.catalogueFingerprint,
    catalogueByteSha256: previous.catalogueByteSha256,
    catalogueByteLength: previous.catalogueByteLength,
    migrationByteSha256: previous.migrationByteSha256 ?? currentRuntime.migrationByteSha256,
    migrationByteLength: previous.migrationByteLength ?? currentRuntime.migrationByteLength,
  };
  if (!validateRuntimeTuple(tuple)) throw new Error('RUNTIME_PREVIOUS_TUPLE_INVALID');
  return tuple;
}

async function retainPublishedSet(previous, currentRuntime) {
  const candidate = previous.appRevision === currentRuntime.appRevision ? previous.rollback : previous;
  if (!candidate || candidate.catalogueFingerprint !== currentRuntime.catalogueFingerprint) return undefined;
  const runtime = previousTuple(candidate, currentRuntime);
  const publishedPointer = candidate.runtimeAssetSet;
  if (publishedPointer !== undefined) {
    if (!validateRuntimeAssetSetPointer(publishedPointer, candidate.appRevision)) {
      throw new Error('RUNTIME_PREVIOUS_POINTER_INVALID');
    }
    const fetched = await fetchJson(`assets/${publishedPointer.path}/manifest.json`);
    if (
      fetched.bytes.byteLength !== publishedPointer.manifestByteLength ||
      sha256(fetched.bytes) !== publishedPointer.manifestSha256 ||
      !validateRuntimeAssetSetManifest(fetched.value, runtime)
    ) {
      throw new Error('RUNTIME_PREVIOUS_MANIFEST_INVALID');
    }
    const directory = join(assets, ...publishedPointer.path.split('/'));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'manifest.json'), fetched.bytes);
    for (const module of fetched.value.modules) {
      const bytes = await fetchBytes(`assets/${publishedPointer.path}/${module.path}`);
      if (bytes.byteLength !== module.byteLength || sha256(bytes) !== module.sha256) {
        throw new Error('RUNTIME_PREVIOUS_MODULE_INVALID');
      }
      const destination = join(directory, ...module.path.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    await retainLegacyTheme(candidate, fetched.value);
    return publishedPointer;
  }

  const fetchedManifest = await fetchJson('assets/module-manifest.json');
  const legacy = fetchedManifest.value;
  if (
    legacy?.schema !== 'snoredex-site-module-manifest' ||
    legacy?.schemaVersion !== '1.0.0' ||
    legacy?.appRevision !== candidate.appRevision ||
    !Array.isArray(legacy.modules) ||
    legacy.modules.length === 0 ||
    legacy.modules.length > 256 ||
    legacy.modules.some((modulePath) => !isModulePath(modulePath)) ||
    new Set(legacy.modules).size !== legacy.modules.length
  ) {
    throw new Error('RUNTIME_PREVIOUS_MANIFEST_INVALID');
  }
  const sourceRoot = await mkdtemp(join(tmpdir(), 'snoredex-runtime-'));
  try {
    for (const modulePath of legacy.modules) {
      const bytes = makeLegacyModuleRevisionSafe(modulePath, await fetchBytes(`assets/${modulePath}`));
      const destination = join(sourceRoot, ...modulePath.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
      await writeFile(join(assets, ...modulePath.split('/')), bytes);
    }
    await retainLegacyTheme(candidate, legacy);
    return await writeRuntimeAssetSet({ assetsRoot: assets, sourceRoot, modulePaths: legacy.modules, runtime });
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
}

const provenance = await readJson(join(root, 'provenance.json'), 'RUNTIME_PROVENANCE_INVALID');
const moduleManifest = await readJson(join(assets, 'module-manifest.json'), 'RUNTIME_ACTIVE_MANIFEST_INVALID');
const active = await loadActiveSet(provenance, moduleManifest);
let retained;
if (previousPath) {
  const previous = await readJson(previousPath, 'RUNTIME_PREVIOUS_DEPLOYMENT_INVALID');
  retained = await retainPublishedSet(previous, active.runtime);
}
const result = {
  schema: 'snoredex-site-module-manifest',
  schemaVersion: '2.0.0',
  appRevision: active.runtime.appRevision,
  runtimeAssetSet: active.pointer,
  retainedRuntimeAssetSets: retained ? [retained] : [],
  legacyModules: active.legacyModules,
};
await writeFile(join(assets, 'module-manifest.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(
  `runtime assets retained: active ${active.runtime.appRevision}; rollback ${retained?.appRevision ?? 'none'}`,
);
