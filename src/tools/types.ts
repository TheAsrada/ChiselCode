import type { ToolResultStore } from "../context/tool-result-store.js";
import type { AgentMode } from "../runtime/agent-mode.js";
import type { RuntimeEventBus } from "../runtime/events.js";
import type { ApprovalMode } from "../security/approval-mode.js";
import type { SandboxExecutor } from "../security/sandbox.js";
import type { WorkspacePolicy } from "../security/workspace-policy.js";
import type {
  JsonObject,
  Session,
  ToolDefinition,
  ToolExecutionResult,
} from "../types/domain.js";
import type { EditingService } from "./editing/service.js";
export interface ToolSpec extends Omit<ToolDefinition, "requiresApproval"> {
  effect: "read" | "workspace_write" | "process" | "git_write" | "external";
  permission: string;
  parallelSafe: boolean;
  outputPolicy?: { maxInlineTokens?: number };
  timeoutMs?: number;
}
export interface ToolContext {
  /** Immutable override for the request; never a mutable UI selection. */
  readonly mode?: AgentMode;
  readonly approvalMode?: ApprovalMode;
  session: Session;
  workspace: WorkspacePolicy;
  editing: EditingService;
  artifacts: ToolResultStore;
  sandbox: SandboxExecutor;
  events: RuntimeEventBus;
  signal?: AbortSignal;
  checkpoint: () => Promise<void>;
}
export interface ToolPlan<T = unknown> {
  data: T;
  preview: string;
  resources: string[];
  command?: string;
  diffs?: import("../types/domain.js").FileDiff[];
}
export interface ToolHandler {
  spec: ToolSpec;
  parse(input: JsonObject): unknown;
  prepare(context: ToolContext, input: unknown): Promise<ToolPlan>;
  execute(context: ToolContext, plan: ToolPlan): Promise<ToolExecutionResult>;
}
export interface ToolProvider {
  listTools(): Promise<ToolSpec[]>;
  getHandler(name: string): Promise<ToolHandler>;
}
