<!-- doc: role=cross-repository protocol index; stage=stable -->
# Cross-repository protocol

Shared contract work is coordinated through reciprocally linked GitHub issues. The full current
protocol and lifecycle are specified in
[`snoredex-checklist#2`](https://github.com/m4s-ai/snoredex-checklist/issues/2); producer contract
semantics are owned by [`snoredex-data#254`](https://github.com/m4s-ai/snoredex-data/issues/254).

## Required record

Every schema, field-semantic, enum, item-ID, re-key, locality, fingerprint, artifact-URL, freshness,
or shared-rollout change is documented before merge in both repositories. Each pair records:

- producer and consumer issue URLs;
- canonical owner and next action;
- current and proposed contract versions;
- catalogue fingerprint or explicit `TBD` before the first accepted fixture;
- compatibility and migration behavior;
- rollback and verification evidence.

PR comments, review threads, chat, CI output, labels, and edited issue bodies do not replace the
issue history.

## Lifecycle

```text
PROPOSED -> READY -> [ADOPTED] -> VERIFIED -> CLOSED
```

`BLOCKED`, `SUPERSEDED`, `REJECTED`, and `SECURITY-EMBARGOED` are explicit exceptional states.
Every transition is an issue comment naming the exact contract version and either the exact
fingerprint or, before the first accepted fixture, explicit `TBD`. `READY` and every later state
require the exact fingerprint. `READY` means the producer artifact is published and rollback is
known; optional `ADOPTED` identifies the consumer commit/deployment and reconciliation result;
`VERIFIED` proves both sides used the same artifact.

## Contract authorities

- Consumer master: [`m4s-ai/snoredex-checklist#2`](https://github.com/m4s-ai/snoredex-checklist/issues/2)
- Producer contract: [`m4s-ai/snoredex-data#254`](https://github.com/m4s-ai/snoredex-data/issues/254)
- Historical decision: [`m4s-ai/snoredex-data#229`](https://github.com/m4s-ai/snoredex-data/issues/229)

The issues own their current state, version, fingerprint, next action, and compatibility record.
Production integration requires compatible accepted fixtures and a pinned published artifact.
