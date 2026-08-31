# Cyclomatic complexity baseline

> Advisory lexical estimate; this is not a release gate or a conformance claim.

Scope: `src/` and `scripts/` (32 production code files).
Lines: 13,826.
Function-like nodes: 776.
McCabe estimate: sum 4,124; mean 5.3; median 2; P90 13; P95 22.
Hotspots: 100 functions exceed 10; 45 exceed 20.

The estimate counts if/for/while/do/catch/case statements, conditional `?` tokens and `&&`/`||`/`??` operators inside function-like bodies. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.

| Location                             | Function                     | Complexity |
| ------------------------------------ | ---------------------------- | ---------: |
| `src/site/catalogue.ts:223`          | `validateSnapshot`           |         90 |
| `src/state/storage.ts:705`           | `persistPendingNoteDraft`    |         75 |
| `src/site/app.ts:1319`               | `renderResults`              |         68 |
| `src/catalogue/validate.ts:235`      | `validateSemantics`          |         56 |
| `src/state/reconciliation.ts:513`    | `reconcilePrivateState`      |         55 |
| `src/catalogue/validate.ts:416`      | `validateCatalogueFixture`   |         54 |
| `scripts/complexity-report.mjs:1299` | `collectFunctions`           |         48 |
| `scripts/complexity-report.mjs:782`  | `findArrowExpressionEnd`     |         47 |
| `scripts/check-artifact.mjs:1311`    | `extractHead`                |         45 |
| `src/site/query.ts:31`               | `parseQuery`                 |         39 |
| `scripts/complexity-report.mjs:1215` | `findStatementEnd`           |         36 |
| `src/state/storage.ts:1142`          | `setDraftOwnerState`         |         36 |
| `src/catalogue/sync.ts:517`          | `parseJournal`               |         34 |
| `scripts/complexity-report.mjs:273`  | `isSemicolonlessClassMethod` |         33 |
| `scripts/check-artifact.mjs:239`     | `stripHtmlComments`          |         32 |
| `src/state/domain.ts:211`            | `parseState`                 |         32 |
| `src/site/deployment.ts:24`          | `validatePagesDeployment`    |         31 |
| `src/state/backup.ts:289`            | `writeAuthority`             |         30 |
| `src/catalogue/sync.ts:763`          | `syncCataloguePair`          |         29 |
| `src/site/catalogue.ts:93`           | `validateProvenance`         |         29 |
