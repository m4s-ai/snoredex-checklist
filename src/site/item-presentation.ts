import type { SnapshotItem } from "./catalogue.js";

/** Keep presentation text readable without turning producer labels into identities. */
export function presentText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  return normalized || undefined;
}

export function collectorNumberLabel(item: SnapshotItem): string | undefined {
  const number = presentText(item.collectorNumber);
  const denominator = presentText(item.collectorNumberDenominator);
  if (!number) return undefined;
  return denominator ? `${number}/${denominator}` : number;
}

export function imageScopeLabel(item: SnapshotItem, placeholder: boolean): string {
  if (item.imageScope === "exact-printing") {
    return placeholder ? "Exact-printing placeholder" : "Exact printing image";
  }
  if (item.imageScope === "card-release") {
    return placeholder ? "Card-release placeholder (broader release)" : "Card-release image (broader release)";
  }
  return "Authored placeholder (image scope unknown)";
}

export function itemKindLabel(item: SnapshotItem): string {
  if (item.itemKind === "verified-printing") return "Verified printing";
  if (item.itemKind === "finish-candidate") return "Finish candidate";
  if (item.itemKind === "research-placeholder") return "Research placeholder";
  return "Catalogue item";
}

export function itemCueLabel(item: SnapshotItem): string {
  if (item.progressClass === "research") {
    return `Research · ${itemKindLabel(item)} · read-only`;
  }
  return item.itemKind === "verified-printing" ? "Current-known · verified printing" : "Current-known";
}

export function evidenceCueLabel(item: SnapshotItem): string | undefined {
  const status = presentText(item.finishVerificationStatus);
  return status ? `Producer evidence: ${status}` : undefined;
}

export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function linkValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(safeExternalUrl).filter((url): url is string => url !== undefined);
}
