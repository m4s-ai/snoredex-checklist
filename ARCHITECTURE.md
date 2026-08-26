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
versioned collector artifact + migrations + deployment manifest
        |
        v
validated committed vendor snapshot <--- catalogue.lock.json
        |
        v
static checklist app <----------> versioned browser-local state
        |                                      |
        v                                      v
GitHub Pages                         deterministic JSON backup/restore
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

## Planned boundaries

| Boundary | Responsibility | Failure mode |
| --- | --- | --- |
| Ingestion | Validate supported contract, digest, fingerprint, uniqueness, and references | Keep the last known-good snapshot |
| Catalogue projection | Present producer-assigned item and progress classes without inference | Show unsupported/stale state; do not render guessed truth |
| State | Normalize and atomically persist one versioned local envelope plus one recovery slot | Preserve readable state, reject stale operations and keep private export/recovery available |
| Reconciliation | Conserve every old item ID across catalogue transitions | Stop on missing, ambiguous, 1:N, or N:1 transitions |
| UI | Render untrusted producer text safely and expose accessible collection controls | Fail visibly; never leak private values |
| Publication | Build a static artifact from the committed snapshot only | Do not deploy when provenance or gates disagree |

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
