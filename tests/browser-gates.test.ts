import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { verifyBrowserGates } from '../scripts/browser-gates.mjs';

test('both browser gates use identical bytes and the expected revision', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'snoredex-browser-artifact-'));
  const revision = 'a'.repeat(40);
  try {
    await writeFile(resolve(directory, 'provenance.json'), JSON.stringify({ appRevision: revision }));
    await writeFile(resolve(directory, 'index.html'), 'original');
    let calls = 0;
    const count = await verifyBrowserGates(directory, revision, [
      () => {
        calls++;
      },
      () => {
        calls++;
      },
    ]);
    assert.equal(count, 2);
    assert.equal(calls, 2);
    await assert.rejects(
      () =>
        verifyBrowserGates(directory, 'b'.repeat(40), [
          () => {
            calls++;
          },
        ]),
      /REVISION_MISMATCH/u,
    );
    assert.equal(calls, 2);
    await assert.rejects(
      () =>
        verifyBrowserGates(directory, revision, [
          () => writeFile(resolve(directory, 'index.html'), 'rebuilt'),
          () => {
            calls++;
          },
        ]),
      /changed their shared artifact/u,
    );
    assert.equal(calls, 2, 'a changed artifact must stop before the next gate');
    await assert.rejects(
      () =>
        verifyBrowserGates(directory, revision, [
          () => {
            throw new Error('gate failed');
          },
          () => {
            calls++;
          },
        ]),
      /gate failed/u,
    );
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
