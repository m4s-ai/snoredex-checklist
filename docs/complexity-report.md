# Cyclomatic complexity baseline

> Advisory lexical estimate; this is not a release gate or a conformance claim.

Scope: `src/` and `scripts/` (32 production code files).
Lines: 12,846.
Function-like nodes: 1,550.
McCabe estimate: sum 4,027; mean 2.6; median 1; P90 5; P95 8.
Hotspots: 53 functions exceed 10; 11 exceed 20.

The estimate counts if/for/while/do/catch/case statements, conditional `?` tokens and `&&`/`||`/`??` operators inside function-like bodies. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.

| Location                            | Function                           | Complexity |
| ----------------------------------- | ---------------------------------- | ---------: |
| `scripts/complexity-report.mjs:449` | `for`                              |         41 |
| `src/catalogue/validate.ts:435`     | `for`                              |         37 |
| `src/site/catalogue.ts:337`         | `for`                              |         37 |
| `src/site/query.ts:31`              | `parseQuery`                       |         32 |
| `src/catalogue/sync.ts:517`         | `parseJournal`                     |         31 |
| `src/site/catalogue.ts:223`         | `validateSnapshot`                 |         30 |
| `src/site/deployment.ts:24`         | `validatePagesDeployment`          |         30 |
| `src/site/catalogue.ts:93`          | `validateProvenance`               |         25 |
| `scripts/check-artifact.mjs:758`    | `isJavaScriptRegexStart`           |         23 |
| `src/state/reconciliation.ts:513`   | `reconcilePrivateState`            |         21 |
| `src/state/storage.ts:1931`         | `parseDraftReference`              |         21 |
| `src/catalogue/sync.ts:385`         | `lockIsValid`                      |         20 |
| `src/catalogue/sync.ts:690`         | `readCommittedCataloguePairUnsafe` |         20 |
| `src/catalogue/sync.ts:763`         | `syncCataloguePair`                |         20 |
| `src/state/domain.ts:148`           | `normalizeRecordForImport`         |         20 |
| `scripts/check-artifact.mjs:106`    | `while`                            |         19 |
| `src/catalogue/validate.ts:307`     | `for`                              |         18 |
| `src/site/collection-state.ts:430`  | `createCollectionStateController`  |         18 |
| `scripts/check-artifact.mjs:877`    | `isJavaScriptForOfKeyword`         |         17 |
| `scripts/check-artifact.mjs:1050`   | `for`                              |         17 |
