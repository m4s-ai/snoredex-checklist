import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('production adoption validates the reviewed target migration without requiring the fixture as a source', async () => {
  const scriptPath = resolve(root, 'scripts/check-production-adoption.mjs');
  const workflowPath = resolve(root, '.github/workflows/deploy-pages.yml');
  const script = await readFile(scriptPath, 'utf8');
  const workflow = await readFile(workflowPath, 'utf8');
  assert.doesNotMatch(script, /collector-catalogue\.fixture/u);
  assert.match(script, /candidate\.toFingerprint === targetFingerprint/u);
  assert.match(workflow, /name: Require reviewed producer migration target\s+if: inputs\.deployment_mode == 'adopt'/u);

  const run = (currentFingerprint?: string) => {
    const env = { ...process.env, SNOREDEX_DEPLOYMENT_MODE: 'adopt' };
    if (currentFingerprint === undefined) delete env.SNOREDEX_CURRENT_CATALOGUE_FINGERPRINT;
    else env.SNOREDEX_CURRENT_CATALOGUE_FINGERPRINT = currentFingerprint;
    return spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8', env });
  };

  const initial = run();
  assert.equal(initial.status, 0, `${initial.stdout}${initial.stderr}`);

  const target = 'sha256:c9b59276dadaf321b39ada5d17eaea74c4beecd00f8dc0cae0a46fc37afb8f15';
  const reviewedSource = run('sha256:3298f2574d6b35c9a5f93e6de6189127ee741c1d78aace39d12b67c286b8854f');
  assert.equal(reviewedSource.status, 0, `${reviewedSource.stdout}${reviewedSource.stderr}`);

  const unchanged = run(target);
  assert.equal(unchanged.status, 0, `${unchanged.stdout}${unchanged.stderr}`);

  const rollback = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SNOREDEX_DEPLOYMENT_MODE: 'rollback', SNOREDEX_CURRENT_CATALOGUE_FINGERPRINT: target },
  });
  assert.equal(rollback.status, 0, `${rollback.stdout}${rollback.stderr}`);

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
});
