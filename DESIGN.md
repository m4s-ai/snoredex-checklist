---
name: Snoredex Checklist
description: A calm, private collector companion for the current-known Snorlax catalogue.
colors:
  resting-cream: '#fbf8ee'
  paper-surface: '#ffffff'
  quiet-parchment: '#f1edda'
  deep-ink: '#23343a'
  muted-slate: '#59686b'
  collector-teal: '#456f78'
  primary-ink-light: '#ffffff'
  pale-collector-teal: '#dcebed'
  quiet-seafoam: '#a7c8b8'
  binder-gold: '#e8d69b'
  soft-coral-warning: '#ad5752'
  paper-border: '#d8ddd3'
  control-slate: '#7c8b8a'
  amber-focus: '#7a5c00'
  night-page: '#172326'
  night-surface: '#213136'
  night-soft: '#2a3c40'
  night-ink: '#f4f0dd'
  night-muted: '#b7c2bd'
  night-collector-teal: '#79aeb8'
  night-primary-ink: '#172326'
  night-primary-soft: '#29464c'
  night-seafoam: '#9cc2af'
  night-binder-gold: '#d8c78e'
  night-coral-warning: '#e28f87'
  night-border: '#405257'
  night-control: '#7b8d8f'
  night-focus: '#f0d276'
typography:
  display:
    fontFamily: '"Nunito Sans", system-ui, sans-serif'
    fontSize: 'clamp(2.3rem, 6vw, 4.8rem)'
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: '-0.025em'
  collection-title:
    fontFamily: '"Nunito Sans", system-ui, sans-serif'
    fontSize: 'clamp(2rem, 4vw, 3.2rem)'
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: '-0.025em'
  headline:
    fontFamily: '"Nunito Sans", system-ui, sans-serif'
    fontSize: 'clamp(1.35rem, 2.5vw, 2rem)'
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: '-0.025em'
  body:
    fontFamily: '"Nunito Sans", system-ui, sans-serif'
    fontSize: '1rem'
    fontWeight: 400
    lineHeight: 1.55
  lede:
    fontFamily: '"Nunito Sans", system-ui, sans-serif'
    fontSize: 'clamp(1.1rem, 2vw, 1.3rem)'
    fontWeight: 400
    lineHeight: 1.55
  control:
    fontFamily: '"Nunito Sans", system-ui, sans-serif'
    fontSize: '1rem'
    fontWeight: 500
    lineHeight: 1.55
  label:
    fontFamily: '"Nunito Sans", system-ui, sans-serif'
    fontSize: '0.9rem'
    fontWeight: 500
    lineHeight: 1.55
  eyebrow:
    fontFamily: '"Nunito Sans", system-ui, sans-serif'
    fontSize: '0.8rem'
    fontWeight: 500
    lineHeight: 1.55
    letterSpacing: '0.12em'
rounded:
  status-option: '10px'
  control: '12px'
  inset: '14px'
  surface: '18px'
  pill: '999px'
spacing:
  micro: '0.25rem'
  compact: '0.5rem'
  control: '0.75rem'
  standard: '1rem'
  section: '2rem'
components:
  button-primary-light:
    backgroundColor: '{colors.collector-teal}'
    textColor: '{colors.primary-ink-light}'
    typography: '{typography.control}'
    rounded: '{rounded.control}'
    padding: '0.6rem 1rem'
  button-primary-dark:
    backgroundColor: '{colors.night-collector-teal}'
    textColor: '{colors.night-primary-ink}'
    typography: '{typography.control}'
    rounded: '{rounded.control}'
    padding: '0.6rem 1rem'
  button-secondary-light:
    backgroundColor: '{colors.paper-surface}'
    textColor: '{colors.deep-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '0.6rem 1rem'
  button-secondary-dark:
    backgroundColor: '{colors.night-surface}'
    textColor: '{colors.night-ink}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '0.6rem 1rem'
  field-light:
    backgroundColor: '{colors.paper-surface}'
    textColor: '{colors.deep-ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '0.55rem 0.7rem'
  field-dark:
    backgroundColor: '{colors.night-surface}'
    textColor: '{colors.night-ink}'
    typography: '{typography.body}'
    rounded: '{rounded.control}'
    padding: '0.55rem 0.7rem'
  surface-light:
    backgroundColor: '{colors.paper-surface}'
    textColor: '{colors.deep-ink}'
    rounded: '{rounded.surface}'
    padding: 'clamp(1rem, 3vw, 2rem)'
  surface-dark:
    backgroundColor: '{colors.night-surface}'
    textColor: '{colors.night-ink}'
    rounded: '{rounded.surface}'
    padding: 'clamp(1rem, 3vw, 2rem)'
  item-row-light:
    backgroundColor: '{colors.paper-surface}'
    textColor: '{colors.deep-ink}'
    rounded: '{rounded.surface}'
    padding: '0.8rem'
  item-row-dark:
    backgroundColor: '{colors.night-surface}'
    textColor: '{colors.night-ink}'
    rounded: '{rounded.surface}'
    padding: '0.8rem'
---

# Design System: Snoredex Checklist

## Overview

**Creative North Star: "The Calm Collector's Desk"**

The interface should feel like a carefully arranged place to sort a collection: calm enough for a
long session, tactile enough to feel personal, and precise enough to support evidence-sensitive
decisions. Warm paper tones and softened teal layers make the catalogue approachable without
turning it into a toy. The collection application stays operational and scan-friendly; expression
comes through restrained color, generous touch geometry, and small material cues.

The voice is calm, trustworthy, softly tactile, and friendly without childishness. The system does
not mimic official Pokémon artwork or product UI, does not borrow the flash of a game dashboard,
and does not collapse into clinical database styling. Its visual character supports the product's
careful language about privacy, provenance, and uncertainty.

**Key Characteristics:**

- Warm cream and ink neutrals anchored by Collector Teal.
- Paired light and dark themes with the same semantic hierarchy.
- Rounded, generous controls and softly layered working surfaces.
- Compact collector rows that keep identity, evidence, and private controls distinct.
- Visible focus, non-color cues, and calm motion that respects reduced-motion preferences.

## Colors

The palette pairs a quiet collector-workspace warmth with cool teal structure. Light and dark modes
are equal expressions of the same system rather than an inverted afterthought.

### Primary

- **Collector Teal** (`colors.collector-teal`): primary actions, links, progress accents, and the
  eyebrow that introduces a page.
- **Night Collector Teal** (`colors.night-collector-teal`): the accessible dark-theme counterpart.
- **Pale Collector Teal** (`colors.pale-collector-teal`) and **Night Primary Soft**
  (`colors.night-primary-soft`): selected, empty, or gently emphasized regions that should not read
  as alerts.

### Secondary

- **Quiet Seafoam** (`colors.quiet-seafoam`) and **Night Seafoam** (`colors.night-seafoam`): calm
  supporting accents; they should never compete with the primary action.

### Tertiary

- **Binder Gold** (`colors.binder-gold`) and **Night Binder Gold**
  (`colors.night-binder-gold`): warm highlights that evoke collection materials without becoming a
  reward mechanic.
- **Amber Focus** (`colors.amber-focus`) and **Night Focus** (`colors.night-focus`): unmistakable
  keyboard focus rings, kept visually separate from selection or warning state.
- **Soft Coral Warning** (`colors.soft-coral-warning`) and **Night Coral Warning**
  (`colors.night-coral-warning`): failure and blocked-state boundaries; pair them with explicit text.

### Neutral

- **Resting Cream** (`colors.resting-cream`) and **Night Page** (`colors.night-page`): page canvas.
- **Paper Surface** (`colors.paper-surface`) and **Night Surface** (`colors.night-surface`): primary
  working surfaces, fields, cards, and dialogs.
- **Quiet Parchment** (`colors.quiet-parchment`) and **Night Soft Layer** (`colors.night-soft`):
  inset controls, progress regions, and private collection controls.
- **Deep Ink** (`colors.deep-ink`) and **Night Ink** (`colors.night-ink`): primary readable text.
- **Muted Slate** (`colors.muted-slate`) and **Night Muted** (`colors.night-muted`): supporting copy,
  labels, metadata, and provenance terms.
- **Paper Border**, **Control Slate**, **Night Border**, and **Night Control**: quiet structural
  boundaries with the stronger control colors reserved for editable fields.

**The Paired Theme Rule.** Components use semantic theme variables. Do not hard-code a light or dark
color inside a reusable component.

**The Quiet Accent Rule.** Collector Teal establishes action and orientation; Binder Gold and
Seafoam support it and never turn collection progress into gamified celebration.

## Typography

**Display Font:** Nunito Sans

**Body Font:** Nunito Sans

**Character:** Nunito Sans gives the interface a soft, human rhythm without becoming childish.
Hierarchy comes from scale, the 400/500 weight pair, spacing, and contrast rather than a decorative
font pairing. A system-UI fallback preserves legibility while the small self-hosted files load and
for scripts outside the Latin subset.

### Hierarchy

- **Display** (`typography.display`): the marketing index hero only; bold, fluid, and tightly tracked.
- **Collection title** (`typography.collection-title`): a calmer page-level title for the work view.
- **Headline** (`typography.headline`): section hierarchy and meaningful collection milestones.
- **Body** (`typography.body`): catalogue explanation, metadata, and task copy.
- **Lede** (`typography.lede`): short introductory copy capped at a readable measure.
- **Control** (`typography.control`): primary button text and strong interactive labels.
- **Label** (`typography.label`): form labels, metadata headings, and secondary controls.
- **Eyebrow** (`typography.eyebrow`): sparse uppercase orientation text, never ordinary body copy.

**The Single-Family Clarity Rule.** Keep Nunito Sans as the sole authored family. Do not introduce a
display font merely for novelty; the system earns personality through composition and material
color while preserving a dependable system fallback.

**The Tight Heading Rule.** Large headings use compact line-height and modest negative tracking;
body and control text retain the relaxed reading rhythm.

## Layout

The site uses one centered page shell with an 1180px maximum and fluid edge padding. The collection
work view narrows to 960px, while the index hero holds to 760px so the headline and lede retain a
clear reading measure. The index flows from the hero into a concise proof surface and then a grouped
directory. Collection filters keep search, localization, set, and the submit action in the primary
flow; status, kind, and research filters stay in a secondary disclosure. Item rows place a fixed
image rail beside flexible identity and controls.

Spacing follows a compact 4px/8px/12px/16px/32px rhythm, with responsive `clamp()` values reserved
for page padding, hero breathing room, and major surface padding. At 900px the split view, filter
grids, and detail definitions become one column. At 520px item rows stack and the image rail becomes
slightly smaller. No layout may shrink below the 320px product floor.

**The Work Surface Rule.** Keep the collection column compact enough to scan; use width for readable
identity and controls, not for ornamental emptiness.

**The Progressive Detail Rule.** Evidence, recovery, and dense metadata stay in native disclosure
patterns until the collector asks for them.

## Elevation & Depth

The system uses soft ambient layering. Tonal contrast and borders carry most structural depth;
shadows gently separate major surfaces, normal item rows, and dialogs from the page. Inset progress
and collection-control regions stay shadowless. Research rows remove lift and use a dashed boundary
to communicate provisional status without color alone.

### Shadow Vocabulary

- **Ambient surface:** a broad, low-contrast shadow for major surfaces and modal dialogs.
- **Collector row:** a smaller, lighter shadow that separates trackable items from their set group.
- **Backdrop:** a translucent dark veil used only behind a modal image inspection.

**The Ambient, Not Altitude Rule.** Shadows suggest paper resting on a desk; they do not create a
stack of floating application layers.

**The Research Stays Grounded Rule.** Read-only research rows use no shadow. Their dashed boundary
is the durable cue that they are not ordinary collection items.

## Shapes

The form language is gently rounded and practical. Controls use the 12px control radius, nested
progress and private-state regions use 14px, and large surfaces, rows, and dialogs use 18px. Status
options tighten to 10px so grouped radios remain compact. Fully rounded pills are reserved for
short scope or tag-like labels; ordinary buttons and containers never become capsules.

Borders are quiet and continuous for confirmed working surfaces. Dashed borders denote research or
empty conditions, and the stronger control border marks editable input. Card-image placeholders and
their inspection buttons share the inset radius so image and interaction read as one object.

**The Three-Radius Rule.** Most interface geometry belongs to control, inset, or surface scale.
Introduce another radius only when the object's physical role is genuinely different.

## Components

Components feel tactile and reassuring: generous enough for touch, quiet enough for long collection
sessions, and explicit about state.

### Buttons

- **Shape:** gently rounded controls (`rounded.control`) with a 44px minimum target.
- **Primary:** Collector Teal with paired primary ink, medium Nunito Sans, and compact horizontal
  padding.
- **Hover / Focus:** retain the stable fill; keyboard focus uses the three-pixel Amber Focus outline
  with a visible offset.
- **Secondary:** Paper or Night Surface with normal ink, used for theme, retry, recovery, and other
  supporting actions.

### Cards / Containers

- **Corner Style:** large working surfaces and item rows use the surface radius.
- **Background:** page-level surfaces use Paper or Night Surface; nested private controls use Quiet
  Parchment or Night Soft Layer.
- **Shadow Strategy:** ambient on major surfaces and trackable rows; none on inset or research state.
- **Border:** quiet theme border, dashed when the content is provisional or empty.
- **Internal Padding:** fluid for major surfaces, compact for high-density collector rows.

### Inputs / Fields

- **Style:** surface-colored native inputs with the stronger control border and control radius.
- **Focus:** the shared Amber Focus outline, never a color-only border change.
- **Error / Disabled:** preserve the field geometry; explain failure with fixed text and a visible
  state boundary rather than reflecting private or untrusted values.

### Navigation

The header uses a weighty text brand and a quiet theme control. Localization navigation is a
semantic directory grouped by producer-owned locality; human labels are display-only, while links
retain stable localization IDs. Links receive a pale teal hover/focus background and retain readable
underlines outside button-like treatments. Breadcrumbs and footer metadata use muted ink and wrap
safely.

### Progress Panel

Progress lives on the soft tonal layer with a compact heading, explanatory counts, and a native
progress element accented in Collector Teal. Research counts remain separate in both copy and
structure. Empty or research-only views switch to the pale primary layer rather than a warning color.

### Collector Item Row

The signature row aligns a compact card-shaped image or placeholder with flexible identity,
metadata, evidence cues, and private controls. The English name leads; local name and set identity
remain adjacent but subordinate. Trackable rows may lift slightly. Research rows stay grounded,
dashed, read-only, and visibly separate from collection controls.

### Collection Controls

Private controls sit inside one soft inset region. All four statuses remain visible as a native radio
group for one-tap updates. Quantities appear in a collapsed native disclosure only for Have and
Ordered, with owned and ordered counts summarized in its label. Notes appear progressively; save and
recovery feedback occupies a stable live region, and Retry appears only after a failed write. The
component must wrap without horizontal scrolling and preserve 44px targets.

### Catalogue Provenance

Public provenance leads with a human summary such as “Catalogue verified · Data as of …”. The
contract version, revisions, fingerprint, and other technical receipt fields remain available inside
a native disclosure. Fixture mode is named explicitly and never presented as verified catalogue
data.

### Dialogs

Image inspection and destructive confirmation use native dialogs with the surface radius, theme
border, ambient shadow, and a dark backdrop. The content stays compact, focus is placed deliberately,
and the same action hierarchy as the page is preserved.

## Do's and Don'ts

### Do:

- **Do** use semantic theme variables so light and dark modes preserve the same hierarchy.
- **Do** reserve Collector Teal for action, orientation, links, and progress.
- **Do** use tonal layers and quiet borders before reaching for stronger shadow.
- **Do** keep collection rows compact while preserving readable identity and 44px controls.
- **Do** pair uncertainty, warning, research, and save state with explicit text and non-color cues.
- **Do** preserve the 320px reflow floor, visible focus, reduced motion, and forced-color behavior.

### Don't:

- **Don't** mimic official Pokémon artwork, silhouettes, trading-card UI, or game-dashboard effects.
- **Don't** make the interface childish, neon, celebratory, or gamified.
- **Don't** flatten the product into a clinical table or generic admin dashboard.
- **Don't** wrap every nested region in another elevated card; inset layers are tonal and flat.
- **Don't** use pill shapes for ordinary buttons, fields, surfaces, or long labels.
- **Don't** use shadow, color, or imagery to imply that research is a verified physical printing.
