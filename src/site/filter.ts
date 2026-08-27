export type ResearchCriterion = "true" | "false";

export function matchesResearch(progressClass: string, criterion?: ResearchCriterion): boolean {
  const isResearch = progressClass === "research";
  return criterion === "true" ? isResearch : criterion === "false" ? !isResearch : true;
}
