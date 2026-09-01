# Cyclomatic complexity baseline

> Advisory AST-derived estimate; this is not a release gate or a conformance claim.

Scope: `src/` and `scripts/` (32 production code files).
Lines: 11,936.
Function-like nodes: 735.
McCabe estimate: sum 3,601; mean 4.9; median 2; P90 11; P95 21.
Hotspots: 81 functions exceed 10; 38 exceed 20.

The report parses each source file with the bundled TypeScript compiler and counts runtime function-like declarations plus structural decision nodes: if/for/while/do/catch/case statements, conditional expressions and logical (&&/||/??) binary expressions. Type-only function signatures and nested function bodies are excluded from their enclosing function. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.

| Location                          | Function                        | Complexity |
| --------------------------------- | ------------------------------- | ---------: |
| `src/site/catalogue.ts:223`       | `validateSnapshot`              |         90 |
| `src/state/storage.ts:705`        | `persistPendingNoteDraft`       |         75 |
| `src/site/app.ts:1319`            | `renderResults`                 |         68 |
| `src/catalogue/validate.ts:235`   | `validateSemantics`             |         56 |
| `src/state/reconciliation.ts:513` | `reconcilePrivateState`         |         55 |
| `src/catalogue/validate.ts:416`   | `validateCatalogueFixture`      |         54 |
| `scripts/check-artifact.mjs:1311` | `extractHead`                   |         45 |
| `src/site/query.ts:31`            | `parseQuery`                    |         39 |
| `src/state/storage.ts:1142`       | `setDraftOwnerState`            |         36 |
| `src/catalogue/sync.ts:517`       | `parseJournal`                  |         34 |
| `scripts/check-artifact.mjs:239`  | `stripHtmlComments`             |         32 |
| `src/state/domain.ts:211`         | `parseState`                    |         32 |
| `src/site/deployment.ts:24`       | `validatePagesDeployment`       |         31 |
| `src/state/backup.ts:289`         | `writeAuthority`                |         30 |
| `src/catalogue/sync.ts:763`       | `syncCataloguePair`             |         29 |
| `src/site/catalogue.ts:93`        | `validateProvenance`            |         29 |
| `src/state/reconciliation.ts:167` | `migrationIsStructurallyValid`  |         28 |
| `src/state/domain.ts:148`         | `normalizeRecordForImport`      |         27 |
| `scripts/check-artifact.mjs:67`   | `readAttribute`                 |         26 |
| `scripts/check-artifact.mjs:703`  | `isJavaScriptMethodNameContext` |         26 |
