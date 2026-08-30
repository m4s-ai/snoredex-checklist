# Cyclomatic complexity baseline

> Advisory lexical estimate; this is not a release gate or a conformance claim.

Scope: `src/` and `scripts/` (32 production code files).
Lines: 11,789.
Function-like nodes: 245.
McCabe estimate: sum 1,705; mean 7.0; median 3; P90 18; P95 26.
Hotspots: 51 functions exceed 10; 20 exceed 20.

The estimate counts if/for/while/do/catch/case statements, conditional `?` tokens and `&&`/`||`/`??` operators inside function-like bodies. It is intended to make refactoring candidates reproducible, not to prescribe a threshold.

| Location                          | Function                        | Complexity |
| --------------------------------- | ------------------------------- | ---------: |
| `src/state/reconciliation.ts:513` | `reconcilePrivateState`         |         59 |
| `src/site/query.ts:31`            | `parseQuery`                    |         46 |
| `scripts/check-artifact.mjs:1311` | `extractHead`                   |         45 |
| `scripts/check-artifact.mjs:239`  | `stripHtmlComments`             |         37 |
| `src/site/app.ts:1319`            | `renderResults`                 |         36 |
| `src/state/domain.ts:211`         | `parseState`                    |         32 |
| `src/site/deployment.ts:24`       | `validatePagesDeployment`       |         31 |
| `src/site/catalogue.ts:93`        | `validateProvenance`            |         29 |
| `src/site/app.ts:1099`            | `renderRecoveryTools`           |         28 |
| `src/state/reconciliation.ts:167` | `migrationIsStructurallyValid`  |         28 |
| `src/state/domain.ts:148`         | `normalizeRecordForImport`      |         27 |
| `scripts/check-artifact.mjs:67`   | `readAttribute`                 |         26 |
| `scripts/check-artifact.mjs:703`  | `isJavaScriptMethodNameContext` |         26 |
| `scripts/check-artifact.mjs:758`  | `isJavaScriptRegexStart`        |         25 |
| `scripts/check-artifact.mjs:877`  | `isJavaScriptForOfKeyword`      |         25 |
| `src/state/reconciliation.ts:335` | `expectedForTransition`         |         25 |
| `scripts/check-artifact.mjs:98`   | `parseHtmlTagAt`                |         24 |
| `scripts/check-artifact.mjs:1048` | `isJavaScriptBlockEnd`          |         24 |
| `scripts/check-artifact.mjs:1241` | `stripJavaScriptComments`       |         23 |
| `scripts/check-artifact.mjs:467`  | `dynamicModuleDependencies`     |         22 |
