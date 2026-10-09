import { resolve } from "node:path";
import {
  commonGitResource,
  gitIdentity,
  localGitResource,
} from "../git/driver.js";
import { RuntimeError } from "../runtime/errors.js";
import { worktreePlanAccess } from "../worktrees/capability.js";
import type { WorktreeAction, WorktreeInput } from "../worktrees/service.js";
import { changesWorkspace, isReadEffect } from "./effects.js";
import type { ToolContext, ToolHandler, ToolPlan } from "./types.js";
import {
  type WorkspaceAccess,
  workspaceCoordinator,
} from "./workspace-coordinator.js";

async function gitAccess(
  handler: ToolHandler,
  context: ToolContext,
  mode: "read" | "write",
): Promise<WorkspaceAccess[]> {
  if (
    handler.spec.effect !== "process" &&
    handler.spec.effect !== "git_write" &&
    !(
      handler.spec.source?.type === "local" &&
      handler.spec.name.startsWith("git_")
    )
  )
    return [];
  try {
    const identity = await gitIdentity(context.workspace.root, context.signal);
    return [
      { resource: commonGitResource(identity), mode },
      { resource: localGitResource(identity), mode },
    ];
  } catch {
    return []; /* Non-Git projects still support shell and file tools. */
  }
}
export async function preparationAccess(
  handler: ToolHandler,
  context: ToolContext,
  input: unknown,
  scope: readonly string[],
): Promise<readonly WorkspaceAccess[]> {
  if (
    handler.spec.source?.type === "extension" &&
    handler.spec.source.extensionId === "builtin.worktrees"
  ) {
    if (!context.worktrees)
      throw new RuntimeError(
        "WORKTREE_UNAVAILABLE",
        "Worktree capability is not attached to this invocation.",
      );
    return context.worktrees.access(
      handler.spec.source.originalName as WorktreeAction,
      input as WorktreeInput,
    );
  }
  return [
    ...scope.map((resource) => ({ resource, mode: "read" as const })),
    ...(await gitAccess(handler, context, "read")),
  ];
}
export async function executionAccess(
  handler: ToolHandler,
  context: ToolContext,
  plan: ToolPlan,
  scope: readonly string[],
): Promise<readonly WorkspaceAccess[]> {
  const issued = worktreePlanAccess(plan, handler.spec.source);
  if (issued) return issued;
  const holds =
    changesWorkspace(handler.spec.effect) ||
    handler.spec.workspaceAccess === "read" ||
    (isReadEffect(handler.spec.effect) &&
      handler.spec.workspaceAccess !== "none" &&
      handler.spec.source?.type !== "mcp");
  if (!holds) return [];
  const mode: "read" | "write" = isReadEffect(handler.spec.effect)
    ? "read"
    : "write";
  const resources = await workspaceCoordinator.resources(
    plan.resources.map((path) =>
      path.startsWith("git:")
        ? path
        : requireAbsolute(context.workspace.root, path),
    ),
  );
  return [...new Set([...scope, ...resources])]
    .map((resource) => ({ resource, mode }))
    .concat(await gitAccess(handler, context, mode));
}
const requireAbsolute = (root: string, path: string) => resolve(root, path);
