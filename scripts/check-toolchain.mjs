import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

function exactEngine(value, name) {
  const match = typeof value === 'string' ? /^=(.+)$/.exec(value) : undefined;
  if (!match) throw new Error(`TOOLCHAIN_${name.toUpperCase()}_PIN_INVALID`);
  return match[1];
}

function fail(code, expected, actual) {
  console.error(`${code}: expected ${expected}; received ${actual || 'missing'}`);
  process.exitCode = 1;
}

const expectedNode = exactEngine(packageJson.engines?.node, 'node');
const expectedNpm = exactEngine(packageJson.engines?.npm, 'npm');
const packageManager = typeof packageJson.packageManager === 'string' ? packageJson.packageManager : '';
if (packageManager !== `npm@${expectedNpm}`) {
  throw new Error(`TOOLCHAIN_PACKAGE_MANAGER_PIN_INVALID: expected npm@${expectedNpm}`);
}

if (process.versions.node !== expectedNode) fail('TOOLCHAIN_NODE_VERSION', expectedNode, process.versions.node);

let actualNpm;
const userAgent = process.env.npm_config_user_agent ?? '';
const userAgentMatch = /(?:^|\s)npm\/([^\s]+)/.exec(userAgent);
if (userAgentMatch) {
  actualNpm = userAgentMatch[1];
} else if (process.env.npm_execpath) {
  const npmResult = spawnSync(process.execPath, [process.env.npm_execpath, '--version'], { encoding: 'utf8' });
  actualNpm = npmResult.status === 0 ? npmResult.stdout.trim() : '';
}
if (actualNpm !== expectedNpm) fail('TOOLCHAIN_NPM_VERSION', expectedNpm, actualNpm);

const expectedTypeScript = packageJson.devDependencies?.typescript;
if (typeof expectedTypeScript !== 'string' || !/^\d+\.\d+\.\d+$/.test(expectedTypeScript)) {
  throw new Error('TOOLCHAIN_TYPESCRIPT_PIN_INVALID');
}
const tscPath = resolve(root, 'node_modules/typescript/bin/tsc');
const tscResult = spawnSync(process.execPath, [tscPath, '--version'], { encoding: 'utf8' });
const actualTypeScript = tscResult.status === 0 ? (/Version\s+([^\s]+)/.exec(tscResult.stdout)?.[1] ?? '') : '';
if (actualTypeScript !== expectedTypeScript) fail('TOOLCHAIN_TYPESCRIPT_VERSION', expectedTypeScript, actualTypeScript);

if (process.exitCode) process.exit(process.exitCode);
console.log(`toolchain ok: node ${expectedNode}, npm ${expectedNpm}, typescript ${expectedTypeScript}`);
