import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import fixture from "./fixtures/collector-catalogue.fixture.json" with { type: "json" };
import {
  PLACEHOLDER_ASSETS,
  imageAssetUrl,
  resolveImageAsset,
} from "../src/site/assets.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("keeps both authored placeholders card-shaped and digest-pinned", async () => {
  for (const asset of Object.values(PLACEHOLDER_ASSETS)) {
    assert.equal(asset.placeholder, true);
    assert.match(asset.path, /^images\/placeholders\/(exact-printing|card-release)\.svg$/);
    assert.match(asset.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.ok(asset.attribution.rightsStatus.startsWith("project-authored"));
    const bytes = await readFile(resolve(root, "site-src/assets", asset.path));
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, asset.sha256);
    assert.match(bytes.toString("utf8"), /viewBox="0 0 63 88"/);
  }
});

test("falls back locally without claiming a missing or remote image", () => {
  const catalogue = structuredClone(fixture.catalogue) as any;
  const item = catalogue.items[0];
  const resolvedMissing = resolveImageAsset(catalogue, item);
  assert.equal(resolvedMissing.assetId, "placeholder-card-release");
  assert.equal(resolvedMissing.placeholder, true);

  catalogue.assets.push({
    assetId: "remote-asset",
    path: "images/card.webp",
    url: "https://images.example.invalid/card.webp",
    mimeType: "image/webp",
    imageScope: "exact-printing",
    altTextBasis: "Untrusted remote image",
    attribution: { rightsStatus: "unknown", licenceRef: "", noticeRef: "" },
    sha256: `sha256:${"0".repeat(64)}`,
  });
  item.imageAssetId = "remote-asset";
  item.imageScope = "exact-printing";
  const resolvedRemote = resolveImageAsset(catalogue, item);
  assert.equal(resolvedRemote.assetId, "placeholder-exact-printing");
  assert.equal(resolvedRemote.placeholder, true);

  catalogue.assets[0] = {
    ...catalogue.assets[0],
    url: "images/card.webp",
    attribution: { rightsStatus: "unapproved", licenceRef: "", noticeRef: "" },
  };
  const resolvedUnapproved = resolveImageAsset(catalogue, item);
  assert.equal(resolvedUnapproved.assetId, "placeholder-exact-printing");
  assert.equal(resolvedUnapproved.placeholder, true);
});

test("accepts only a local scope-matching producer asset", () => {
  const catalogue = structuredClone(fixture.catalogue) as any;
  catalogue.assets.push({
    assetId: "local-asset",
    path: "images/card.webp",
    url: "images/card.webp",
    mimeType: "image/webp",
    imageScope: "exact-printing",
    altTextBasis: "Producer-provided card image",
    attribution: { rightsStatus: "third-party-rights-excluded-from-project-grants", licenceRef: "LICENSE.md", noticeRef: "THIRD_PARTY_NOTICES.md" },
    sha256: `sha256:${"0".repeat(64)}`,
  });
  const item = catalogue.items[0];
  item.imageAssetId = "local-asset";
  item.imageScope = "exact-printing";
  const resolved = resolveImageAsset(catalogue, item);
  assert.equal(resolved.assetId, "local-asset");
  assert.equal(resolved.placeholder, false);
  assert.equal(imageAssetUrl(resolved, "https://example.test/snoredex/assets.js"), "https://example.test/snoredex/images/card.webp");
});

test("never emits a URL for an unsafe path", () => {
  assert.equal(imageAssetUrl({ path: "../remote.webp" }, "https://example.test/snoredex/assets.js"), "images/placeholders/card-release.svg");
});
