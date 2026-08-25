<!-- doc: role=public project entry point; stage=public -->
# Snoredex Checklist

A mobile-friendly, static checklist for the Snorlax current-known catalogue. Catalogue truth comes
from [`m4s-ai/snoredex-data`](https://github.com/m4s-ai/snoredex-data); private collection state
belongs only to this consumer and stays in the browser.

## Project status

Current implementation, contract, and deployment status lives in
[`snoredex-checklist#2`](https://github.com/m4s-ai/snoredex-checklist/issues/2) and
[`snoredex-data#254`](https://github.com/m4s-ai/snoredex-data/issues/254). Real catalogue
integration requires an accepted producer contract and reviewed fixtures plus a published artifact
pinned by commit, semantic fingerprint, and exact-byte digest.

Do not use `analysis_checklist.json` as a production API and do not reconstruct producer truth from
its internal stores. Prototype work may use only reviewed synthetic fixtures.

## Specification map

| Authority | Purpose |
| --- | --- |
| [`snoredex-checklist#2`](https://github.com/m4s-ai/snoredex-checklist/issues/2) | Canonical product specification, phases, acceptance gates, and consumer handover |
| [`snoredex-data#254`](https://github.com/m4s-ai/snoredex-data/issues/254) | Canonical producer-contract semantics and deliverables |
| [`snoredex-data#229`](https://github.com/m4s-ai/snoredex-data/issues/229) | Historical owner decision selecting the standalone site |
| [`AGENTS.md`](AGENTS.md) | Stable working rules and safety invariants |
| [`SPECIFICATIONS.md`](SPECIFICATIONS.md) | How issue-driven specification work becomes executable evidence |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Stable system boundaries and data flow |
| [`CROSS_REPO_PROTOCOL.md`](CROSS_REPO_PROTOCOL.md) | Cross-repository lifecycle and traceability |
| [`docs/design/README.md`](docs/design/README.md) | Owner-approved visual baseline and interactive synthetic reference ([issue #30](https://github.com/m4s-ai/snoredex-checklist/issues/30)) |

GitHub issues are the living specifications. Repository documents explain stable operation and link
to those issues instead of copying changing decisions into a second source of truth.

## Non-negotiable v1 boundaries

- Static same-origin site; no backend, login, analytics, cloud sync, or catalogue write-back.
- One committed, validated producer snapshot is the sole catalogue input to normal builds.
- One versioned browser-local state envelope is the sole private-state authority.
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

`npm run check` type-checks the repository and runs the deterministic toolchain smoke check. It
does not fetch producer catalogue data or build an application artifact. Follow
[`CONTRIBUTING.md`](CONTRIBUTING.md) and the owning issue before adding implementation commands.

## Licensing

This is a mixed, noncommercial source-available work. See [`LICENSE.md`](LICENSE.md) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Card images and other third-party material are
not granted by the project licences and require an explicit publication decision or a placeholder.
