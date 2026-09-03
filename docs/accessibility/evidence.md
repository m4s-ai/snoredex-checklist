# Accessibility and responsive evidence

This record supports issue #27 and is deliberately limited to synthetic fixture data. It is
evidence for the tested build, not a blanket conformance claim for every browser, assistive
technology, or future catalogue snapshot.

## Automated browser evidence

Recorded 2026-08-28 with the repository-pinned Node.js 26.7.0/npm 11.19.0 toolchain:

```text
npm run format:check       PASS
npm run test:accessibility PASS
```

`test:accessibility` exercises Chromium, Firefox, and WebKit at 1280x900, 320x736, 360x800 and
736x900. Each engine/viewport run covers the home and collection landmarks, skip-link and
keyboard navigation, system-dark detection plus a persisted manual theme override, synthetic
status and private-note editing, hover/focus/click/touch image inspection, dialog
open/close/Escape handling, research read-only filtering, invalid-link recovery, reduced-motion
media behavior, touch-target size, horizontal-overflow checks, long/non-Latin labels, and 200%
text resizing. Axe scans run on the rendered home, collection, and open-dialog states; no critical
or serious violations were reported.

The browser harness uses only the reviewed synthetic fixture and fails on unexpected network
requests. No private collection state or personal card images are included in this record.

### Manual-review remediation — 2026-09-01

Owner review of the deployed Indonesian research-only view exposed usability failures that the
initial automated checks did not catch. The remediation removes the always-expanded catalogue
tree, uses native localization and set pickers, keeps advanced filters collapsed, replaces opaque
ID fallback labels with neutral unidentified-set labels, removes zero-total progress bars, explains
why research rows have no collection controls, simplifies item cards and collapses backup and
catalogue provenance panels.

The final remediation build passed the complete unit/security and contract suites, Chromium,
Firefox and WebKit browser smoke, and all 12 accessibility combinations above. Focused regressions
also prove that a research-only edition has no status radios or progress bar, contains no visible
`LOCALSET:` or `EDITION:` identifier, and has no horizontal page overflow. This automated evidence
does not replace the owner-run assistive-technology and real-device rows below.

## Manual release evidence

The owner completed the manual matrix on 2026-09-02 against deployed application revision
`60143d264c250a448ea92f7546122e9e2e7533f4`. Every requested representative flow passed and no
release-blocking accessibility or supported-browser defect was reported.

| Check                                                               | Environment                                                              | Result | Evidence / date                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- |
| Keyboard-only browse, edit, dialog, validation, backup and recovery | Supported desktop browser                                                | PASS   | [Owner acceptance](https://github.com/m4s-ai/snoredex-checklist/issues/27#issuecomment-5509760967), 2026-09-02 |
| Windows screen reader and keyboard                                  | Windows 11 Pro build 26200, Edge 151.0.4129.78, Narrator 10.0.26100.8875 | PASS   | [Owner acceptance](https://github.com/m4s-ai/snoredex-checklist/issues/27#issuecomment-5509760967), 2026-09-02 |
| VoiceOver with Safari                                               | macOS and Safari; exact versions not supplied                            | PASS   | [Owner acceptance](https://github.com/m4s-ai/snoredex-checklist/issues/27#issuecomment-5509760967), 2026-09-02 |
| VoiceOver with Safari on iOS                                        | iOS and Safari; exact device/version not supplied                        | PASS   | [Owner acceptance](https://github.com/m4s-ai/snoredex-checklist/issues/27#issuecomment-5509760967), 2026-09-02 |
| Touch, portrait/landscape, narrow reflow and 200% zoom              | Real narrow device plus desktop zoom; exact device/version not supplied  | PASS   | [Owner acceptance](https://github.com/m4s-ai/snoredex-checklist/issues/27#issuecomment-5509760967), 2026-09-02 |
| Forced colors/high contrast, light/dark and reduced motion          | Supported desktop browser and OS settings                                | PASS   | [Owner acceptance](https://github.com/m4s-ai/snoredex-checklist/issues/27#issuecomment-5509760967), 2026-09-02 |

The acceptance covered spoken and visible names, states and announcements; focus order; status and
quantity editing; image-dialog operation; direct `/` and `/collection/` loads; touch targets;
reflow; and recovery. Exact Apple and physical-device versions were not supplied, so none are
invented here. All evidence used the required synthetic-only scope and contains no private
collection data.

## Post-acceptance regression evidence

Later product-interface work in [issue #79](https://github.com/m4s-ai/snoredex-checklist/issues/79)
kept search primary, made status changes one tap, revealed quantities contextually, bounded result
mounting, and simplified homepage and provenance presentation. Its final build passed Chromium,
Firefox, and WebKit browser smoke and all 12 accessibility engine/viewport configurations. The
runtime-coherence work in [issue #81](https://github.com/m4s-ai/snoredex-checklist/issues/81) also
passed those 12 configurations and introduced no intentional interaction redesign.

Those automated regressions support the later builds; they do not retroactively turn the dated
manual session into a blanket claim for every future revision, browser, assistive technology, or
catalogue snapshot. A future material interaction change must update its owning issue and rerun the
appropriate manual rows.
