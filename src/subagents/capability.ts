import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { ToolContext, ToolPlan, ToolSource } from "../tools/types.js";
import type { ToolExecutionResult } from "../types/domain.js";

interface Capability {
  sessionId: string;
  invocationId?: string;
  signal: AbortSignal;
  execute(): Promise<ToolExecutionResult>;
}
const plans = new WeakMap<ToolPlan, Capability>();
const grants = new WeakMap<object, ToolPlan>();
export function ownSubagentPlan(
  plan: ToolPlan,
  capability: Capability,
): ToolPlan {
  plans.set(plan, capability);
  return plan;
}
export function subagentPlanAccess(
  plan: ToolPlan,
  source?: ToolSource,
): readonly [] | undefined {
  if (!plans.has(plan)) return;
  if (
    source?.type !== "extension" ||
    source.extensionId !== "builtin.subagents"
  )
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Действие помощника принадлежит своему core consumer.",
    );
  return [];
}
export function authorizeSubagentPlan(
  plan: ToolPlan,
  context: ToolContext,
): object | undefined {
  const value = plans.get(plan);
  if (!value) return;
  if (
    value.sessionId !== context.session.id ||
    value.invocationId !== context.invocationId
  )
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Делегирование принадлежит другому вызову.",
    );
  cancelled(value.signal);
  const grant = Object.freeze({});
  grants.set(grant, plan);
  return grant;
}
export async function executeSubagentPlan(
  context: ToolContext,
  plan: ToolPlan,
): Promise<ToolExecutionResult> {
  const capability = plans.get(plan);
  if (
    !capability ||
    !context.subagentAuthorization ||
    grants.get(context.subagentAuthorization) !== plan
  )
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Делегирование требует разрешённого core execution path.",
    );
  grants.delete(context.subagentAuthorization);
  cancelled(capability.signal);
  cancelled(context.signal);
  return capability.execute();
}
