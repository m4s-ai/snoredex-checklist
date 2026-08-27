import type { CatalogueSnapshot, SnapshotItem } from "./catalogue.js";

/**
 * A placeholder scope is deliberately narrower than the producer's full image-scope enum.
 * Unknown and legacy-product records can therefore fall back without implying an identity.
 */
export type PlaceholderScope = "exact-printing" | "card-release";

export interface SiteImageAsset {
  readonly assetId: string;
  readonly path: string;
  readonly mimeType: string;
  readonly imageScope: PlaceholderScope;
  readonly altTextBasis: string;
  readonly attribution: {
    readonly rightsStatus: string;
    readonly licenceRef: string;
    readonly noticeRef: string;
  };
  readonly placeholder: boolean;
  readonly sha256?: string;
}

const PLACEHOLDER_ASSET_VALUES = {
  "placeholder-exact-printing": {
    assetId: "placeholder-exact-printing",
    path: "images/placeholders/exact-printing.svg",
    mimeType: "image/svg+xml",
    imageScope: "exact-printing",
    altTextBasis: "Authored placeholder; no real card image is implied.",
    attribution: {
      rightsStatus: "project-authored-placeholder",
      licenceRef: "LICENSE.md",
      noticeRef: "THIRD_PARTY_NOTICES.md",
    },
    placeholder: true,
    sha256: "sha256:f1cd90092b389f1f6ebaa7ebadc4fbefbb4175063558caf6897d2e409dc9793c",
  },
  "placeholder-card-release": {
    assetId: "placeholder-card-release",
    path: "images/placeholders/card-release.svg",
    mimeType: "image/svg+xml",
    imageScope: "card-release",
    altTextBasis: "Authored placeholder; no real card image is implied.",
    attribution: {
      rightsStatus: "project-authored-placeholder",
      licenceRef: "LICENSE.md",
      noticeRef: "THIRD_PARTY_NOTICES.md",
    },
    placeholder: true,
    sha256: "sha256:2f8946e15556ef72df8a7fdc610e80bbea47545e3086e90b7293aea5ec947e41",
  },
} as const satisfies Record<string, SiteImageAsset>;

export const PLACEHOLDER_ASSETS = Object.freeze(PLACEHOLDER_ASSET_VALUES);

const PRODUCER_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PLACEHOLDER_SCOPES = new Set<PlaceholderScope>(["exact-printing", "card-release"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeLocalPath(value: unknown): value is string {
  return isString(value) && value.startsWith("images/") && !value.startsWith("/") &&
    !value.includes("\\") && !value.split("/").includes("..") && !value.includes("//");
}

function placeholderScope(item: SnapshotItem): PlaceholderScope {
  return item.imageScope === "exact-printing" ? "exact-printing" : "card-release";
}

function placeholderFor(item: SnapshotItem): SiteImageAsset {
  return PLACEHOLDER_ASSETS[`placeholder-${placeholderScope(item)}`];
}

function safeProducerAsset(value: unknown, item: SnapshotItem): SiteImageAsset | undefined {
  if (!isRecord(value) || !isString(value.assetId) || !isSafeLocalPath(value.path) ||
      !isString(value.url) || value.url !== value.path ||
      !isString(value.mimeType) || !PRODUCER_IMAGE_MIME_TYPES.has(value.mimeType) ||
      !isString(value.imageScope) || !PLACEHOLDER_SCOPES.has(value.imageScope as PlaceholderScope) ||
      value.imageScope !== item.imageScope || !isString(value.altTextBasis) ||
      !isString(value.sha256) || !/^sha256:[0-9a-f]{64}$/.test(value.sha256) || !isRecord(value.attribution)) {
    return undefined;
  }
  const attribution = value.attribution;
  if (attribution.rightsStatus !== "third-party-rights-excluded-from-project-grants" ||
      attribution.licenceRef !== "LICENSE.md" || attribution.noticeRef !== "THIRD_PARTY_NOTICES.md") {
    return undefined;
  }
  return {
    assetId: value.assetId,
    path: value.path,
    mimeType: value.mimeType,
    imageScope: value.imageScope as PlaceholderScope,
    altTextBasis: value.altTextBasis,
    attribution: {
      rightsStatus: attribution.rightsStatus,
      licenceRef: attribution.licenceRef,
      noticeRef: attribution.noticeRef,
    },
    placeholder: false,
    sha256: value.sha256,
  };
}

/**
 * Resolve only local, scope-matching producer assets. Every other case is a deterministic
 * authored placeholder; no remote URL is returned and no runtime fetch is required.
 */
export function resolveImageAsset(catalogue: CatalogueSnapshot, item: SnapshotItem): SiteImageAsset {
  if (item.imageAssetId !== null) {
    const candidate = catalogue.assets.find((asset) => isRecord(asset) && asset.assetId === item.imageAssetId);
    const producerAsset = safeProducerAsset(candidate, item);
    if (producerAsset) return producerAsset;
  }
  return placeholderFor(item);
}

/** Resolve an asset path relative to the compiled site module, preserving Pages subpaths. */
export function imageAssetUrl(asset: Pick<SiteImageAsset, "path">, moduleUrl: string = import.meta.url): string {
  if (!isSafeLocalPath(asset.path)) return PLACEHOLDER_ASSETS["placeholder-card-release"].path;
  try {
    return new URL(asset.path, moduleUrl).href;
  } catch {
    return PLACEHOLDER_ASSETS["placeholder-card-release"].path;
  }
}
