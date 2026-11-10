import type { ToolContext, ToolPlan } from "../tools/types.js";
import type { WorkspaceAccess } from "../tools/workspace-coordinator.js";
import type { WorktreeRecord } from "./registry.js";

export const WORKTREE_LIMITS = Object.freeze({
  fileBytes: 512_000,
  totalBytes: 8 * 1024 * 1024,
  selectedFiles: 200,
  metadataPaths: 20_000,
  records: 1000,
});
export type WorktreeAction =
  | "list"
  | "status"
  | "create"
  | "diff"
  | "apply"
  | "remove";
export interface WorktreeInput {
  expectedFiles?: Record<string, string>;
  id?: string;
  label?: string;
  ref?: string;
  paths?: string[];
}
export interface WorktreeDescriptor {
  /** Management ownership, never filesystem permissions. Optional for older clients. */
  kind?: "origin" | "managed" | "external";
  id?: string;
  label: string;
  path: string;
  base?: string;
  head?: string;
  state: WorktreeRecord["state"] | "external";
  readOnly: boolean;
  origin?: string;
  retainedRef?: string;
  retainedCommit?: string;
  activeUsers?: number;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  ignored?: number;
  conflicted?: number;
  reason?: string;
}
export interface WorktreeWorkspacePort {
  openOrigin(): Promise<{
    readonly descriptor: Readonly<WorktreeDescriptor>;
    dispose(): void | Promise<void>;
  }>;
  ownedBackgroundTarget(
    id: string,
    ownerId: string,
  ): Promise<Readonly<WorktreeDescriptor>>;
  access(
    action: WorktreeAction,
    input: WorktreeInput,
  ): Promise<readonly WorkspaceAccess[]>;
  prepare(
    action: WorktreeAction,
    input: WorktreeInput,
    context: ToolContext,
  ): Promise<ToolPlan>;
  open(id: string): Promise<{
    readonly descriptor: Readonly<WorktreeDescriptor>;
    dispose(): void | Promise<void>;
  }>;
}
