# Cyclomatic complexity baseline

> Advisory lexical estimate; this is not a release gate or a conformance claim.

Scope: `src/` and `scripts/` (32 production code files).
Lines: 13,471.
Function-like nodes: 771.
McCabe estimate: sum 4,022; mean 5.2; median 2; P90 13; P95 22.
Hotspots: 96 functions exceed 10; 43 exceed 20.

The estimate counts if/for/while/do/catch/case statements, conditional `?` tokens and `&&`/`||`/`??` operators inside function-like bodies. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.

| Location                             | Function                   | Complexity |
| ------------------------------------ | -------------------------- | ---------: |
| `src/site/catalogue.ts:223`          | `validateSnapshot`         |         90 |
| `src/state/storage.ts:705`           | `persistPendingNoteDraft`  |         75 |
| `src/site/app.ts:1319`               | `renderResults`            |         68 |
| `src/catalogue/validate.ts:235`      | `validateSemantics`        |         56 |
| `src/state/reconciliation.ts:513`    | `reconcilePrivateState`    |         55 |
| `src/catalogue/validate.ts:416`      | `validateCatalogueFixture` |         54 |
| `scripts/complexity-report.mjs:592`  | `findArrowExpressionEnd`   |         47 |
| `scripts/check-artifact.mjs:1311`    | `extractHead`              |         45 |
| `scripts/complexity-report.mjs:1084` | `collectFunctions`         |         44 |
| `src/site/query.ts:31`               | `parseQuery`               |         39 |
| `scripts/complexity-report.mjs:1000` | `findStatementEnd`         |         36 |
| `src/state/storage.ts:1142`          | `setDraftOwnerState`       |         36 |
| `src/catalogue/sync.ts:517`          | `parseJournal`             |         34 |
| `scripts/check-artifact.mjs:239`     | `stripHtmlComments`        |         32 |
| `src/state/domain.ts:211`            | `parseState`               |         32 |
| `src/site/deployment.ts:24`          | `validatePagesDeployment`  |         31 |
| `src/state/backup.ts:289`            | `writeAuthority`           |         30 |
| `src/catalogue/sync.ts:763`          | `syncCataloguePair`        |         29 |
| `src/site/catalogue.ts:93`           | `validateProvenance`       |         29 |
| `scripts/complexity-report.mjs:256`  | `isTypedFunctionBody`      |         28 |
