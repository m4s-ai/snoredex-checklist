import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const commitPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isModulePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.endsWith('.js') &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

export function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function runtimeTupleFromProvenance(provenance) {
  const catalogue = isRecord(provenance?.catalogue) ? provenance.catalogue : {};
  const lock = isRecord(catalogue.lock) ? catalogue.lock : {};
  const tuple = {
    appRevision: provenance?.appRevision,
    producerRevision: catalogue.sourceCommit,
    contractVersion: catalogue.contractVersion,
    catalogueFingerprint: catalogue.catalogueFingerprint,
    catalogueByteSha256: catalogue.catalogueByteSha256,
    catalogueByteLength: catalogue.catalogueByteLength,
    migrationByteSha256: lock.migrationByteSha256,
    migrationByteLength: lock.migrationByteLength,
  };
  if (!validateRuntimeTuple(tuple)) throw new Error('RUNTIME_ASSET_TUPLE_INVALID');
  return tuple;
}

export function validateRuntimeTuple(value, expected) {
  if (
    !isRecord(value) ||
    !commitPattern.test(value.appRevision ?? '') ||
    !commitPattern.test(value.producerRevision ?? '') ||
    value.contractVersion !== '1.0.0' ||
    !digestPattern.test(value.catalogueFingerprint ?? '') ||
    !digestPattern.test(value.catalogueByteSha256 ?? '') ||
    !Number.isSafeInteger(value.catalogueByteLength) ||
    value.catalogueByteLength <= 0 ||
    !digestPattern.test(value.migrationByteSha256 ?? '') ||
    !Number.isSafeInteger(value.migrationByteLength) ||
    value.migrationByteLength <= 0
  ) {
    return false;
  }
  return !expected || Object.keys(value).every((key) => value[key] === expected[key]);
}

export function validateRuntimeAssetSetPointer(value, expectedAppRevision) {
  return (
    isRecord(value) &&
    commitPattern.test(value.appRevision ?? '') &&
    (!expectedAppRevision || value.appRevision === expectedAppRevision) &&
    value.path === `runtime/${value.appRevision}` &&
    digestPattern.test(value.manifestSha256 ?? '') &&
    Number.isSafeInteger(value.manifestByteLength) &&
    value.manifestByteLength > 0
  );
}

export function validateRuntimeAssetSetManifest(value, expectedTuple) {
  if (
    !isRecord(value) ||
    value.schema !== 'snoredex-runtime-asset-set' ||
    value.schemaVersion !== '1.0.0' ||
    !validateRuntimeTuple(value.runtime, expectedTuple) ||
    !Array.isArray(value.modules) ||
    value.modules.length === 0 ||
    value.modules.length > 256
  ) {
    return false;
  }
  const paths = new Set();
  for (const module of value.modules) {
    if (
      !isRecord(module) ||
      !isModulePath(module.path) ||
      paths.has(module.path) ||
      !digestPattern.test(module.sha256 ?? '') ||
      !Number.isSafeInteger(module.byteLength) ||
      module.byteLength <= 0
    ) {
      return false;
    }
    paths.add(module.path);
  }
  return paths.has('app.js') && paths.has('snapshot.js') && paths.has('migrations.js');
}

export async function readRuntimeAssetSet(pointer, expectedTuple, readBytes) {
  if (!validateRuntimeAssetSetPointer(pointer, expectedTuple?.appRevision)) {
    throw new Error('RUNTIME_ASSET_POINTER_INVALID');
  }
  let manifestBytes;
  let manifest;
  try {
    manifestBytes = await readBytes(`${pointer.path}/manifest.json`);
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw new Error('RUNTIME_ASSET_MANIFEST_INVALID');
  }
  if (
    manifestBytes.byteLength !== pointer.manifestByteLength ||
    sha256(manifestBytes) !== pointer.manifestSha256 ||
    !validateRuntimeAssetSetManifest(manifest, expectedTuple)
  ) {
    throw new Error('RUNTIME_ASSET_MANIFEST_INVALID');
  }
  return {
    manifest,
    moduleTexts: await Promise.all(
      manifest.modules.map(async (module) => {
        let bytes;
        try {
          bytes = await readBytes(`${pointer.path}/${module.path}`);
        } catch {
          throw new Error('RUNTIME_ASSET_MODULE_INVALID');
        }
        if (bytes.byteLength !== module.byteLength || sha256(bytes) !== module.sha256) {
          throw new Error('RUNTIME_ASSET_MODULE_INVALID');
        }
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new Error('RUNTIME_ASSET_MODULE_INVALID');
        }
      }),
    ),
  };
}

export async function writeRuntimeAssetSet({ assetsRoot, sourceRoot = assetsRoot, modulePaths, runtime }) {
  if (!validateRuntimeTuple(runtime)) throw new Error('RUNTIME_ASSET_TUPLE_INVALID');
  const paths = [...new Set(modulePaths)].sort();
  if (paths.length !== modulePaths.length || paths.some((path) => !isModulePath(path))) {
    throw new Error('RUNTIME_ASSET_MODULE_PATH_INVALID');
  }
  const directory = resolve(assetsRoot, 'runtime', runtime.appRevision);
  const modules = [];
  for (const path of paths) {
    const bytes = await readFile(resolve(sourceRoot, ...path.split('/')));
    const destination = resolve(directory, ...path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    modules.push({ path, byteLength: bytes.byteLength, sha256: sha256(bytes) });
  }
  const manifest = {
    schema: 'snoredex-runtime-asset-set',
    schemaVersion: '1.0.0',
    runtime,
    modules,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(resolve(directory, 'manifest.json'), manifestBytes);
  return {
    appRevision: runtime.appRevision,
    path: `runtime/${runtime.appRevision}`,
    manifestSha256: sha256(manifestBytes),
    manifestByteLength: manifestBytes.byteLength,
  };
}

export async function validateRuntimeAssetSetDirectory(assetsRoot, pointer, expectedTuple) {
  if (!validateRuntimeAssetSetPointer(pointer, expectedTuple?.appRevision)) return false;
  const directory = resolve(assetsRoot, ...pointer.path.split('/'));
  let manifestBytes;
  let manifest;
  try {
    manifestBytes = await readFile(resolve(directory, 'manifest.json'));
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    return false;
  }
  if (
    manifestBytes.byteLength !== pointer.manifestByteLength ||
    sha256(manifestBytes) !== pointer.manifestSha256 ||
    !validateRuntimeAssetSetManifest(manifest, expectedTuple)
  ) {
    return false;
  }
  for (const module of manifest.modules) {
    try {
      const bytes = await readFile(resolve(directory, ...module.path.split('/')));
      if (bytes.byteLength !== module.byteLength || sha256(bytes) !== module.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}
