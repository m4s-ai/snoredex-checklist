<!-- doc: role=public project entry point; stage=public -->

# Snoredex Checklist

A mobile-friendly, static checklist for the Snorlax current-known catalogue. Catalogue truth comes
from [`m4s-ai/snoredex-data`](https://github.com/m4s-ai/snoredex-data); private collection state
belongs only to this consumer and stays in the browser.

## Project status

The v1 product and cross-repository acceptance record is complete in
[`snoredex-checklist#2`](https://github.com/m4s-ai/snoredex-checklist/issues/2). The initial
catalogue-update lifecycle is recorded in
[`snoredex-checklist#29`](https://github.com/m4s-ai/snoredex-checklist/issues/29) and
[`snoredex-data#332`](https://github.com/m4s-ai/snoredex-data/issues/332). Runtime-asset coherence,
publication, and rollback follow-up is recorded in
[`snoredex-checklist#81`](https://github.com/m4s-ai/snoredex-checklist/issues/81).

[`catalogue.lock.json`](catalogue.lock.json) is the repository authority for the accepted producer
revision, immutable artifact URLs, contract version, semantic fingerprint, and byte digests used by
normal builds. The live site's [`deployment.json`](https://m4s-ai.github.io/snoredex-checklist/deployment.json)
and [`provenance.json`](https://m4s-ai.github.io/snoredex-checklist/provenance.json) identify the
deployed application and catalogue tuple; do not copy those changing values into stable prose.

Do not use `analysis_checklist.json` as a production API and do not reconstruct producer truth from
its internal stores. Normal builds consume only the committed vendor snapshot and lock; they never
fetch mutable producer data. Synthetic fixtures remain limited to validator and test coverage.

## Specification map

| Authority                                                                       | Purpose                                                                                                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`snoredex-checklist#2`](https://github.com/m4s-ai/snoredex-checklist/issues/2) | Canonical product specification, phases, acceptance gates, and consumer handover                                                                 |
| [`snoredex-data#254`](https://github.com/m4s-ai/snoredex-data/issues/254)       | Canonical producer-contract semantics and deliverables                                                                                           |
| [`snoredex-data#229`](https://github.com/m4s-ai/snoredex-data/issues/229)       | Historical owner decision selecting the standalone site                                                                                          |
| [`AGENTS.md`](AGENTS.md)                                                        | Stable working rules and safety invariants                                                                                                       |
| [`PRODUCT.md`](PRODUCT.md)                                                      | Product purpose, users, capabilities, constraints, and principles                                                                                |
| [`SPECIFICATIONS.md`](SPECIFICATIONS.md)                                        | How issue-driven specification work becomes executable evidence                                                                                  |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                                            | Stable system boundaries and data flow                                                                                                           |
| [`CROSS_REPO_PROTOCOL.md`](CROSS_REPO_PROTOCOL.md)                              | Cross-repository lifecycle and traceability                                                                                                      |
| [`DESIGN.md`](DESIGN.md)                                                        | Current production design system and interaction rules                                                                                           |
| [`docs/design/README.md`](docs/design/README.md)                                | Owner-approved visual baseline and interactive synthetic reference ([issue #30](https://github.com/m4s-ai/snoredex-checklist/issues/30))         |
| [`docs/accessibility/evidence.md`](docs/accessibility/evidence.md)              | Automated accessibility/responsive evidence and manual release-gate record ([issue #27](https://github.com/m4s-ai/snoredex-checklist/issues/27)) |
| [`SECURITY.md`](SECURITY.md)                                                    | Security, privacy, and supported-release policy                                                                                                  |
| [`docs/security/repository-controls.md`](docs/security/repository-controls.md)  | Verified repository and GitHub-hosted security controls                                                                                          |

GitHub issues are the living specifications. Repository documents explain stable operation and link
to those issues instead of copying changing decisions into a second source of truth.

## Non-negotiable v1 boundaries

- Static same-origin site; no backend, login, analytics, cloud sync, or catalogue write-back.
- One committed, validated producer snapshot is the sole catalogue input to normal builds.
- One logical versioned browser-local state authority owns the active state and its single recovery
  slot. The active payload remains in the legacy-readable state key; recovery is kept in a dedicated
  private sidecar so older deployed revisions can still read the active collection during rollback.
- Research remains read-only and outside Owned/Secured progress.
- Unknown, retired, split, merged, or re-keyed identities never cause silent state loss.
- Catalogue adoption and pre-publication artifact validation fail closed when the contract,
  migrations, lock, runtime manifests, or built bytes disagree. Browser SRI and import-map
  integrity also prevent altered entry, theme, static, or dynamic module bytes from executing.
  Post-deploy smoke detects live-byte discrepancies and fails the workflow, but does not
  automatically restore the prior deployment; an operator must select the validated rollback
  target.

## Development

The executable baseline is Node.js 26.7.0 with its bundled npm 11.19.0 and TypeScript 7.0.2. The
exact Node version is also recorded in `.node-version`; unsupported Node or npm versions fail the
repository commands. Node 26 patch updates, including its later LTS release, are reviewed toolchain
changes rather than a switch to another major version.

```sh
npm ci
npm run check
```

`npm run build:site` assembles the static Pages artifact in `dist/site/` from the reviewed,
digest-pinned vendor snapshot and lock. Publication uses automatic `main`-push adoption so every merged revision is deployed through the protected Pages
workflow. A manual `workflow_dispatch` remains available for rollback. For adoption,
`consumer_revision` may be left blank and the workflow automatically uses the selected workflow revision (`github.sha`);
an explicit full lowercase SHA is still required for rollback. The workflow validates and checks out
the exact resolved consumer revision before building, and the smoke test verifies the same SHA.
Deployment also fails closed until the pinned producer migration
manifest is reviewed, complete and targets the accepted catalogue fingerprint. On the first
deployment of a repository with no production manifest, no source fingerprint is required; later
deployments must provide a reviewed route from the currently published fingerprint. A synthetic
fixture that was never production is not treated as a migration source, and no consumer-side
identity mapping is inferred.

The build also copies the authored card-shaped placeholders from `site-src/assets/` into the
same-origin `assets/images/` tree and writes a digest-pinned `assets/image-manifest.json`. The
image resolver currently retains the local placeholder for every catalogue reference. Producer
bytes may replace it only after publication approval, attribution and an immutable digest are
recorded and the bytes are vendored and checked through the issue-backed sync/build path; no
runtime fetch or remote hotlink is allowed.

`npm run check` type-checks the repository, runs the deterministic toolchain smoke check and
assembles the pinned static shell without network access. The full CI gate runs this command on
Ubuntu and Windows, then runs the
browser gate on Ubuntu with pinned Chromium, Firefox and WebKit binaries:

```sh
npx playwright install --with-deps chromium firefox webkit
npm run build:site
npm run test:browser
```

Formatting is enforced with the exact Prettier dependency through `npm run format:check`; use
`npm run format` to update authored files changed by the current branch. Linting is intentionally
not a second toolchain: the strict TypeScript, unit, contract, build, artifact and browser gates
are the accepted checks for this static application. Every failure prints the owning retryable
command, and CI keeps the Node/npm versions and dependency lock immutable with `npm ci`. Follow
[`CONTRIBUTING.md`](CONTRIBUTING.md) and the owning issue before adding implementation commands.

### Cyclomatic complexity baseline

The repository keeps an advisory, reproducible TypeScript-AST complexity report for `src/` and
`scripts/`. Regenerate it after source changes, then verify that the committed report is current:

```sh
npm run complexity:report
npm run complexity:check
```

The report parses source with the bundled TypeScript compiler and counts runtime function-like
declarations plus structural decision nodes. It is a refactoring aid, not a release threshold or a
claim of semantic complexity. Review any proposed seam split and its regression coverage in the
owning issue before changing the baseline or introducing a CI threshold.

### Catalogue release and issue-backed sync

The **Release catalogue update** workflow resolves the current merged `snoredex-data/main` to a
full commit, requires its exact successful producer push gate, downloads and validates the four
collector-contract files, and compares their fingerprints and byte digests with the latest
Checklist catalogue release. Identical bytes with unchanged compatibility evidence are a no-op.
Changed bytes or compatibility evidence become a deterministic
`catalogue-<producer-commit>-<consumer-commit>-<result>` release in this repository. If unchanged
producer bytes later become compatible with a newer Checklist revision or after a temporary
blocker, the new evidence gets its own immutable release instead of rewriting the earlier blocked
record.
Release immutability is enabled for the repository, so published catalogue tags and assets cannot
be replaced; the manifest also records the SHA-256 and byte length of every asset. An interrupted
publication's exact-tag draft is removed and deterministically recreated on retry.
An existing published exact-tag outcome is verified against the current assets, consumer revision
and compatibility result, then reused without modifying the immutable record.

The protected Pages workflow dispatches this intake independently after reserving the deployment
lane. Mutable producer availability or a pending producer gate therefore cannot block deployment of
the committed known-good Checklist snapshot. A compatible candidate atomically stages the vendor
pair and lock on a producer-and-consumer-specific `codex/catalogue-*` branch based on the exact
validated Checklist revision, explicitly dispatches CI for that exact bot commit,
and creates or reuses an issue-backed PR. If repository policy denies bot-created PRs, the workflow
leaves the ready branch and compare URL instead. The following deployment adopts the update only
after that PR is reviewed and merged. A consumer-contract failure, unavailable current deployment
manifest or missing complete producer migration route creates an explicit blocked prerelease and
then fails the intake run with an error, while preserving the current vendor pair and deployment.
No catalogue or migration truth is inferred here. Because this repository already has a published
deployment boundary, every non-200 manifest response, including 404, is unavailable rather than an
initial-deployment shortcut.

The underlying operator transaction remains available for recovery. Run it only with identity
values already sealed by the catalogue release:

```sh
npm run sync:catalogue -- \
  --artifact-url https://raw.githubusercontent.com/m4s-ai/snoredex-data/<40-hex-producer-commit>/collector_catalogue.json \
  --artifact-commit <40-hex-producer-commit> \
  --contract-version 1.0.0 \
  --fingerprint sha256:<64-hex-semantic-fingerprint> \
  --byte-sha256 sha256:<64-hex-byte-digest> \
  --migration-artifact-url https://raw.githubusercontent.com/m4s-ai/snoredex-data/<40-hex-producer-commit>/collector_migrations.json \
  --migration-byte-sha256 sha256:<64-hex-byte-digest> \
  --issue-url https://github.com/m4s-ai/snoredex-checklist/issues/29 \
  --issue-url https://github.com/m4s-ai/snoredex-data/issues/332
```

The command rejects unsupported or malformed input, oversized files, encoding/JSON failures,
digest or semantic-fingerprint mismatches, skewed existing pairs and interrupted replacements.
It stages and validates both catalogue and migration bytes before replacing
`vendor/snoredex-data/collector_catalogue.json`, `vendor/snoredex-data/collector_migrations.json`
and `catalogue.lock.json` together. The migration artifact must declare the target catalogue
fingerprint and is never inferred by the consumer. Do not run it against mutable branches or bytes
that were not sealed by the Checklist catalogue-release workflow and its linked issues.

### Pages deployment and rollback

Every push to `main` automatically runs the protected **Deploy Pages** workflow in `adopt` mode
using that push's full commit SHA; no SHA input is needed for normal publication. Use the
**Deploy Pages** workflow manually only when selecting `rollback` for a previous known-good
consumer commit. Select `adopt` for a manual forward catalogue adoption when required.
The workflow builds and checks that exact revision, writes `deployment.json`, and performs a bounded
HTTPS smoke test against the resulting Pages URL. A rollback requires an existing published
manifest whose exact recovery tuple names the selected consumer revision and its pinned catalogue;
an arbitrary older ancestor is not sufficient. Each HTML shell loads an immutable
`assets/runtime/<app-revision>/` module set whose manifest pins the app and producer revisions,
contract version, catalogue fingerprint, catalogue and migration byte identities, and every module
digest. The shell derives its CSP-bound import-map integrity table and entry/theme SRI values from
that manifest, so changed module bytes fail in the browser before execution. A deployment retains
only the active set and its declared one-slot rollback set; missing, mixed, additional, or
digest-mismatched runtime files fail the artifact and Pages checks. The
deployment manifest carries every catalogue fingerprint
that may still be active in browsers after the one-slot rollback. A later adoption must provide a
reviewed route for each of those fingerprints. If those sources diverge, no single rollback target
is advertised and the workflow fails closed until a recoverable target exists. The selected revision
must still contain the recoverable deployment-manifest tooling and npm commands used by this
workflow. An older commit without them is not an eligible rollback target.
Do not edit browser-local collection state or rewrite a lock in place. Verify the deployed
`deployment.json` and `provenance.json` tuple before considering the rollback complete.
The HTTPS smoke runs after GitHub Pages publication. A smoke failure marks the workflow failed and
requires investigation plus an explicit rollback; it does not itself republish the previous site.

## Licensing

This is a mixed, noncommercial source-available work. See [`LICENSE.md`](LICENSE.md) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Card images and other third-party material are
not granted by the project licences and require an explicit publication decision or a placeholder.
