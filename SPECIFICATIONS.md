<!-- doc: role=specification workflow; stage=stable -->
# Specification workflow

This repository uses **issue-driven specification development**. A GitHub issue is the canonical
living specification; schemas, fixtures, validators, and acceptance checks are its executable
evidence. Plans and changing decisions stay in issues so they can be reviewed, superseded, and
closed without a drifting copy in the repository.

## Specification readiness

Implementation starts only when its owning issue records:

1. outcome, scope, and explicit non-goals;
2. owning authority for every fact and state transition;
3. domain identities, cardinalities, and failure behavior;
4. concrete acceptance scenarios, including privacy, accessibility, migration, and rollback;
5. dependencies and cross-repository counterparts with full URLs;
6. contract version, compatibility, fingerprint, and migration behavior when shared data changes;
7. unresolved owner decisions, with a fail-safe default or an explicit blocking state.

If one of these is unknown, keep it visible in the issue. Do not settle it indirectly in code, a PR
review, chat, or a generated artifact.

## Executable specification

Once the paired producer contract is accepted, its consumer-facing evidence belongs in these
locations:

| Artifact | Role |
| --- | --- |
| `schemas/` | Accepted JSON Schemas at trust boundaries |
| `tests/fixtures/` | Reviewed synthetic compatibility, failure, and migration examples |
| `vendor/snoredex-data/` | One validated, committed catalogue and migration snapshot |
| `catalogue.lock.json` | Producer revision, artifact URL, contract version, semantic fingerprint, and byte digest |
| tests/workflows | Smallest runnable checks proving the issue's acceptance scenarios |

Do not create placeholder files merely to resemble this layout. Add an artifact when an accepted
specification gives it content and an owning validation path.

## Specification authorities

| Specification | Authority |
| --- | --- |
| [`snoredex-checklist#2`](https://github.com/m4s-ai/snoredex-checklist/issues/2) | Consumer product, private state, implementation and acceptance |
| [`snoredex-data#254`](https://github.com/m4s-ai/snoredex-data/issues/254) | Producer contract semantics, artifacts, fixtures and publication evidence |

Before the producer contract is accepted, consumer work is limited to reviewed synthetic fixtures.
Real catalogue data may be vendored only after both issues record the required acceptance and
publication evidence.

## From specification to verified release

1. Record `PROPOSED` in the owning issue and its linked counterpart.
2. Review and accept contract semantics and synthetic fixtures in both issues; do not call an
   unpublished artifact `READY`.
3. Implement the smallest producer and consumer changes on their own issue branches.
4. Run the acceptance checks named by the issues and inspect state-conservation accounting.
5. Record producer `READY` only with the published URL, commit, version, fingerprint, verification,
   and rollback evidence.
6. Record consumer `ADOPTED`, then end-to-end `VERIFIED`, against that same artifact.
7. Close only after rollback and recovery remain possible and both sides agree on the result.
