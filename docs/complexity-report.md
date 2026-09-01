# Cyclomatic complexity baseline

> Advisory AST-derived estimate; this is not a release gate or a conformance claim.

Scope: `src/` and `scripts/` (33 production code files).
Lines: 11,615.
Function-like nodes: 745.
McCabe estimate: sum 3,378; mean 4.5; median 2; P90 9; P95 16.
Hotspots: 68 functions exceed 10; 33 exceed 20.

The report parses each source file with the bundled TypeScript compiler and counts runtime function-like declarations plus structural decision nodes: if/for/while/do/catch/case statements, conditional expressions and logical (&&/||/??) binary expressions. Type-only function signatures and nested function bodies are excluded from their enclosing function. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.

| Location                            | Function                         | Complexity |
| ----------------------------------- | -------------------------------- | ---------: |
| `src/site/catalogue.ts:223`         | `validateSnapshot`               |         90 |
| `src/state/storage.ts:705`          | `persistPendingNoteDraft`        |         75 |
| `src/site/app.ts:1425`              | `renderResults`                  |         58 |
| `src/catalogue/validate.ts:235`     | `validateSemantics`              |         56 |
| `src/state/reconciliation.ts:513`   | `reconcilePrivateState`          |         55 |
| `src/catalogue/validate.ts:416`     | `validateCatalogueFixture`       |         54 |
| `scripts/catalogue-release.mjs:127` | `createCatalogueReleaseManifest` |         50 |
| `scripts/check-artifact.mjs:517`    | `extractHead`                    |         45 |
| `src/state/storage.ts:1142`         | `setDraftOwnerState`             |         36 |
| `src/catalogue/sync.ts:517`         | `parseJournal`                   |         34 |
| `scripts/check-artifact.mjs:241`    | `stripHtmlComments`              |         32 |
| `src/state/domain.ts:211`           | `parseState`                     |         32 |
| `src/site/deployment.ts:24`         | `validatePagesDeployment`        |         31 |
| `src/state/backup.ts:289`           | `writeAuthority`                 |         30 |
| `src/catalogue/sync.ts:763`         | `syncCataloguePair`              |         29 |
| `src/site/catalogue.ts:93`          | `validateProvenance`             |         29 |
| `src/site/query.ts:57`              | `criteriaFromParameters`         |         28 |
| `src/state/reconciliation.ts:167`   | `migrationIsStructurallyValid`   |         28 |
| `src/state/domain.ts:148`           | `normalizeRecordForImport`       |         27 |
| `scripts/check-artifact.mjs:69`     | `readAttribute`                  |         26 |
