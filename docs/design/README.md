# Snoredex visual design reference

Status: historical owner-approved baseline from 2026-08-24. GitHub issue [#30] is its product
decision and implementation map. This directory preserves that synthetic reference; it is not the
production application or the current interaction specification. Use [`DESIGN.md`](../../DESIGN.md)
for the current production design system.

[#30]: https://github.com/m4s-ai/snoredex-checklist/issues/30

## Product direction

Snoredex is cutesy and relaxed, collector-focused and friendly without becoming childish. The
visual language uses original abstract sleepy shapes and a Snorlax-inspired teal, cream and
seafoam palette. It must not copy official Pokémon artwork, silhouettes or product UI.

The public site has two static entry pages:

- `/` is a compact, marketing-capable project index.
- `/collection/` is the collection application.

Only the collection page carries canonical public search and filter parameters. A `status` value in
that query is a public criterion reserved for the collection-state layer; the static shell defers it
visibly until that layer is mounted. Actual private status values, quantities, notes, result
membership, orphan/conflict data and backups never enter either URL.
This two-page decision supersedes the earlier single-entry route comments in issue [#9], while
retaining static GitHub Pages delivery without a client router or rewrite fallback.

[#9]: https://github.com/m4s-ai/snoredex-checklist/issues/9

## Visual system

The production implementation uses authored native CSS and product-scoped custom properties.
Nunito Sans is self-hosted at weights 400 and 500, with a system-UI fallback; collector numbers
and quantities use tabular numerals. First visit follows `prefers-color-scheme`; a manual Light or
Dark override is stored locally.

| Token          | Light     | Dark      |
| -------------- | --------- | --------- |
| Page           | `#FBF8EE` | `#172326` |
| Surface        | `#FFFFFF` | `#213136` |
| Soft           | `#F1EDDA` | `#2A3C40` |
| Ink            | `#23343A` | `#F4F0DD` |
| Muted          | `#637176` | `#B7C2BD` |
| Primary        | `#456F78` | `#79AEB8` |
| Primary soft   | `#DCEBED` | `#29464C` |
| Accent         | `#A7C8B8` | `#9CC2AF` |
| Highlight      | `#E8D69B` | `#D8C78E` |
| Danger         | `#AD5752` | `#E28F87` |
| Border         | `#D8DDD3` | `#405257` |
| Control border | `#7C8B8A` | `#7B8D8F` |
| Focus          | `#7A5C00` | `#F0D276` |

Controls use 12px corners, rows and dialogs 18px, and hero/large surfaces 24px. Pills are reserved
for status, tags and theme controls. Depth comes from tonal layers and subtle shadows.

The target is WCAG 2.2 AA: text and control contrast, visible focus, 44px targets, non-color cues,
keyboard/touch equivalence, reduced motion, 200% zoom and reflow from 320px through desktop.

## Current production evolution

The index uses the approved hero copy, “Your Snorlax collection. One checklist.” It explains
private local state, current-known scope and catalogue provenance without claiming universal
completeness or official affiliation. Navigation contains no general GitHub link; Snoredex Data is
linked as a visibly external site. The production index now moves from that short persuasive
section into a grouped locality/language directory and does not load the full catalogue or
migration payload.

The collection promotes search and uses native localization and set selectors for progressive
browsing; it no longer renders the reference's always-expanded left catalogue tree. Advanced
filters, backup/recovery tools, and technical provenance remain available through disclosures.
Results mount in bounded groups with a dedicated live status and deliberate keyboard focus after
the collector reveals more. A selected set edition remains the normal work view. Current-known
progress and Research are separate. One semantic item structure adapts from compact row to stacked
card. English name is primary; a positively known local name is adjacent. Approved images may
offer hover zoom only with equivalent focus/click/touch inspection and visible scope. Research
remains read-only, explains why collection controls are unavailable, and may link to trackable
items, evidence, and the producer correction flow.

The authoritative private states remain Need, Ordered, Have and Skip as specified in issue [#10].
Production keeps all four as one-tap controls for trackable items, revealing quantities only for
Ordered and Have and notes progressively. Public provenance leads with a short human summary; exact
revisions, fingerprints, digests, and opaque identifiers remain in technical disclosures. The
reference uses the status labels but must not be treated as a collection-state schema.

[#10]: https://github.com/m4s-ai/snoredex-checklist/issues/10

These production changes were accepted through the accessibility/usability remediation in [#27]
and the cross-page interface audit in [#79].

[#79]: https://github.com/m4s-ai/snoredex-checklist/issues/79

## Historical implementation ownership

- [#21] owns the two entry pages, theme bootstrap, shared tokens, index and shell/provenance.
- [#24] owns collection navigation, canonical queries, selected edition and progress.
- [#19] owns item identity, image scope/inspection, evidence and correction presentation.
- [#20] owns private controls, notes and accessible autosave feedback.
- [#23] remains the authority gate for every real card image.
- [#27] owns accessibility, contrast, reflow, motion and browser acceptance.

[#19]: https://github.com/m4s-ai/snoredex-checklist/issues/19
[#20]: https://github.com/m4s-ai/snoredex-checklist/issues/20
[#21]: https://github.com/m4s-ai/snoredex-checklist/issues/21
[#23]: https://github.com/m4s-ai/snoredex-checklist/issues/23
[#24]: https://github.com/m4s-ai/snoredex-checklist/issues/24
[#27]: https://github.com/m4s-ai/snoredex-checklist/issues/27

## Interactive reference

Open [`reference.html`](reference.html) directly in a browser. It is a self-contained, network-free
design reference containing the design system, index, collection and component/error examples.
All content is synthetic; it contains no private collection data or third-party card image. The
reference is frozen evidence for the original visual intent, not production source, current
interaction behavior, or catalogue truth. Replace it only through an explicitly owned design issue.
