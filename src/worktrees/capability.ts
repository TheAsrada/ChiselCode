import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { ToolContext, ToolPlan, ToolSource } from "../tools/types.js";
import type { WorkspaceAccess } from "../tools/workspace-coordinator.js";
import type { ToolExecutionResult } from "../types/domain.js";

interface PreparedCapability {
  sessionId: string;
  invocationId?: string;
  lifetime?: AbortSignal;
  execution: readonly WorkspaceAccess[];
  execute(context: ToolContext): Promise<ToolExecutionResult>;
}
export function bindWorktreePlanLifetime(
  plan: ToolPlan,
  lifetime: AbortSignal,
): ToolPlan {
  const capability = plans.get(plan);
  if (capability) capability.lifetime = lifetime;
  return plan;
}
const plans = new WeakMap<ToolPlan, PreparedCapability>();
const grants = new WeakMap<object, ToolPlan>();
const abandoned = new WeakMap<ToolPlan, () => Promise<void>>();
export function onAbandonWorktreePlan(
  plan: ToolPlan,
  cleanup: () => Promise<void>,
): ToolPlan {
  abandoned.set(plan, cleanup);
  return plan;
}
export async function abandonWorktreePlan(plan?: ToolPlan): Promise<void> {
  if (!plan) return;
  const cleanup = abandoned.get(plan);
  abandoned.delete(plan);
  await cleanup?.();
}
/** Internal plans cannot be forged using JSON input, resources or caller data. */
export function ownWorktreePlan(
  plan: ToolPlan,
  capability: PreparedCapability,
): ToolPlan {
  plans.set(plan, capability);
  return plan;
}
export function worktreePlanAccess(
  plan: ToolPlan,
  source?: ToolSource,
): readonly WorkspaceAccess[] | undefined {
  const capability = plans.get(plan);
  if (
    capability &&
    (source?.type !== "extension" || source.extensionId !== "builtin.worktrees")
  )
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Worktree capability belongs to its core consumer.",
    );
  return capability?.execution;
}
export function authorizeWorktreePlan(
  plan: ToolPlan,
  context: ToolContext,
): object | undefined {
  const capability = plans.get(plan);
  if (!capability) return undefined;
  if (
    capability.sessionId !== context.session.id ||
    capability.invocationId !== context.invocationId
  )
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Worktree plan belongs to another invocation.",
    );
  const grant = Object.freeze({});
  grants.set(grant, plan);
  return grant;
}
export async function executeWorktreePlan(
  context: ToolContext,
  plan: ToolPlan,
): Promise<ToolExecutionResult> {
  const capability = plans.get(plan);
  if (
    !capability ||
    !context.worktreeAuthorization ||
    grants.get(context.worktreeAuthorization) !== plan
  )
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Worktree mutation requires core execution authorization.",
    );
  grants.delete(context.worktreeAuthorization);
  cancelled(capability.lifetime);
  return capability.execute({
    ...context,
    signal: capability.lifetime
      ? context.signal
        ? AbortSignal.any([context.signal, capability.lifetime])
        : capability.lifetime
      : context.signal,
  });
}
