import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import fixture from "./fixtures/collector-catalogue.fixture.json" with { type: "json" };
import {
  MAX_CATALOGUE_BYTES,
  readCommittedCataloguePair,
  syncCataloguePair,
  type CatalogueSyncRequest,
} from "../src/catalogue/sync.ts";
import { semanticFingerprint } from "../src/catalogue/validate.ts";

type JsonObject = Record<string, any>;

function cloneCatalogue(): JsonObject {
  return structuredClone(fixture.catalogue);
}

function bytesFor(catalogue: JsonObject): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(catalogue));
}

function digestFor(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requestFor(rootDirectory: string, catalogue = cloneCatalogue()): CatalogueSyncRequest {
  catalogue.meta.catalogueFingerprint = semanticFingerprint(catalogue);
  const bytes = bytesFor(catalogue);
  return {
    rootDirectory,
    artifactUrl: "https://example.test/collector_catalogue.json",
    artifactCommit: "a".repeat(40),
    contractVersion: "1.0.0",
    expectedFingerprint: semanticFingerprint(catalogue),
    expectedByteSha256: digestFor(bytes),
    issueUrls: [
      "https://github.com/m4s-ai/snoredex-checklist/issues/14",
      "https://github.com/m4s-ai/snoredex-data/issues/300",
    ],
    bytes,
  };
}

async function temporaryRoot(): Promise<string> {
  return join(tmpdir(), `snoredex-checklist-sync-${Date.now()}-${Math.random()}`);
}

async function cleanup(rootDirectory: string): Promise<void> {
  await rm(rootDirectory, { recursive: true, force: true });
}

test("stages and commits a validated catalogue plus matching lock", async () => {
  const rootDirectory = await temporaryRoot();
  try {
    const request = requestFor(rootDirectory);
    const result = await syncCataloguePair(request);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lock.producerRevision, "a".repeat(40));
    assert.equal(result.lock.catalogueByteLength, request.bytes.byteLength);

    const pair = await readCommittedCataloguePair(rootDirectory);
    assert.equal(pair.ok, true);
    if (!pair.ok) return;
    assert.deepEqual([...pair.bytes], [...request.bytes]);
    assert.deepEqual(pair.lock, result.lock);
  } finally {
    await cleanup(rootDirectory);
  }
});

test("rejects invalid input before changing the last known-good pair", async () => {
  const rootDirectory = await temporaryRoot();
  try {
    const initial = requestFor(rootDirectory);
    assert.equal((await syncCataloguePair(initial)).ok, true);

    const changed = cloneCatalogue();
    changed.meta.dataAsOf = "2026-08-25";
    const next = requestFor(rootDirectory, changed);
    const badDigest = await syncCataloguePair({
      ...next,
      expectedByteSha256: `sha256:${"0".repeat(64)}`,
    });
    assert.deepEqual(badDigest, { ok: false, code: "SYNC_BYTE_DIGEST_MISMATCH" });

    const pairAfterDigestFailure = await readCommittedCataloguePair(rootDirectory);
    assert.equal(pairAfterDigestFailure.ok, true);
    if (pairAfterDigestFailure.ok) {
      assert.deepEqual([...pairAfterDigestFailure.bytes], [...initial.bytes]);
    }

    const oversized = new Uint8Array(MAX_CATALOGUE_BYTES + 1);
    const oversizedResult = await syncCataloguePair({
      ...next,
      bytes: oversized,
      expectedByteSha256: digestFor(oversized),
    });
    assert.deepEqual(oversizedResult, { ok: false, code: "SYNC_ARTIFACT_TOO_LARGE" });

    const invalidJson = new TextEncoder().encode("not-json");
    const invalidJsonResult = await syncCataloguePair({
      ...next,
      bytes: invalidJson,
      expectedByteSha256: digestFor(invalidJson),
    });
    assert.deepEqual(invalidJsonResult, { ok: false, code: "SYNC_INVALID_JSON" });

    const invalidEncoding = new Uint8Array([0xc3, 0x28]);
    const invalidEncodingResult = await syncCataloguePair({
      ...next,
      bytes: invalidEncoding,
      expectedByteSha256: digestFor(invalidEncoding),
    });
    assert.deepEqual(invalidEncodingResult, { ok: false, code: "SYNC_INVALID_ENCODING" });

    const wrongSource = cloneCatalogue();
    wrongSource.meta.sourceRepository = "https://example.invalid/producer";
    const wrongSourceRequest = requestFor(rootDirectory, wrongSource);
    assert.deepEqual(await syncCataloguePair(wrongSourceRequest), {
      ok: false,
      code: "SYNC_CATALOGUE_INVALID",
    });
  } finally {
    await cleanup(rootDirectory);
  }
});

test("rejects lock skew and manual edits without overwriting them", async () => {
  const rootDirectory = await temporaryRoot();
  try {
    const initial = requestFor(rootDirectory);
    assert.equal((await syncCataloguePair(initial)).ok, true);
    const lockPath = join(rootDirectory, "catalogue.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as JsonObject;
    lock.catalogueByteLength += 1;
    await writeFile(lockPath, `${JSON.stringify(lock)}\n`, "utf8");

    assert.deepEqual(await readCommittedCataloguePair(rootDirectory), {
      ok: false,
      code: "SYNC_PAIR_INVALID",
    });
    assert.deepEqual(await syncCataloguePair(requestFor(rootDirectory)), {
      ok: false,
      code: "SYNC_PAIR_INVALID",
    });
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).catalogueByteLength, initial.bytes.byteLength + 1);

    const hostileIssue = {
      ...requestFor(rootDirectory),
      issueUrls: [
        "https://attacker.example/m4s-ai/snoredex-checklist/issues/14",
        "https://github.com/m4s-ai/snoredex-data/issues/300",
      ],
    };
    assert.deepEqual(await syncCataloguePair(hostileIssue), {
      ok: false,
      code: "SYNC_ARGUMENT_INVALID",
    });

    const oneSidedIssue = {
      ...requestFor(rootDirectory),
      issueUrls: ["https://github.com/m4s-ai/snoredex-checklist/issues/14"],
    };
    assert.deepEqual(await syncCataloguePair(oneSidedIssue), {
      ok: false,
      code: "SYNC_ARGUMENT_INVALID",
    });
  } finally {
    await cleanup(rootDirectory);
  }
});

test("serializes concurrent sync operations", async () => {
  const rootDirectory = await temporaryRoot();
  try {
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      enteredResolve = resolveEntered;
    });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolveRelease) => {
      releaseResolve = resolveRelease;
    });
    let moveCount = 0;
    const first = syncCataloguePair({
      ...requestFor(rootDirectory),
      renameFile: async (source, destination) => {
        moveCount += 1;
        if (moveCount === 1) {
          enteredResolve();
          await release;
        }
        await rename(source, destination);
      },
    });
    await entered;
    const second = await syncCataloguePair(requestFor(rootDirectory));
    assert.deepEqual(second, { ok: false, code: "SYNC_TRANSACTION_BUSY" });
    releaseResolve();
    assert.equal((await first).ok, true);
  } finally {
    await cleanup(rootDirectory);
  }
});

test("fails closed on a damaged transaction journal", async () => {
  const rootDirectory = await temporaryRoot();
  try {
    const journalDirectory = join(rootDirectory, ".catalogue-sync");
    await mkdir(journalDirectory, { recursive: true });
    await writeFile(join(journalDirectory, "journal.json"), "{not-json", "utf8");
    assert.deepEqual(await readCommittedCataloguePair(rootDirectory), {
      ok: false,
      code: "SYNC_TRANSACTION_UNCERTAIN",
    });
  } finally {
    await cleanup(rootDirectory);
  }
});

test("fails closed on a journal that points outside the repository root", async () => {
  const rootDirectory = await temporaryRoot();
  try {
    const journalDirectory = join(rootDirectory, ".catalogue-sync");
    await mkdir(journalDirectory, { recursive: true });
    await writeFile(
      join(journalDirectory, "journal.json"),
      JSON.stringify({
        version: 1,
        phase: "prepared",
        rootDirectory,
        vendorPath: "C:\\outside\\catalogue.json",
        lockPath: "C:\\outside\\catalogue.lock.json",
        stageDirectory: "C:\\outside\\stage",
        stageVendorPath: "C:\\outside\\stage\\collector_catalogue.json",
        stageLockPath: "C:\\outside\\stage\\catalogue.lock.json",
        backupVendorPath: "C:\\outside\\catalogue.backup",
        backupLockPath: "C:\\outside\\catalogue.lock.backup",
        hadVendor: true,
        hadLock: true,
      }),
      "utf8",
    );
    assert.deepEqual(await readCommittedCataloguePair(rootDirectory), {
      ok: false,
      code: "SYNC_TRANSACTION_UNCERTAIN",
    });
  } finally {
    await cleanup(rootDirectory);
  }
});

test("rejects symlinked transaction directories", async (t) => {
  const rootDirectory = await temporaryRoot();
  const outsideDirectory = await temporaryRoot();
  try {
    await mkdir(rootDirectory, { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    try {
      await symlink(
        outsideDirectory,
        join(rootDirectory, ".catalogue-sync"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && ["EPERM", "EACCES"].includes(String(error.code))) {
        t.skip("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    assert.deepEqual(await syncCataloguePair(requestFor(rootDirectory)), {
      ok: false,
      code: "SYNC_TRANSACTION_UNCERTAIN",
    });
  } finally {
    await cleanup(rootDirectory);
    await cleanup(outsideDirectory);
  }
});

test("rolls back an interrupted pair replacement", async () => {
  const rootDirectory = await temporaryRoot();
  try {
    const initial = requestFor(rootDirectory);
    assert.equal((await syncCataloguePair(initial)).ok, true);
    const changed = cloneCatalogue();
    changed.meta.dataAsOf = "2026-08-25";
    const next = requestFor(rootDirectory, changed);
    let moves = 0;
    const interrupted = await syncCataloguePair({
      ...next,
      renameFile: async (source, destination) => {
        moves += 1;
        if (moves === 4) {
          throw new Error("synthetic interruption");
        }
        await rename(source, destination);
      },
    });
    assert.deepEqual(interrupted, { ok: false, code: "SYNC_TRANSACTION_FAILED" });

    const pair = await readCommittedCataloguePair(rootDirectory);
    assert.equal(pair.ok, true);
    if (pair.ok) {
      assert.deepEqual([...pair.bytes], [...initial.bytes]);
    }
    await assert.rejects(readFile(join(rootDirectory, ".catalogue-sync", "journal.json")));
  } finally {
    await cleanup(rootDirectory);
  }
});
