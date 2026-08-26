# Snoredex visual design baseline

Status: owner-approved on 2026-08-24. GitHub issue [#30] is the product decision and
implementation map. This directory preserves the approved visual direction; it is not the
production application.

[#30]: https://github.com/m4s-ai/snoredex-checklist/issues/30

## Product direction

Snoredex is cutesy and relaxed, collector-focused and friendly without becoming childish. The
visual language uses original abstract sleepy shapes and a Snorlax-inspired teal, cream and
seafoam palette. It must not copy official Pokémon artwork, silhouettes or product UI.

The public site has two static entry pages:

- `/` is a compact, marketing-capable project index.
- `/collection/` is the collection application.

Only the collection page carries canonical public search and filter parameters. A `status` value in
that query is a public criterion evaluated against the receiving browser's private state; actual
private status values, quantities, notes, result membership, orphan/conflict data and backups never
enter either URL.
This two-page decision supersedes the earlier single-entry route comments in issue [#9], while
retaining static GitHub Pages delivery without a client router or rewrite fallback.

[#9]: https://github.com/m4s-ai/snoredex-checklist/issues/9

## Visual system

The production implementation uses authored native CSS and product-scoped custom properties.
Nunito Sans is self-hosted at weights 400 and 500, with a system-UI fallback; collector numbers
and quantities use tabular numerals. First visit follows `prefers-color-scheme`; a manual Light or
Dark override is stored locally.

| Token | Light | Dark |
| --- | --- | --- |
| Page | `#FBF8EE` | `#172326` |
| Surface | `#FFFFFF` | `#213136` |
| Soft | `#F1EDDA` | `#2A3C40` |
| Ink | `#23343A` | `#F4F0DD` |
| Muted | `#637176` | `#B7C2BD` |
| Primary | `#456F78` | `#79AEB8` |
| Primary soft | `#DCEBED` | `#29464C` |
| Accent | `#A7C8B8` | `#9CC2AF` |
| Highlight | `#E8D69B` | `#D8C78E` |
| Danger | `#AD5752` | `#E28F87` |
| Border | `#D8DDD3` | `#405257` |
| Control border | `#7C8B8A` | `#7B8D8F` |
| Focus | `#7A5C00` | `#F0D276` |

Controls use 12px corners, rows and dialogs 18px, and hero/large surfaces 24px. Pills are reserved
for status, tags and theme controls. Depth comes from tonal layers and subtle shadows.

The target is WCAG 2.2 AA: text and control contrast, visible focus, 44px targets, non-color cues,
keyboard/touch equivalence, reduced motion, 200% zoom and reflow from 320px through desktop.

## Page reference

The index uses the approved hero copy, “Your Snorlax collection. One checklist.” It explains
private local state, current-known scope and catalogue provenance without claiming universal
completeness or official affiliation. Navigation contains no general GitHub link; Snoredex Data is
linked as a visibly external site.

The collection uses a left locality -> local set -> set edition navigator on wider screens and a
semantic “Browse sets” entry point on narrow screens. A selected set edition is the normal work
view. Current-known progress and Research are separate. One semantic item structure adapts from
compact row to stacked card. English name is primary; a positively known local name is adjacent.
Approved images may offer hover zoom only with equivalent focus/click/touch inspection and visible
scope. Research remains read-only and may link to evidence and the producer correction flow.

The authoritative private states remain Need, Ordered, Have and Skip as specified in issue [#10].
The reference uses those labels and must not be treated as a collection-state schema.

[#10]: https://github.com/m4s-ai/snoredex-checklist/issues/10

## Implementation ownership

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
reference is evidence for visual intent, not production source and not catalogue truth.
