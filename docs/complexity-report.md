# Cyclomatic complexity baseline

> Advisory AST-derived estimate; this is not a release gate or a conformance claim.

Scope: `src/` and `scripts/` (38 production code files).
Lines: 15,001.
Function-like nodes: 924.
McCabe estimate: sum 4,370; mean 4.7; median 2; P90 10; P95 19.
Hotspots: 91 functions exceed 10; 41 exceed 20.

The report parses each source file with the bundled TypeScript compiler and counts runtime function-like declarations plus structural decision nodes: if/for/while/do/catch/case statements, conditional expressions and logical (&&/||/??) binary expressions. Type-only function signatures and nested function bodies are excluded from their enclosing function. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.

| Location                                  | Function                         | Complexity |
| ----------------------------------------- | -------------------------------- | ---------: |
| `src/site/catalogue.ts:237`               | `validateSnapshot`               |         90 |
| `src/state/storage.ts:716`                | `persistPendingNoteDraft`        |         75 |
| `src/site/app.ts:1691`                    | `renderResults`                  |         74 |
| `src/state/reconciliation.ts:515`         | `reconcilePrivateState`          |         58 |
| `src/catalogue/validate.ts:235`           | `validateSemantics`              |         56 |
| `src/catalogue/validate.ts:416`           | `validateCatalogueFixture`       |         54 |
| `src/state/backup.ts:1086`                | `<arrow>`                        |         54 |
| `scripts/catalogue-release.mjs:127`       | `createCatalogueReleaseManifest` |         50 |
| `scripts/check-artifact.mjs:554`          | `extractHead`                    |         45 |
| `src/state/backup.ts:754`                 | `writeAuthority`                 |         42 |
| `src/site/deployment.ts:38`               | `validatePagesDeployment`        |         40 |
| `src/state/storage.ts:1153`               | `setDraftOwnerState`             |         36 |
| `src/catalogue/sync.ts:517`               | `parseJournal`                   |         34 |
| `scripts/check-artifact.mjs:278`          | `stripHtmlComments`              |         32 |
| `src/state/domain.ts:211`                 | `parseState`                     |         32 |
| `src/catalogue/sync.ts:763`               | `syncCataloguePair`              |         29 |
| `src/site/app.ts:1387`                    | `refresh`                        |         29 |
| `src/site/catalogue.ts:93`                | `validateProvenance`             |         29 |
| `src/site/query.ts:57`                    | `criteriaFromParameters`         |         28 |
| `src/state/browser-reconciliation.ts:127` | `writeAuthority`                 |         28 |
