import {
  MAX_CATALOGUE_BYTES,
  SYNC_ERROR_CODES,
  syncCataloguePair,
  type SyncErrorCode,
} from "../src/catalogue/sync.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function argumentsAfter(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}

function required(name: string): string {
  const value = argument(name);
  if (!value) {
    throw new Error("SYNC_ARGUMENT_INVALID");
  }
  return value;
}

async function readResponse(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_CATALOGUE_BYTES) {
    throw new Error("SYNC_ARTIFACT_TOO_LARGE");
  }
  if (!response.body) {
    throw new Error("SYNC_TRANSACTION_FAILED");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_CATALOGUE_BYTES) {
      await reader.cancel();
      throw new Error("SYNC_ARTIFACT_TOO_LARGE");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function main(): Promise<void> {
  const artifactUrl = required("--artifact-url");
  const response = await fetch(artifactUrl, { redirect: "error" });
  if (!response.ok) {
    throw new Error("SYNC_TRANSACTION_FAILED");
  }
  const bytes = await readResponse(response);
  const result = await syncCataloguePair({
    rootDirectory: argument("--root") ?? process.cwd(),
    artifactUrl,
    artifactCommit: required("--artifact-commit"),
    contractVersion: required("--contract-version"),
    expectedFingerprint: required("--fingerprint"),
    expectedByteSha256: required("--byte-sha256"),
    issueUrls: argumentsAfter("--issue-url"),
    bytes,
  });
  if (!result.ok) {
    throw new Error(result.code satisfies SyncErrorCode);
  }
  process.stdout.write("catalogue sync committed\n");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const code: SyncErrorCode = (SYNC_ERROR_CODES as readonly string[]).includes(message)
    ? (message as SyncErrorCode)
    : "SYNC_TRANSACTION_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
