import type { FileDiff, FileRevision } from "../../types/domain.js";
export interface PatchOperation {
  path: string;
  candidate: string;
  before: string | null;
  after: string | null;
  expected?: FileRevision;
  mode?: number;
}
export interface PatchPlan {
  operations: PatchOperation[];
  diffs: FileDiff[];
  permissionResources: string[];
}
export interface WorkspaceChange {
  path: string;
  before: string | null;
  after: string | null;
}
export interface EditingResult {
  modelMessage: string;
  changes: WorkspaceChange[];
  diffs: FileDiff[];
  newRevisions: Record<string, FileRevision>;
}
