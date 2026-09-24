import { createPatch, diffLines } from "diff";
import type { FileDiff } from "../types/domain.js";

/** null distinguishes a missing file from an existing empty file. */
export function buildFileDiff(
  path: string,
  before: string | null,
  after: string | null,
): FileDiff {
  let additions = 0;
  let deletions = 0;
  for (const change of diffLines(before ?? "", after ?? "")) {
    if (change.added) additions += change.count ?? 0;
    if (change.removed) deletions += change.count ?? 0;
  }
  return {
    path,
    kind: before === null ? "create" : after === null ? "delete" : "edit",
    patch: createPatch(path, before ?? "", after ?? "", "before", "after"),
    additions,
    deletions,
  };
}
