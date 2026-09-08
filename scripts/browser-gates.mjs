// @ts-check
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/** @param {string} directory @param {string} revision */
export async function artifactIdentity(directory, revision) {
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error('BROWSER_ARTIFACT_REVISION_INVALID');
  const provenance = JSON.parse(await readFile(resolve(directory, 'provenance.json'), 'utf8'));
  if (provenance?.appRevision !== revision) throw new Error('BROWSER_ARTIFACT_REVISION_MISMATCH');
  /** @type {Array<[string, string]>} */
  const entries = [];
  /** @param {string} relative */
  async function visit(relative) {
    for (const entry of await readdir(resolve(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        entries.push([
          path,
          createHash('sha256')
            .update(await readFile(resolve(directory, path)))
            .digest('hex'),
        ]);
      else throw new Error('BROWSER_ARTIFACT_ENTRY_INVALID');
    }
  }
  await visit('');
  return entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** @param {string} directory @param {string} revision @param {Array<() => void | Promise<void>>} gates */
export async function verifyBrowserGates(directory, revision, gates) {
  const identity = await artifactIdentity(directory, revision);
  for (const gate of gates) {
    await gate();
    assert.deepEqual(
      await artifactIdentity(directory, revision),
      identity,
      'browser gates changed their shared artifact',
    );
  }
  return identity.length;
}

if (import.meta.main) {
  const revision =
    process.env.SNOREDEX_APP_REVISION || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const started = performance.now();
  // Run the selected consumer's suites, even when this guard was preserved from a newer workflow.
  const count = await verifyBrowserGates(
    resolve('dist/site'),
    revision,
    ['tests/browser-smoke.mjs', 'tests/accessibility-smoke.mjs'].map((script) => () => {
      execFileSync(process.execPath, [resolve(script)], { stdio: 'inherit' });
    }),
  );
  console.log(`browser gates: one unchanged artifact, ${count} files, ${Math.round(performance.now() - started)} ms`);
}
