<!-- doc: role=stable architecture boundaries; stage=stable -->

# Architecture

## Status

The product boundary and current implementation status live in
[`snoredex-checklist#2`](https://github.com/m4s-ai/snoredex-checklist/issues/2). Field-level producer
contract details, fixtures, and lifecycle status remain owned by
[`snoredex-data#254`](https://github.com/m4s-ai/snoredex-data/issues/254).

## System context

```text
snoredex-data reviewed truth
        |
        v
versioned collector artifact + migrations
        |
        v
validated committed vendor snapshot <--- catalogue.lock.json
        |
        v
exact consumer build ---> immutable runtime set + deployment/provenance manifests
        |                                      |
        v                                      v
GitHub Pages HTML ---> pinned runtime modules ---> catalogue projection
                                                   |
                                                   v
                                      versioned browser-local state
                                                   |
                                                   v
                                      deterministic JSON backup/restore
```

Normal builds and the running app do not fetch mutable producer data. Only an issue-backed sync
may replace the vendor snapshot and lock together after schema, references, fingerprint, and byte
digest pass validation.

## Authorities

- `snoredex-data` alone owns catalogue, evidence, locality, release, printing, relation, and
  migration truth.
- This repository alone owns private collection state and its presentation.
- The vendor snapshot is a pinned input, never a second hand-maintained catalogue.
- The lock is provenance and integrity metadata, never a second copy of catalogue semantics.
- A producer Work may group display-equivalent releases; it never merges release or item identity.

There is no write-back edge from the checklist to the producer. Private state must never enter
source, build artifacts, URLs, analytics, logs, or public issues.

## Implemented boundaries

| Boundary             | Responsibility                                                                                                          | Failure mode                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Ingestion            | Validate supported contract, digest, fingerprint, uniqueness, and references                                            | Keep the last known-good snapshot                                                                                       |
| Catalogue projection | Present producer-assigned item and progress classes without inference                                                   | Show unsupported/stale state; do not render guessed truth                                                               |
| State                | Normalize and atomically persist one logical local authority with a legacy-readable active key and one recovery sidecar | Preserve rollback readability, reject stale operations and keep private export/recovery available                       |
| Reconciliation       | Conserve every old item ID across catalogue transitions                                                                 | Stop on missing, ambiguous, 1:N, or N:1 transitions                                                                     |
| UI                   | Render untrusted producer text safely and expose accessible collection controls                                         | Fail visibly; never leak private values                                                                                 |
| Runtime publication  | Bind each HTML shell to one immutable module set and verify every declared byte                                         | Stop before catalogue rendering or private-state access when files are missing, mixed, additional, or digest-mismatched |
| Publication          | Build a static artifact from the committed snapshot and exact consumer revision only                                    | Do not deploy when provenance, compatibility, runtime, or gates disagree                                                |

## Revision-coherent publication

Each build emits an immutable `assets/runtime/<app-revision>/` directory. Its manifest binds the
application revision to the producer revision, contract version, semantic fingerprint, catalogue
and migration byte identities, and the exact runtime-module membership and digest of every module.
The HTML shell loads only that revision's entry module. A mixed browser or CDN cache therefore
cannot silently combine an old shell, a new module graph, or different catalogue bytes: bootstrap
validation fails visibly before catalogue rendering, private-state reads, or reconciliation.

The root `deployment.json` is the active publication pointer and may name one retained rollback
generation. `provenance.json` records the built tuple used to evaluate that publication. Deploy
validation checks both retained generations, rejects undeclared or changed modules, and keeps the
active and rollback asset sets together. Post-deploy smoke derives the expected tuple from the
built provenance even when the workflow later checks out recovery tooling, then verifies the live
manifests and all declared module bytes.

The index consumes only the lightweight, public directory projection required for its grouped
browse links. The collection route consumes the full validated catalogue and migration snapshot.
Neither route fetches mutable producer data at runtime.

## State-conservation invariant

```text
all old state IDs = retained + explicit safe 1:1 migration + retired/orphaned + unresolved conflict
```

Only a producer-declared, identity-preserving 1:1 transition marked automatic may move state
without user action. Split, merge, or unresolved transitions preserve the old record and create a
visible conflict; they never copy, merge, or delete ownership state.

## Deliberate v1 limits

No framework, backend, service worker, database engine, provider registry, plugin system, or
multi-dataset abstraction is planned. Reconsider those only through a new decision issue backed by
measured need.
