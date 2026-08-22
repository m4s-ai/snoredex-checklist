<!-- doc: role=operating rules and view-site contracts; stage=auto -->
# AGENTS.md — working instructions for this repository

The operating rules for an agent working here. It is short *relative to what it points at*: the
detail lives in the documents and the upstream data contract linked below, and duplicating it here
would create a second copy to keep in step. Read the pointers.

## What this project is

A **card-checklist view site** for the Snorlax TCG collection — the collector's daily-driver view:
one physical card per row, grouped/sorted by set, with a per-card have / in-progress / don't-have
status and a finish/rarity note. It is the **Option-B clean-split** path from
`m4s-ai/snoredex-data` issue #229: a thin static site that *reads published JSON*, not a second
copy of catalogue truth.

The authoritative source of `Snorlax` catalogue facts is **`m4s-ai/snoredex-data`**. This repo is a
**view over that contract**, never a place where catalogue truth is re-derived, hand-edited, or
allowed to silently diverge.

## Read before you act

| Document / source | Read it before |
|---|---|
| `snoredex-data` `README.md` | touching any card identity, set, finish, or status logic — the caveats there are load-bearing |
| `snoredex-data` `analysis_checklist.json` | reading or mapping the row model — it is the data contract (v1.4.0, `{meta, items}`, 839 items) |
| `snoredex-data` `HANDOVER.md` / `LESSONS.md` | any reasoning about the data model — the incidents behind the rules live there |
| `m4s-ai/snoredex-data` issues **#229** and **#120** | the planning and the open "separate vs integrated" question that still gates this repo's scope |

The upstream `analysis_checklist.json` is a dict `{meta, items}`, keyed fields include
`checklistId` (stable id), `cardName`, `setCode`/`setName`, `number`, `language`, `finish`/
`finishFamily`, `rarity`, `releaseDate`, `image`, `cardmarketUrl`, `editionScope`, `completenessStatus`
(see README data contract § for the current schema). **Do not invent fields; expose only what the
contract carries. Pin the schema version you consumed and fail loudly if it moves.**

## Non-negotiable rules

1. **Catalogue truth lives upstream; this repo only renders it.** Every displayed set/number/name/
   language/finish must resolve to a row you read from the published JSON. The site may add *view
   state* (have/wanted), never *catalogue facts*.
2. **Owner have/don't-have state is private and local.** Per #229 Option B, the owner's collection
   status belongs in the user's own browser/tracker — never committed to this public repo. If you
   add persistence, it must be a local-only surface (e.g. localStorage) and never a public artifact.
3. **Never render "does not exist".** The upstream checklist excludes `contradicted`, `disputed`
   and `not-printed` cards as a *promise that nobody hunts a card never made*. Preserve the split:
   confirmed items are collectible; contradicted/disputed stay out of the checklist view or are
   clearly marked, never asserted as absent. A gap in a source is a gap, not proof of absence.
4. **Never hand-edit a generated file.** `index.html`, the JSON bundles the site ships, and any
   derived artifact carry `<!-- generated: … -->`-style provenance. Change the source/generator,
   then regenerate. Silent divergence between generated output and its source is how this class of
   project corrupts.
5. **Run checks before and after every write pass.** A view generator can silently regress against
   the schema; the check is cheap and catches it. See [Commands](#commands).

## Data-model traps (learned upstream)

- **`checklistId` is the stable join key**, not a human label. Group/sort by set + number for
  display, but key equality and dedupe by `checklistId`.
- **`finish` (technical: non-holo/holo/reverse-holo/mirror-holo) vs `finishFamily` (presentation:
  reverse + mirror both → "Reverse Holo") are distinct fields.** Never collapse the technical value
  while rendering or you lose auditable detail.
- **A card exists per `language`** — one physical printing per row. Do not merge languages into a
  single row unless the contract already does so.
- **`completenessStatus` and resolved-vs-placeholder items both appear.** 176 of 839 items are
  explicit unresolved placeholders by design; they are items too and must not be dropped or relabelled
  as confirmed.
- **The `items` key shape lives upstream, not here.** If the schema moves, update the pinned contract
  and the mapper together — never silently guess a field.

## Commands

Python 3.11, **standard library only**. All scripts derive paths from `Path(__file__)` (CI may run
from a different working directory). Serve locally with `python -m http.server 8000`.

The repo currently has **no generator yet** — the first committed pass (row mapper or site
generator) establishes the real pre/post write gate. Whatever its shape, that gate must:

1. parse the pinned `analysis_checklist.json` contract,
2. map every `checklistId` → rendered row without dropping or inventing fields,
3. regenerate the site deterministically (a second run produces an identical diff).

Until then the pattern is: non-trivial mapping/filter logic leaves **one runnable check** behind —
an `assert`-based self-check or a small `test_*.py` that fails if the logic breaks. No test
frameworks beyond stdlib.

## Conventions

- **This `AGENTS.md` is the canonical agent instructions.** [`CLAUDE.md`](CLAUDE.md) is a thin
  Claude-Code-specific pointer to it; when a Claude user wants the real rules they are here. Keep
  the operating truth in **this** file, not split across both.
- Do not load generic SOLID/DRY/KISS slogans. Follow concrete rules only where they fix an observed
  local failure, and keep always-loaded context compact — pull the deep docs only when the task
  touches them.
- **LF line endings**, no UTF-8 BOM.
- Catalogue data is **not** copied into this repo on import; the site pulls the published JSON from
  `snoredex-data`. If a vendored snapshot is ever added, mark its provenance + pin the schema version
  and add a check that it still matches upstream.

## Git and publication

- Repository is `github.com/m4s-ai/snoredex-checklist`. Work lands on a **feature branch via pull
  request** — do not push to `main` directly.
- The upstream data repo (`snoredex-data`) is the authoritative, gated publication surface. This
  repo's deployment is its own gated step; **a merge to `main` here must not, by itself, publish.**
  Publishing is an explicit, separate, quasi-irreversible action — track the intended publication
  gate here as it is agreed in the planning issues.
- End commit messages with the trailer
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` when Claude Code authored the change.

## Open decisions (from the planning)

- **Scope of the view persistence ([#229], [#120]):** is the have/don't-have toggle a
  browser-local surface now, or do we align with the proposed GUI from #120? This repo's rules
  above assume local-only until resolved — revisit when #120 lands.
- **Deployment target / publication gate** for this site (the data repo uses a manual
  `workflow_dispatch` gated Pages deploy; this repo has not chosen its own yet).
- **License** for this repo is not yet set (the upstream `snoredex-data` is mixed-license:
  PolyForm Noncommercial 1.0.0 code / CC BY-NC-SA 4.0 data-selection). Do not assume this repo
  inherits it; confirm before any publication.

[#229]: https://github.com/m4s-ai/snoredex-data/issues/229
[#120]: https://github.com/m4s-ai/snoredex-data/issues/120