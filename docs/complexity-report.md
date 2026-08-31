# Cyclomatic complexity baseline

> Advisory lexical estimate; this is not a release gate or a conformance claim.

Scope: `src/` and `scripts/` (32 production code files).
Lines: 13,063.
Function-like nodes: 835.
McCabe estimate: sum 3,952; mean 4.7; median 2; P90 11; P95 21.
Hotspots: 88 functions exceed 10; 42 exceed 20.

The estimate counts if/for/while/do/catch/case statements, conditional `?` tokens and `&&`/`||`/`??` operators inside function-like bodies. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.

| Location                            | Function                       | Complexity |
| ----------------------------------- | ------------------------------ | ---------: |
| `src/site/catalogue.ts:223`         | `validateSnapshot`             |         90 |
| `src/site/app.ts:1319`              | `renderResults`                |         68 |
| `src/state/storage.ts:705`          | `persistPendingNoteDraft`      |         60 |
| `src/catalogue/validate.ts:235`     | `validateSemantics`            |         56 |
| `src/state/reconciliation.ts:513`   | `reconcilePrivateState`        |         55 |
| `src/catalogue/validate.ts:416`     | `validateCatalogueFixture`     |         54 |
| `scripts/complexity-report.mjs:536` | `findArrowExpressionEnd`       |         47 |
| `scripts/check-artifact.mjs:1311`   | `extractHead`                  |         45 |
| `src/site/query.ts:31`              | `parseQuery`                   |         39 |
| `scripts/complexity-report.mjs:857` | `collectFunctions`             |         38 |
| `scripts/complexity-report.mjs:773` | `findStatementEnd`             |         36 |
| `src/state/storage.ts:1142`         | `setDraftOwnerState`           |         35 |
| `src/catalogue/sync.ts:517`         | `parseJournal`                 |         34 |
| `scripts/check-artifact.mjs:239`    | `stripHtmlComments`            |         32 |
| `src/state/domain.ts:211`           | `parseState`                   |         32 |
| `src/site/deployment.ts:24`         | `validatePagesDeployment`      |         31 |
| `src/state/backup.ts:289`           | `writeAuthority`               |         30 |
| `src/catalogue/sync.ts:763`         | `syncCataloguePair`            |         29 |
| `src/site/catalogue.ts:93`          | `validateProvenance`           |         29 |
| `src/state/reconciliation.ts:167`   | `migrationIsStructurallyValid` |         28 |
