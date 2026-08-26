import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, process.argv[2] === "--out-dir" ? process.argv[3] : "dist/site");
const assets = resolve(output, "assets");
await rm(output, { recursive: true, force: true });
await mkdir(assets, { recursive: true });

const tsc = resolve(root, "node_modules/typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-p", resolve(root, "tsconfig.site.json"), "--outDir", assets], { cwd: root, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

const fixture = JSON.parse(await readFile(resolve(root, "tests/fixtures/collector-catalogue.fixture.json"), "utf8"));
const validator = await import(pathToFileURL(resolve(root, "src/catalogue/validate.ts")));
const validated = validator.validateCatalogueFixture(fixture);
if (!validated.ok) throw new Error(`synthetic fixture rejected: ${validated.errors.join(", ")}`);
const provenance = {
  mode: "synthetic-fixture",
  sourceCommit: "synthetic-fixture",
  contractVersion: fixture.catalogue.meta.schemaVersion,
  sourceRepository: fixture.catalogue.meta.sourceRepository,
};
await writeFile(resolve(assets, "snapshot.js"), `export const provenance = Object.freeze(${JSON.stringify(provenance)});\nexport default Object.freeze(${JSON.stringify(fixture.catalogue)});\n`, "utf8");
const catalogue = await import(pathToFileURL(resolve(assets, "catalogue.js")));
const snapshot = await import(pathToFileURL(resolve(assets, "snapshot.js")));
if (!catalogue.validateSnapshot(snapshot.default).ok) throw new Error("site snapshot failed browser boundary validation");

await cp(resolve(root, "site-src/index.html"), resolve(output, "index.html"));
await mkdir(resolve(output, "collection"), { recursive: true });
await cp(resolve(root, "site-src/collection/index.html"), resolve(output, "collection/index.html"));
await cp(resolve(root, "site-src/styles.css"), resolve(output, "styles.css"));
console.log(`Built static site at ${output}`);
