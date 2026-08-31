# Cyclomatic complexity baseline

> Advisory lexical estimate; this is not a release gate or a conformance claim.

Scope: `src/` and `scripts/` (32 production code files).
Lines: 12,901.
Function-like nodes: 997.
McCabe estimate: sum 3,905; mean 3.9; median 2; P90 9; P95 16.
Hotspots: 83 functions exceed 10; 35 exceed 20.

The estimate counts if/for/while/do/catch/case statements, conditional `?` tokens and `&&`/`||`/`??` operators inside function-like bodies. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.

| Location                            | Function                        | Complexity |
| ----------------------------------- | ------------------------------- | ---------: |
| `src/state/storage.ts:705`          | `persistPendingNoteDraft`       |         60 |
| `src/state/reconciliation.ts:513`   | `reconcilePrivateState`         |         55 |
| `src/catalogue/validate.ts:416`     | `validateCatalogueFixture`      |         54 |
| `scripts/complexity-report.mjs:442` | `findArrowExpressionEnd`        |         47 |
| `src/site/catalogue.ts:337`         | `for`                           |         46 |
| `scripts/check-artifact.mjs:1311`   | `extractHead`                   |         45 |
| `src/site/query.ts:31`              | `parseQuery`                    |         39 |
| `scripts/complexity-report.mjs:739` | `collectFunctions`              |         37 |
| `scripts/complexity-report.mjs:655` | `findStatementEnd`              |         36 |
| `src/state/storage.ts:1142`         | `setDraftOwnerState`            |         35 |
| `scripts/check-artifact.mjs:239`    | `stripHtmlComments`             |         32 |
| `src/catalogue/sync.ts:517`         | `parseJournal`                  |         31 |
| `src/catalogue/validate.ts:307`     | `for`                           |         31 |
| `src/site/catalogue.ts:223`         | `validateSnapshot`              |         30 |
| `src/site/deployment.ts:24`         | `validatePagesDeployment`       |         30 |
| `src/state/reconciliation.ts:167`   | `migrationIsStructurallyValid`  |         28 |
| `src/catalogue/sync.ts:763`         | `syncCataloguePair`             |         27 |
| `src/site/app.ts:1410`              | `for`                           |         27 |
| `scripts/check-artifact.mjs:67`     | `readAttribute`                 |         26 |
| `scripts/check-artifact.mjs:703`    | `isJavaScriptMethodNameContext` |         26 |
