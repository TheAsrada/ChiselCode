import { RuntimeError } from "../runtime/errors.js";
import type { ToolContext, ToolHandler, ToolPlan } from "../tools/types.js";
import type {
  BackgroundResourceOwner,
  WorkspaceAccess,
  WorkspaceLease,
} from "../tools/workspace-coordinator.js";

const nativeShells = new WeakSet<ToolHandler>();
const plans = new WeakMap<ToolPlan, readonly WorkspaceAccess[]>();
const grants = new WeakMap<
  object,
  {
    plan: ToolPlan;
    lease: WorkspaceLease;
    sessionId: string;
    invocationId?: string;
  }
>();
export function attestNativeShell(handler: ToolHandler): ToolHandler {
  nativeShells.add(handler);
  return handler;
}
export function isNativeShell(handler: ToolHandler): boolean {
  return nativeShells.has(handler);
}
export function ownShellAccess(
  plan: ToolPlan,
  accesses: readonly WorkspaceAccess[],
): ToolPlan {
  plans.set(plan, accesses);
  return plan;
}
export function shellPlanAccess(
  handler: ToolHandler,
  plan: ToolPlan,
): readonly WorkspaceAccess[] | undefined {
  if (!nativeShells.has(handler)) return;
  return plans.get(plan);
}
/** Issued by ToolExecutor after permissions/guards and atomic lease acquisition. */
export function authorizeShellLease(
  handler: ToolHandler,
  plan: ToolPlan,
  context: ToolContext,
  lease: WorkspaceLease,
): object | undefined {
  if (!nativeShells.has(handler)) return;
  const token = Object.freeze({});
  grants.set(token, {
    plan,
    lease,
    sessionId: context.session.id,
    invocationId: context.invocationId,
  });
  return token;
}
export async function transferShellLease(
  context: ToolContext,
  plan: ToolPlan,
  owner: BackgroundResourceOwner,
): Promise<{ release(): void | Promise<void> }> {
  const token = context.shellLeaseAuthorization;
  const grant = token ? grants.get(token) : undefined;
  if (
    !grant ||
    grant.plan !== plan ||
    grant.sessionId !== context.session.id ||
    grant.invocationId !== context.invocationId
  )
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Передача процесса требует разрешённого core execution path.",
    );
  grants.delete(token!);
  return grant.lease.transfer(owner);
}

const controls = new WeakSet<object>();
export function attestBackgroundControl<T extends object>(handler: T): T {
  controls.add(handler);
  return handler;
}
export function isBackgroundControl(handler: object): boolean {
  return controls.has(handler);
}
/** Only a core-registered contribution can transfer the attestation to its adapter. */
export function inheritBackgroundControl(
  original: object,
  adapter: object,
): void {
  if (controls.has(original)) controls.add(adapter);
}
