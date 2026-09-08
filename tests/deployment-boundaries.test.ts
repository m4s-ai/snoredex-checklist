import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  activeDeploymentRuns,
  canEnterDeploymentLane,
  productionIdentity,
  resolveDeploymentInputs,
  smokeEnvironment,
  validateRollbackTarget,
} from '../scripts/deployment-boundaries.mjs';

const revision = 'a'.repeat(40);
const fingerprint = `sha256:${'b'.repeat(64)}`;

test('rollback has priority and waits for active adoption to finish', () => {
  const rollback = { id: '2', status: 'waiting', rollback: true };
  const adoption = { id: '3', status: 'in_progress', rollback: false };
  assert.equal(canEnterDeploymentLane('adopt', [rollback]), false);
  assert.equal(canEnterDeploymentLane('adopt', [adoption]), true);
  assert.equal(canEnterDeploymentLane('rollback', [adoption]), false);
  assert.equal(canEnterDeploymentLane('rollback', [rollback]), true);
  assert.equal(canEnterDeploymentLane('rollback', []), true);
  assert.throws(() => canEnterDeploymentLane('unknown', []));
  assert.throws(() =>
    activeDeploymentRuns(
      [{ workflow_runs: [{ id: 2, status: 'unknown', event: 'push', display_title: 'Deploy Pages / adopt' }] }],
      '1',
    ),
  );
  assert.equal(
    activeDeploymentRuns(
      [
        {
          workflow_runs: [
            { id: 2, status: 'requested', event: 'workflow_dispatch', display_title: 'Deploy Pages / rollback' },
          ],
        },
      ],
      '1',
    ).length,
    1,
  );
});
const lock = {
  producerRevision: 'c'.repeat(40),
  contractVersion: '1.0.0',
  catalogueFingerprint: fingerprint,
  catalogueByteSha256: fingerprint,
  catalogueByteLength: 123,
  migrationByteSha256: fingerprint,
  migrationByteLength: 456,
};
const manifest = {
  schema: 'snoredex-checklist-deployment',
  schemaVersion: '1.0.0',
  pageUrl: 'https://m4s-ai.github.io/snoredex-checklist/',
  catalogueFingerprint: fingerprint,
  sourceFingerprints: [fingerprint],
  rollback: {
    ...lock,
    appRevision: revision,
    runtimeAssetSet: {
      appRevision: revision,
      path: `runtime/${revision}`,
      manifestSha256: fingerprint,
      manifestByteLength: 789,
    },
  },
};

test('live smoke expectations come from the built consumer and reject malformed identity', () => {
  const provenance = { appRevision: revision, catalogue: { ...lock, sourceCommit: lock.producerRevision } };
  assert.equal(smokeEnvironment(provenance, revision).SNOREDEX_EXPECTED_MIGRATION_BYTE_LENGTH, '456');
  assert.throws(() => smokeEnvironment(provenance, 'd'.repeat(40)));
  for (const [field, value] of [
    ['sourceCommit', [lock.producerRevision]],
    ['migrationByteLength', '456'],
    ['catalogueFingerprint', null],
  ]) {
    assert.throws(() =>
      smokeEnvironment({ ...provenance, catalogue: { ...provenance.catalogue, [String(field)]: value } }, revision),
    );
  }
});

test('deployment inputs preserve explicit bootstrap and exact rollback revision boundaries', () => {
  assert.deepEqual(resolveDeploymentInputs({ WORKFLOW_REVISION: revision }), {
    mode: 'adopt',
    bootstrap: 'false',
    revision,
  });
  assert.equal(
    resolveDeploymentInputs({ WORKFLOW_REVISION: revision, BOOTSTRAP_INPUT: 'true', EVENT_NAME: 'workflow_dispatch' })
      .bootstrap,
    'true',
  );
  for (const env of [
    { DEPLOYMENT_MODE_INPUT: 'unknown' },
    { BOOTSTRAP_INPUT: 'yes' },
    { BOOTSTRAP_INPUT: 'true', EVENT_NAME: 'push' },
    { DEPLOYMENT_MODE_INPUT: 'rollback' },
    {
      DEPLOYMENT_MODE_INPUT: 'rollback',
      CONSUMER_REVISION_INPUT: revision,
      BOOTSTRAP_INPUT: 'true',
      EVENT_NAME: 'workflow_dispatch',
    },
    { CONSUMER_REVISION_INPUT: 'main' },
    { CONSUMER_REVISION_INPUT: `${revision}\nproceed=true` },
  ])
    assert.throws(() => resolveDeploymentInputs({ WORKFLOW_REVISION: revision, ...env }));
});

test('deployment lane validates paginated API data and distinguishes rollback from adoption', () => {
  const run = { id: 2, status: 'queued', event: 'workflow_dispatch', display_title: 'Deploy Pages / rollback' };
  assert.deepEqual(
    activeDeploymentRuns(
      [
        { workflow_runs: [run, { ...run, id: 1 }] },
        {
          workflow_runs: [
            { ...run, id: 3, status: 'completed' },
            { ...run, id: 4, event: 'push' },
          ],
        },
      ],
      '1',
    ),
    [
      { id: '2', status: 'queued', rollback: true },
      { id: '4', status: 'queued', rollback: false },
    ],
  );
  for (const value of [
    null,
    {},
    [],
    [{}],
    [{ workflow_runs: null }],
    [{ workflow_runs: [{ ...run, id: '2' }] }],
    [{ workflow_runs: [{ ...run, display_title: [] }] }],
  ]) {
    assert.throws(() => activeDeploymentRuns(value, '1'));
  }
});

test('rollback requires the exact published recovery tuple with no coercion', () => {
  assert.doesNotThrow(() => validateRollbackTarget(manifest, lock, revision));
  for (const field of Object.keys(lock)) {
    assert.throws(() =>
      validateRollbackTarget({ ...manifest, rollback: { ...manifest.rollback, [field]: 'wrong' } }, lock, revision),
    );
  }
  for (const invalid of [
    { ...manifest, sourceFingerprints: [fingerprint, fingerprint] },
    { ...manifest, sourceFingerprints: [[fingerprint]] },
    { ...manifest, catalogueFingerprint: `sha256:${'d'.repeat(64)}` },
    {
      ...manifest,
      rollback: {
        ...manifest.rollback,
        runtimeAssetSet: { ...manifest.rollback.runtimeAssetSet, manifestByteLength: '789' },
      },
    },
  ])
    assert.throws(() => validateRollbackTarget(invalid, lock, revision));
  assert.throws(() => productionIdentity({ appRevision: [revision], catalogueFingerprint: fingerprint }));
});

test('preserved standalone deployment CLI rejects an old consumer with the wrong rollback lock', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'snoredex-deployment-boundary-'));
  try {
    const script = resolve(directory, 'guard.mjs');
    const current = resolve(directory, 'current.json');
    await writeFile(script, await readFile(resolve('scripts/deployment-boundaries.mjs')));
    await writeFile(current, JSON.stringify(manifest));
    await writeFile(resolve(directory, 'catalogue.lock.json'), JSON.stringify(lock));
    const run = () =>
      spawnSync(process.execPath, [script, 'rollback'], {
        cwd: directory,
        encoding: 'utf8',
        env: { ...process.env, CURRENT_DEPLOYMENT_PATH: current, CONSUMER_REVISION: revision },
      });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    await writeFile(resolve(directory, 'catalogue.lock.json'), JSON.stringify({ ...lock, migrationByteLength: 999 }));
    assert.notEqual(run().status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
