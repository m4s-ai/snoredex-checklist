// @ts-check
// Kept self-contained so the current workflow can preserve this guard across an old consumer checkout.
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('DEPLOYMENT_RECORD_INVALID');
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} value @returns {value is string} */
const commit = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
/** @param {unknown} value @returns {value is string} */
const digest = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
/** @param {unknown} value @returns {value is number} */
const length = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** @param {unknown} pages @param {string} currentRunId */
export function activeDeploymentRuns(pages, currentRunId) {
  if (!Array.isArray(pages) || pages.length === 0 || !/^[1-9][0-9]*$/u.test(currentRunId))
    throw new Error('DEPLOYMENT_RUNS_INVALID');
  return pages
    .flatMap((page) => {
      const runs = record(page).workflow_runs;
      if (!Array.isArray(runs)) throw new Error('DEPLOYMENT_RUNS_INVALID');
      return runs.map((value) => {
        const run = record(value);
        if (
          !length(run.id) ||
          typeof run.status !== 'string' ||
          !['queued', 'in_progress', 'waiting', 'pending', 'requested', 'completed'].includes(run.status) ||
          typeof run.event !== 'string' ||
          typeof run.display_title !== 'string'
        )
          throw new Error('DEPLOYMENT_RUN_INVALID');
        return {
          id: String(run.id),
          status: run.status,
          rollback: run.event === 'workflow_dispatch' && /\/ rollback$/u.test(run.display_title),
        };
      });
    })
    .filter((run) => run.id !== currentRunId && run.status !== 'completed');
}

/** @param {string} mode @param {ReturnType<typeof activeDeploymentRuns>} runs */
export function canEnterDeploymentLane(mode, runs) {
  if (!['adopt', 'rollback'].includes(mode)) throw new Error('invalid deployment mode');
  return !runs.some((run) => (mode === 'adopt' ? run.rollback : !run.rollback));
}

/** @param {unknown} manifest @param {unknown} consumerLock @param {string} targetRevision */
export function validateRollbackTarget(manifest, consumerLock, targetRevision) {
  const current = record(manifest);
  const lock = record(consumerLock);
  const previous = record(current.rollback);
  const pointer = record(previous.runtimeAssetSet);
  const sources = current.sourceFingerprints;
  const tupleFields = [
    'producerRevision',
    'contractVersion',
    'catalogueFingerprint',
    'catalogueByteSha256',
    'catalogueByteLength',
    'migrationByteSha256',
    'migrationByteLength',
  ];
  if (
    current.schema !== 'snoredex-checklist-deployment' ||
    current.schemaVersion !== '1.0.0' ||
    current.pageUrl !== 'https://m4s-ai.github.io/snoredex-checklist/' ||
    !commit(targetRevision) ||
    previous.appRevision !== targetRevision ||
    !commit(previous.producerRevision) ||
    previous.contractVersion !== '1.0.0' ||
    tupleFields.some((key) => previous[key] !== lock[key]) ||
    pointer.appRevision !== targetRevision ||
    pointer.path !== `runtime/${targetRevision}` ||
    !digest(pointer.manifestSha256) ||
    !length(pointer.manifestByteLength) ||
    !digest(current.catalogueFingerprint) ||
    previous.catalogueFingerprint !== current.catalogueFingerprint ||
    !digest(previous.catalogueByteSha256) ||
    !length(previous.catalogueByteLength) ||
    !digest(previous.migrationByteSha256) ||
    !length(previous.migrationByteLength) ||
    !Array.isArray(sources) ||
    sources.length === 0 ||
    !sources.every(digest) ||
    new Set(sources).size !== sources.length
  ) {
    throw new Error('rollback target must match the exact published recovery tuple');
  }
}

/** @param {unknown} manifest */
export function productionIdentity(manifest) {
  const value = record(manifest);
  if (!commit(value.appRevision) || !digest(value.catalogueFingerprint)) throw new Error('DEPLOYMENT_IDENTITY_INVALID');
  return `catalogue_fingerprint=${value.catalogueFingerprint}\napp_revision=${value.appRevision}\n`;
}

/** @param {unknown} provenance @param {string} expectedRevision */
export function smokeEnvironment(provenance, expectedRevision) {
  const value = record(provenance);
  const catalogue = record(value.catalogue);
  if (
    !commit(expectedRevision) ||
    value.appRevision !== expectedRevision ||
    !commit(catalogue.sourceCommit) ||
    catalogue.contractVersion !== '1.0.0' ||
    !digest(catalogue.catalogueFingerprint) ||
    !digest(catalogue.catalogueByteSha256) ||
    !length(catalogue.catalogueByteLength) ||
    !digest(catalogue.migrationByteSha256) ||
    !length(catalogue.migrationByteLength)
  )
    throw new Error('DEPLOYMENT_SMOKE_IDENTITY_INVALID');
  return {
    SNOREDEX_EXPECTED_PRODUCER_REVISION: String(catalogue.sourceCommit),
    SNOREDEX_EXPECTED_CONTRACT_VERSION: catalogue.contractVersion,
    SNOREDEX_EXPECTED_CATALOGUE_FINGERPRINT: String(catalogue.catalogueFingerprint),
    SNOREDEX_EXPECTED_CATALOGUE_BYTE_SHA256: String(catalogue.catalogueByteSha256),
    SNOREDEX_EXPECTED_CATALOGUE_BYTE_LENGTH: String(catalogue.catalogueByteLength),
    SNOREDEX_EXPECTED_MIGRATION_BYTE_SHA256: String(catalogue.migrationByteSha256),
    SNOREDEX_EXPECTED_MIGRATION_BYTE_LENGTH: String(catalogue.migrationByteLength),
  };
}

/** @param {NodeJS.ProcessEnv} env @param {string} name */
function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`DEPLOYMENT_INPUT_MISSING: ${name}`);
  return value;
}

/** @param {NodeJS.ProcessEnv} env */
export function resolveDeploymentInputs(env) {
  const mode = env.DEPLOYMENT_MODE_INPUT || 'adopt';
  const bootstrap = env.BOOTSTRAP_INPUT || 'false';
  if (!['adopt', 'rollback'].includes(mode) || !['true', 'false'].includes(bootstrap))
    throw new Error('DEPLOYMENT_INPUT_INVALID');
  if (mode === 'rollback' && !env.CONSUMER_REVISION_INPUT)
    throw new Error('consumer_revision is required for rollback');
  if (bootstrap === 'true' && (env.EVENT_NAME !== 'workflow_dispatch' || mode !== 'adopt'))
    throw new Error('bootstrap authorization requires manual adopt');
  const revision = env.CONSUMER_REVISION_INPUT || env.WORKFLOW_REVISION;
  if (!commit(revision)) throw new Error('consumer_revision must resolve to a full lowercase commit SHA');
  return { mode, bootstrap, revision };
}

/** @param {NodeJS.ProcessEnv} env */
function reserveLane(env) {
  const mode = required(env, 'DEPLOYMENT_MODE');
  if (!['adopt', 'rollback'].includes(mode)) throw new Error('invalid deployment mode');
  const repository = required(env, 'REPOSITORY');
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(repository)) throw new Error('DEPLOYMENT_REPOSITORY_INVALID');
  const currentRunId = required(env, 'CURRENT_RUN_ID');
  const runs = () =>
    activeDeploymentRuns(
      JSON.parse(
        execFileSync(
          'gh',
          ['api', '--paginate', '--slurp', `repos/${repository}/actions/workflows/deploy-pages.yml/runs?per_page=100`],
          { encoding: 'utf8' },
        ),
      ),
      currentRunId,
    );
  let active = runs();
  if (mode === 'adopt') return canEnterDeploymentLane(mode, active);
  const deadline = Date.now() + 30 * 60 * 1000;
  while (!canEnterDeploymentLane(mode, active)) {
    if (Date.now() >= deadline) throw new Error('rollback could not acquire the deployment lane');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
    active = runs();
  }
  return true;
}

if (import.meta.main) {
  const env = process.env;
  switch (process.argv[2]) {
    case 'lane':
      appendFileSync(required(env, 'GITHUB_OUTPUT'), `proceed=${reserveLane(env)}\n`);
      break;
    case 'inputs': {
      const { mode, bootstrap, revision } = resolveDeploymentInputs(env);
      appendFileSync(
        required(env, 'GITHUB_OUTPUT'),
        `deployment_mode=${mode}\nconsumer_revision=${revision}\nbootstrap_authorized=${bootstrap}\n`,
      );
      appendFileSync(required(env, 'GITHUB_ENV'), `SNOREDEX_APP_REVISION=${revision}\n`);
      break;
    }
    case 'production':
      appendFileSync(
        required(env, 'GITHUB_OUTPUT'),
        productionIdentity(JSON.parse(readFileSync(required(env, 'CURRENT_DEPLOYMENT_PATH'), 'utf8'))),
      );
      break;
    case 'rollback':
      validateRollbackTarget(
        JSON.parse(readFileSync(required(env, 'CURRENT_DEPLOYMENT_PATH'), 'utf8')),
        JSON.parse(readFileSync('catalogue.lock.json', 'utf8')),
        required(env, 'CONSUMER_REVISION'),
      );
      break;
    case 'smoke':
      execFileSync(process.execPath, ['scripts/smoke-pages.mjs'], {
        stdio: 'inherit',
        env: {
          ...env,
          ...smokeEnvironment(
            JSON.parse(readFileSync('dist/site/provenance.json', 'utf8')),
            required(env, 'SNOREDEX_EXPECTED_GITHUB_SHA'),
          ),
        },
      });
      break;
    default:
      throw new Error('DEPLOYMENT_COMMAND_INVALID');
  }
}
