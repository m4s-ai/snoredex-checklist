# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a solo Snorlax card collector who wants to understand the evidence-backed
current-known catalogue and privately track their collection while browsing it. Their core job is
to distinguish what they need, have ordered, own, or intentionally skip without confusing
unresolved research with a missing collectible.

## Product Purpose

Snoredex Checklist is a mobile-friendly, static companion for browsing the Snorlax current-known
catalogue and recording private collection progress. It succeeds when collectors can understand
the catalogue's scope, make reliable collection decisions, preserve their progress across
catalogue changes, and recover or move their data through an explicit backup workflow.

## Positioning

The product combines a pinned, validated catalogue from the authoritative Snoredex Data producer
with browser-only private collection state and lossless, fail-closed reconciliation. It presents
the evidence-bounded current-known scope honestly rather than claiming universal completeness or
inferring missing catalogue truth.

## Operating Context

Collectors use the public site to browse by locality, language, set edition, and physical or
candidate variation; search and filter the catalogue; review evidence and provenance; and maintain
Need, Ordered, Have, or Skip state. Research entries remain visible but read-only. Collection state
is saved locally in the current browser, with deterministic export, import, backup, and recovery
flows for user-controlled portability.

The public site has a compact project index at `/` and the collection application at
`/collection/`. Public URLs may carry catalogue navigation and filter criteria, but never private
statuses, quantities, notes, recovery records, or collection identities.

## Capabilities and Constraints

- Snoredex Data alone owns catalogue, evidence, locality, release, physical-printing, relation,
  migration, and provenance truth; this product renders its accepted public contract.
- Snoredex Checklist alone owns private collection state. There is no catalogue write-back or
  private-state network edge.
- Normal builds use one committed, validated, digest-pinned vendor snapshot and do not fetch
  mutable producer data.
- Current-known progress is derived from producer-assigned classes. Research stays outside Owned
  and Secured denominators and is never presented as an ordinary collection status.
- Catalogue changes conserve every old private-state identity. Ambiguous splits, merges, missing
  transitions, or unsupported contracts fail closed and preserve the last known-good state.
- The product is a static, same-origin GitHub Pages site with no backend, login, analytics, cloud
  sync, service worker, browser database, UI framework, or catalogue editing in v1.
- Unknown catalogue values remain visibly unknown. The consumer never guesses or cross-products
  localities, languages, editions, finishes, identities, or completeness.

## Brand Commitments

The product name is Snoredex Checklist. Its voice is calm, friendly, collector-focused, and careful
without becoming childish. Copy must not imply official Pokémon affiliation, universal catalogue
completeness, or that a generic image depicts an exact physical printing.

## Evidence on Hand

- The canonical product specification and changing execution state live in
  [checklist issue #2](https://github.com/m4s-ai/snoredex-checklist/issues/2).
- [`catalogue.lock.json`](catalogue.lock.json) and the committed vendor files record the validated
  producer snapshot used by normal builds.
- [`docs/design/README.md`](docs/design/README.md) records the owner-approved product voice and
  visual baseline; its synthetic reference is design evidence, not production source or catalogue
  truth.
- Repository tests and [`docs/accessibility/evidence.md`](docs/accessibility/evidence.md) provide
  executable product-boundary and accessibility evidence.
- No customer testimonials, pricing claims, official Pokémon endorsement, or publication licence
  for third-party card images is on hand. Unapproved imagery must remain a safe placeholder.

## Product Principles

1. Preserve collector trust: show evidence scope, uncertainty, and provenance instead of guessing.
2. Keep collection state private, local, portable, and recoverable.
3. Conserve user state across catalogue change and stop visibly when identity is ambiguous.
4. Make careful collecting calm and efficient on small screens, keyboards, touch, and assistive
   technology.
5. Keep the consumer simple and static while producer truth remains explicit and pinned.

## Accessibility & Inclusion

The product targets WCAG 2.2 AA. It supports semantic navigation, keyboard-only and screen-reader
operation, visible focus, non-color status cues, reduced motion, 200% zoom, 44-pixel touch targets,
and reflow from 320-pixel mobile layouts through desktop. Save, import, migration, and recovery
outcomes must be announced accessibly, and missing images require meaningful fallback text.
