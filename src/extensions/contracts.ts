import type { RequestContext } from "../context/types.js";
import type {
  ModelRequestPort,
  ModelRequestResult,
} from "../models/contracts.js";
import type { AgentMode } from "../runtime/agent-mode.js";
import type { ApprovalMode } from "../security/approval-mode.js";
import type { NetworkRequest } from "../security/network-policy.js";
import type { ToolEffect } from "../tools/effects.js";
import type { ToolHandler, ToolSource, ToolSpec } from "../tools/types.js";
import type {
  FileDiff,
  JsonObject,
  ToolExecutionResult,
} from "../types/domain.js";
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
  readonly tools: {
    register(tool: ExtensionToolContribution): void;
  };
  readonly commands: {
    register<T>(command: ExtensionCommandContribution<T>): void;
  };
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
export type ExtensionToolContribution = {
  spec: Omit<ToolSpec, "source" | "guidance">;
  parse: ToolHandler["parse"];
  prepare: ToolHandler["prepare"];
  execute: ToolHandler["execute"];
};
export interface ExtensionCommandIdentity {
  readonly type: "extension";
  readonly extensionId: string;
  readonly name: string;
}
export interface ExtensionCommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
  readonly source: ExtensionCommandIdentity;
  readonly executionPolicy?: "foreground" | "side_query";
  readonly controlActions?: readonly string[];
}
export interface SubagentControlInvocation {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly subagents: Omit<
    import("../subagents/contracts.js").SubagentPort,
    "submit"
  >;
}
export interface ExtensionCommandInvocation {
  readonly subagents?: import("../subagents/contracts.js").SubagentPort;
  /** Core-owned open action accepts an owned ID, never an arbitrary cwd. */
  readonly worktrees: { open(id: string): Promise<ToolExecutionResult> };
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly invocationId: string;
  readonly mode: AgentMode;
  readonly approvalMode: ApprovalMode;
  readonly signal: AbortSignal;
  readonly model: ModelRequestPort;
  readonly tools: {
    execute(name: string, input: JsonObject): Promise<ToolExecutionResult>;
  };
}
export interface SideQueryCommandInvocation {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly generation: number;
  readonly invocationId: string;
  readonly mode: AgentMode;
  readonly approvalMode: ApprovalMode;
  readonly signal: AbortSignal;
  readonly model: ModelRequestPort;
}
interface ExtensionCommandMetadata<T> {
  name: string;
  description: string;
  usage?: string;
  parse(args: string): T;
  controlActions?: readonly string[];
  executeControl?(
    context: SubagentControlInvocation,
    input: T,
  ): ToolExecutionResult | Promise<ToolExecutionResult>;
}
export type ExtensionCommandContribution<T = unknown> =
  ExtensionCommandMetadata<T> &
    (
      | {
          executionPolicy?: "foreground";
          execute(
            context: ExtensionCommandInvocation,
            input: T,
          ): ToolExecutionResult | Promise<ToolExecutionResult>;
        }
      | {
          executionPolicy: "side_query";
          execute(
            context: SideQueryCommandInvocation,
            input: T,
          ): ModelRequestResult | Promise<ModelRequestResult>;
        }
    );
export interface ChiselExtension {
  readonly id: string;
  activate(context: ExtensionContext): void | Promise<void>;
}
