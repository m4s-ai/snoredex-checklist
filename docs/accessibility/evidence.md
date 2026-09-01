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

The following checks require a real supported device or assistive technology session. They are
release gates and must be filled in by the owner before claiming complete WCAG 2.2 AA and browser
support coverage. A pending row is not evidence of a pass.

| Check                                        | Required environment                        | Result                                                                                   | Evidence / date |
| -------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------- |
| Keyboard-only browse, edit, dialog, recovery | Latest supported desktop browser            | Covered by automated keyboard flow above; owner visual confirmation pending              | —               |
| Windows screen reader and keyboard           | Supported Windows release + screen reader   | Pending owner run                                                                        | —               |
| VoiceOver with Safari                        | Supported macOS + Safari                    | Pending owner run                                                                        | —               |
| VoiceOver with Safari on iOS                 | Supported iPhone/iOS release                | Pending owner run                                                                        | —               |
| Touch, orientation, 320px reflow, 200% text  | Real phone/tablet in portrait and landscape | Automated 320px/200% gate passes; real-device confirmation pending                       | —               |
| Contrast, forced colors, reduced motion      | Supported desktop browser/OS settings       | Reduced-motion automated gate passes; forced-colors and OS contrast confirmation pending | —               |

When completing a row, record the browser/OS/device, date, tested route and a short result here.
Use synthetic data only; never attach private collection state, personal images, or identifying
screen recordings.
