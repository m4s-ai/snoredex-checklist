<!-- doc: role=security control record; stage=stable -->

# Repository security controls

This record translates the accepted v1 decisions in
[`snoredex-checklist#11`](https://github.com/m4s-ai/snoredex-checklist/issues/11) into verifiable
repository and GitHub-hosted controls. The release-gate evidence was completed on 2026-09-02; the
live settings below were rechecked on 2026-09-03. It contains no secrets, private collection data,
or second policy.

## Controls in the repository

- [`SECURITY.md`](../../SECURITY.md) routes confidential reports to GitHub Private Vulnerability
  Reporting or a private Security Advisory and defines the deployed-release support boundary.
- [`.github/dependabot.yml`](../../.github/dependabot.yml) checks the root npm lockfile and GitHub
  Actions references weekly. Dependabot pull requests use the normal CI gates and maintainer
  review; there is no auto-approval, auto-merge, grouping, ignore rule, or gate bypass.
- `AGENTS.md`, `.gitignore`, the artifact checker, and synthetic fixtures keep real
  `*.snoredex-private.json` exports outside routine repository/agent workspaces and reject the
  suffix or private-value canaries from tracked/build outputs.
- The static entry pages carry the first-applicable default-deny meta CSP. Its generated hash
  permits exactly one declarative import-map integrity table; executable scripts remain external,
  revision-addressed and SRI-bound. The browser smoke gate verifies these boundaries.
- The build, artifact, and deployment-manifest checks bind each HTML shell to an immutable runtime
  manifest, derive browser integrity metadata, verify exact module membership and byte digests, and
  validate both the active and retained rollback generations before publication. The post-deploy
  smoke re-fetches the live manifests and declared bytes after Pages publication; a mismatch fails
  the workflow but requires an explicit operator rollback rather than automatically restoring the
  prior site.

## Verified GitHub-hosted controls

These settings are owned by repository administrators rather than repository files. GitHub remains
the live source of truth if a setting changes after the dated check.

| Control                | Verified configuration                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Confidential reporting | GitHub Private Vulnerability Reporting enabled                                                                                                                                             |
| Supply-chain alerts    | Dependabot security updates, secret scanning, and secret-scanning push protection enabled                                                                                                  |
| Code scanning          | CodeQL default setup, GitHub-managed default query suite, weekly; JavaScript/TypeScript and Actions analyzed                                                                               |
| Protected branch       | Active [`main release gates`](https://github.com/m4s-ai/snoredex-checklist/rules/21879322) ruleset on `main`; deletion and non-fast-forward updates blocked; no bypass actors              |
| Pull requests          | Required with zero approvals for the single-maintainer workflow; stale reviews dismissed on push; all review threads must be resolved; unattributed changes require an additional approval |
| Strict checks          | `core (ubuntu-24.04)`, `core (windows-2025)`, `browser (ubuntu-24.04)`, `Analyze (javascript-typescript)`, and `Analyze (actions)`                                                         |
| Merge policy           | Squash merge only; merge commits and rebase merging disabled; feature branches deleted after merge                                                                                         |

The completed G6 evidence, including deterministic CI and Pages behavior, privacy and trust-boundary
checks, browser/accessibility gates, and forward/rollback/forward recovery, is recorded in the
[`issue #11 verification comment`](https://github.com/m4s-ai/snoredex-checklist/issues/11#issuecomment-5509764589).
Repository settings are rechecked for security-sensitive changes; this dated record is not a
substitute for querying the current GitHub configuration.
