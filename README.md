<!-- doc: role=public project entry point; stage=public -->

# Snoredex Checklist

A mobile-friendly, static checklist for the Snorlax current-known catalogue. Catalogue truth comes
from [`m4s-ai/snoredex-data`](https://github.com/m4s-ai/snoredex-data); private collection state
belongs only to this consumer and stays in the browser.

## Project status

Current implementation, contract, and deployment status lives in
[`snoredex-checklist#2`](https://github.com/m4s-ai/snoredex-checklist/issues/2),
[`snoredex-checklist#25`](https://github.com/m4s-ai/snoredex-checklist/issues/25), and
[`snoredex-data#304`](https://github.com/m4s-ai/snoredex-data/issues/304). The current branch
adopts the accepted producer publication `44d72b0a33125efc595309592afbf24d4eb210c1` under
contract `1.0.0`, semantic fingerprint
`sha256:c9b59276dadaf321b39ada5d17eaea74c4beecd00f8dc0cae0a46fc37afb8f15`, and byte digest
`sha256:e3dd0b1826c705744f3a7aca232f62b28a4aa30a78c060bd855be083f98f7e0f`.
The exact immutable URL and all identity fields are recorded in [`catalogue.lock.json`](catalogue.lock.json).

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
| [`SPECIFICATIONS.md`](SPECIFICATIONS.md)                                        | How issue-driven specification work becomes executable evidence                                                                                  |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                                            | Stable system boundaries and data flow                                                                                                           |
| [`CROSS_REPO_PROTOCOL.md`](CROSS_REPO_PROTOCOL.md)                              | Cross-repository lifecycle and traceability                                                                                                      |
| [`docs/design/README.md`](docs/design/README.md)                                | Owner-approved visual baseline and interactive synthetic reference ([issue #30](https://github.com/m4s-ai/snoredex-checklist/issues/30))         |
| [`docs/accessibility/evidence.md`](docs/accessibility/evidence.md)              | Automated accessibility/responsive evidence and manual release-gate record ([issue #27](https://github.com/m4s-ai/snoredex-checklist/issues/27)) |

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
- Production integration fails closed until the contract, migrations, artifact, and lock agree.

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
digest-pinned vendor snapshot and lock. Publication remains an explicit, protected
`workflow_dispatch` operation so merge and deployment stay separate. For adoption, `consumer_revision`
may be left blank and the workflow automatically uses the selected workflow revision (`github.sha`);
an explicit full lowercase SHA is still required for rollback. The workflow validates and checks out
the exact resolved consumer revision before building, and the smoke test verifies the same SHA.
Deployment also fails closed until the pinned producer migration
manifest is reviewed, complete and targets the accepted catalogue fingerprint. On the first
deployment (when no production manifest exists), no source fingerprint is required; later
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

The repository keeps an advisory, reproducible lexical complexity report for `src/` and
`scripts/`. Regenerate it after source changes, then verify that the committed report is current:

```sh
npm run complexity:report
npm run complexity:check
```

This report is a refactoring aid, not a release threshold or a claim of parser-equivalent
complexity. Review any proposed seam split and its regression coverage in the owning issue before
changing the baseline or introducing a CI threshold.

### Issue-backed catalogue sync

Catalogue ingestion is an operator-invoked transaction; normal checks and runtime never fetch
the producer. After a published producer artifact and its paired issues are accepted, run the
sync with every identity value from the deployment manifest:

```sh
npm run sync:catalogue -- \
  --artifact-url https://raw.githubusercontent.com/m4s-ai/snoredex-data/<40-hex-producer-commit>/collector_catalogue.json \
  --artifact-commit <40-hex-producer-commit> \
  --contract-version 1.0.0 \
  --fingerprint sha256:<64-hex-semantic-fingerprint> \
  --byte-sha256 sha256:<64-hex-byte-digest> \
  --migration-artifact-url https://raw.githubusercontent.com/m4s-ai/snoredex-data/<40-hex-producer-commit>/collector_migrations.json \
  --migration-byte-sha256 sha256:<64-hex-byte-digest> \
  --issue-url https://github.com/m4s-ai/snoredex-checklist/issues/25 \
  --issue-url https://github.com/m4s-ai/snoredex-data/issues/304
```

The command rejects unsupported or malformed input, oversized files, encoding/JSON failures,
digest or semantic-fingerprint mismatches, skewed existing pairs and interrupted replacements.
It stages and validates both catalogue and migration bytes before replacing
`vendor/snoredex-data/collector_catalogue.json`, `vendor/snoredex-data/collector_migrations.json`
and `catalogue.lock.json` together. The migration artifact must declare the target catalogue
fingerprint and is never inferred by the consumer. Do not run it against mutable branches or a producer issue that
has not recorded the exact immutable URL, commit, contract version, fingerprint, digest and
rollback identity.

### Manual Pages deployment and rollback

Use the **Deploy Pages** workflow from the Actions tab with the consumer commit to publish. Select
`adopt` for a forward catalogue adoption or `rollback` for a previous known-good consumer commit.
The workflow builds and checks that exact revision, writes `deployment.json`, and performs a bounded
HTTPS smoke test against the resulting Pages URL. A rollback requires an existing published
manifest whose exact recovery tuple names the selected consumer revision and its pinned catalogue;
an arbitrary older ancestor is not sufficient. The manifest carries every catalogue fingerprint
that may still be active in browsers after the one-slot rollback. A later adoption must provide a
reviewed route for each of those fingerprints. If those sources diverge, no single rollback target
is advertised and the workflow fails closed until a recoverable target exists. The selected revision
must still contain the recoverable deployment-manifest tooling and npm commands used by this
workflow. An older commit without them is not an eligible rollback target.
Do not edit browser-local collection state or rewrite a lock in place. Verify the deployed
`deployment.json` and `provenance.json` tuple before considering the rollback complete.

## Licensing

This is a mixed, noncommercial source-available work. See [`LICENSE.md`](LICENSE.md) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Card images and other third-party material are
not granted by the project licences and require an explicit publication decision or a placeholder.
