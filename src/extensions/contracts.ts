import type { RequestContext } from "../context/types.js";
import type { AgentMode } from "../runtime/agent-mode.js";
import type { ApprovalMode } from "../security/approval-mode.js";
import type { NetworkRequest } from "../security/network-policy.js";
import type { ToolEffect } from "../tools/effects.js";
import type { ToolSource } from "../tools/types.js";
import type { FileDiff, JsonObject } from "../types/domain.js";
import type { ServiceToken } from "./services.js";

export interface Disposable {
  dispose(): void | Promise<void>;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type ToolGuardPoint = "tool.afterPrepare" | "tool.beforeExecute";
export type ToolGuardDecision =
  | { action: "continue" }
  | { action: "deny"; reason: string };

export interface ToolGuardInvocation {
  callId: string;
  tool: { name: string; source: ToolSource; effect: ToolEffect };
  input: JsonObject;
  preview: string;
  resources: string[];
  command?: string;
  diffs?: FileDiff[];
  network?: NetworkRequest;
  sessionId: string;
  turnId?: string;
  mode: AgentMode;
  approvalMode: ApprovalMode;
}

export type ToolGuardSnapshot = DeepReadonly<ToolGuardInvocation> & {
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
};
export type ToolGuard = (
  snapshot: ToolGuardSnapshot,
) => ToolGuardDecision | Promise<ToolGuardDecision>;

/** Core execution takes this narrow port, never a host or service resolver. */
export interface ToolGuardPort {
  has(point: ToolGuardPoint): boolean;
  run(
    point: ToolGuardPoint,
    invocation: ToolGuardInvocation,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ContextInvocation {
  sessionId: string;
  turnId: string;
  iteration: number;
  attempt: number;
  mode: AgentMode;
  userPrompt: string;
}
export type ContextProviderSnapshot = Readonly<ContextInvocation> & {
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
};
export interface ExtensionContextProvider {
  id: string;
  collect(
    snapshot: ContextProviderSnapshot,
  ): { text: string } | undefined | Promise<{ text: string } | undefined>;
}
export interface ContextCollectionPort {
  collect(
    invocation: ContextInvocation,
    signal?: AbortSignal,
  ): Promise<RequestContext | undefined>;
}

export interface ExtensionContext {
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
  readonly services: {
    provide<T>(token: ServiceToken<T>, service: T): void;
    get<T>(token: ServiceToken<T>): T;
    lookup<T>(token: ServiceToken<T>): T | undefined;
  };
  readonly guards: {
    afterPrepare(guard: ToolGuard): void;
    beforeExecute(guard: ToolGuard): void;
  };
  readonly contextProviders: {
    register(provider: ExtensionContextProvider): void;
  };
  add(disposable: Disposable): void;
}
export interface ChiselExtension {
  readonly id: string;
  activate(context: ExtensionContext): void | Promise<void>;
}
