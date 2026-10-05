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
import type { ToolEffect } from "./effects.js";
export interface ToolSpec extends Omit<ToolDefinition, "requiresApproval"> {
  effect: ToolEffect;
  source?: ToolSource;
  pinned?: boolean;
  /** Trusted native guidance, composed only for tools actually selected for a turn. */
  guidance?: string;
  /** A local MCP process may touch its cwd even when its API writes externally. */
  workspaceAccess?: "read" | "write" | "none";
  permission: string;
  parallelSafe: boolean;
  outputPolicy?: { maxInlineTokens?: number };
  timeoutMs?: number;
}

export type McpToolCategory = "read" | "write" | "destructive" | "unknown";
export type ToolSource =
  | { type: "web"; operation: "search" | "fetch" }
  | { type: "local" }
  | { type: "skill" }
  | {
      type: "mcp";
      serverId: string;
      originalName: string;
      serverTitle: string;
      title?: string;
      category: McpToolCategory;
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
      };
      classificationReason: string;
    };
export interface ToolContext {
  /** Execution capability issued by the permission layer, not model input. */
  networkAuthorization?: import("../security/network-policy.js").NetworkAuthorization;
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
  /** Applied before artifact storage as well as model-visible inline output. */
  sanitizeResult?: (result: ToolExecutionResult) => ToolExecutionResult;
  sanitizeApproval?: (
    request: import("../security/approval.js").ApprovalRequest,
  ) => import("../security/approval.js").ApprovalRequest;
}
export interface ToolPlan<T = unknown> {
  network?: import("../security/network-policy.js").NetworkRequest;
  data: T;
  preview: string;
  resources: string[];
  command?: string;
  diffs?: import("../types/domain.js").FileDiff[];
  approval?: import("../security/approval.js").McpApprovalPreview;
}
export interface ToolHandler {
  spec: ToolSpec;
  permissions?(): import("../mcp/schema.js").McpPermissions;
  rememberApproval?(): Promise<void>;
  parse(input: JsonObject): unknown;
  prepare(context: ToolContext, input: unknown): Promise<ToolPlan>;
  execute(context: ToolContext, plan: ToolPlan): Promise<ToolExecutionResult>;
}
export interface ToolProvider {
  listTools(): Promise<ToolSpec[]>;
  getHandler(name: string): Promise<ToolHandler>;
}
