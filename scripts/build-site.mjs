import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { replaceOutput } from "./site-output.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, process.argv[2] === "--out-dir" ? process.argv[3] : "dist/site");
const fixture = JSON.parse(await readFile(resolve(root, "tests/fixtures/collector-catalogue.fixture.json"), "utf8"));
const validator = await import(pathToFileURL(resolve(root, "src/catalogue/validate.ts")));
const validated = validator.validateCatalogueFixture(fixture);
if (!validated.ok) throw new Error(`synthetic fixture rejected: ${validated.errors.join(", ")}`);

const staging = `${output}.staging-${process.pid}`;
const previous = `${output}.previous-${process.pid}`;
const assets = resolve(staging, "assets");
await rm(staging, { recursive: true, force: true });
await rm(previous, { recursive: true, force: true });
try {
  await mkdir(assets, { recursive: true });
  const tsc = resolve(root, "node_modules/typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", resolve(root, "tsconfig.site.json"), "--outDir", assets], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`site TypeScript build failed with status ${result.status ?? "unknown"}`);
  const stateResult = spawnSync(process.execPath, [tsc, "-p", resolve(root, "tsconfig.site-state.json"), "--outDir", resolve(assets, "state")], { cwd: root, stdio: "inherit" });
  if (stateResult.status !== 0) throw new Error(`browser state read API build failed with status ${stateResult.status ?? "unknown"}`);

  const provenance = {
    mode: "synthetic-fixture",
    sourceCommit: "synthetic-fixture",
    contractVersion: fixture.catalogue.meta.schemaVersion,
    sourceRepository: fixture.catalogue.meta.sourceRepository,
  };
  await writeFile(resolve(assets, "snapshot.js"), `export const provenance = Object.freeze(${JSON.stringify(provenance)});\nexport default Object.freeze(${JSON.stringify(fixture.catalogue)});\n`, "utf8");
  const catalogue = await import(pathToFileURL(resolve(assets, "catalogue.js")));
  const snapshot = await import(pathToFileURL(resolve(assets, "snapshot.js")));
  if (!(await catalogue.validateSnapshot(snapshot.default)).ok) throw new Error("site snapshot failed browser boundary validation");

  await cp(resolve(root, "site-src/index.html"), resolve(staging, "index.html"));
  await mkdir(resolve(staging, "collection"), { recursive: true });
  await cp(resolve(root, "site-src/collection/index.html"), resolve(staging, "collection/index.html"));
  await cp(resolve(root, "site-src/styles.css"), resolve(staging, "styles.css"));
  await cp(resolve(root, "LICENSE.md"), resolve(staging, "LICENSE.md"));
  await cp(resolve(root, "THIRD_PARTY_NOTICES.md"), resolve(staging, "THIRD_PARTY_NOTICES.md"));
  await cp(resolve(root, "LICENSES"), resolve(staging, "LICENSES"), { recursive: true });

  await replaceOutput({ output, previous, staging });
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}
console.log(`Built static site at ${output}`);
