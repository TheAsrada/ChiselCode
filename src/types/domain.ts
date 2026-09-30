import { z } from "zod";
import type { ContextCheckpoint } from "../context/types.js";
import type {
  ModelCapabilities,
  TokenCountRequest,
} from "../providers/capabilities.js";
import type { ProviderErrorCode } from "../providers/errors.js";
import type { TurnState } from "../runtime/turn-state.js";
import type { ToolInvocationRecord } from "../tools/invocation.js";
export interface FileRevision {
  sha256: string;
  size: number;
}
export interface SessionRuntimeState {
  turnId?: string;
  state?: TurnState;
  invocations: Record<string, ToolInvocationRecord>;
  workspaceObservations: Record<string, FileRevision>;
  failedCalls: Record<string, { count: number; workspaceVersion: number }>;
  workspaceVersion?: number;
}
export interface SessionContextState {
  activeCheckpoint?: ContextCheckpoint;
}

/** @deprecated Use ProviderId; persisted identity is an open string. */
export const ProviderKindSchema = z.string().min(1);
export type ProviderKind = string;

export const ToolNameSchema = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
export type ToolName = string;

export type JsonObject = Record<string, unknown>;

export interface ToolCall {
  id: string;
  name: ToolName;
  input: JsonObject;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: ToolName;
  input: JsonObject;
}

export interface ToolResultContent {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ChatContent = TextContent | ToolUseContent | ToolResultContent;
export type MessageRole = "user" | "assistant";

export interface ChatMessage {
  role: MessageRole;
  content: ChatContent[];
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export type ConversationMessage = ChatMessage | SystemMessage;

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: JsonObject;
  requiresApproval: boolean;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface TokenUsage {
  /** Full request input, normalized by the protocol driver (cache included exactly once). */
  contextInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Provider-observed usage for one request, never a cumulative session total. */
export interface ContextSnapshot {
  model: string;
  observedInputTokens: number;
  contextWindow?: number;
  observedAt: string;
  source: "provider_usage" | "count_tokens";
  status: "observed" | "estimated";
}

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTokens: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | {
      type: "turn_complete";
      message: ChatMessage;
      stopReason: string;
      usage: TokenUsage;
    }
  | { type: "error"; message: string; code?: ProviderErrorCode };

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly providerId?: string;
  streamChat(request: ProviderRequest): AsyncIterable<StreamEvent>;
  listModels?(): Promise<ModelInfo[]>;
  checkConnection?(): Promise<
    import("../providers/contracts.js").ProviderHealthResult
  >;
  getCapabilities?(model: string): Promise<ModelCapabilities>;
  countTokens?(request: TokenCountRequest): Promise<number | undefined>;
}

export interface ProjectConfig {
  context?: Partial<import("../context/types.js").ContextOptions>;
  tools?: { maxParallelReads?: number };
  editing?: { requireFreshRead?: boolean };
  allowedCommands: string[];
  deniedCommands: string[];
  ignorePatterns: string[];
  autoApprove: boolean;
}

export interface ProviderConfig {
  provider: ProviderKind;
  apiKeyRef?: string;
  baseUrl?: string;
  defaultModel?: string;
}

export interface GlobalConfig {
  schemaVersion: 2;
  defaultProfileId?: string;
  profiles: Record<string, import("../providers/contracts.js").ProviderProfile>;
  [key: string]: unknown;
  defaultProvider?: ProviderKind;
  defaultModel?: string;
  providers: Partial<Record<ProviderKind, ProviderConfig>>;
  ui?: {
    sidebarMode?: "auto" | "show" | "hide";
    theme?: "obsidian" | "graphite" | "ember" | "paper";
    accent?: string;
  };
}

export interface UndoEntry {
  path: string;
  before: string | null;
  after: string | null;
  createdAt: string;
}

export interface Session {
  id: string;
  projectPath: string;
  messages: ChatMessage[];
  runtime?: SessionRuntimeState;
  context?: SessionContextState;
  model: string;
  providerId: string;
  profileId: string;
  /** @deprecated Non-persisted alias for providerId. */
  provider: ProviderKind;
  totalTokens: TokenUsage;
  contextSnapshot?: ContextSnapshot;
  /** Compatibility known subtotal; use costEstimate for model-visible total availability. */
  totalCost: number;
  costEstimate?: import("../providers/contracts.js").CostEstimate;
  undoStack: UndoEntry[];
  createdAt: string;
  updatedAt: string;
  /** Короткое название для списков: первая строка первого промпта. */
  title?: string;
  titleSource?: "auto" | "user";
  gitBranch?: string;
  /** UI-only applied diffs keyed by tool-use id; never part of provider messages. */
  fileDiffs?: Record<string, FileDiff>;
}

export interface FileDiff {
  path: string;
  kind: "create" | "edit" | "delete";
  patch: string;
  additions: number;
  deletions: number;
}

export interface ToolExecutionResult {
  output: string;
  isError?: boolean;
  requiresApproval?: boolean;
  preview?: string;
  fileDiff?: FileDiff;
  diffs?: FileDiff[];
  errorCode?: string;
  rawOutput?: string;
  artifact?: { uri: string; tokens: number };
  details?: Record<string, unknown>;
  sandboxed?: boolean;
}

export interface AgentResult {
  status: "completed" | "approval_required" | "failed" | "cancelled";
  text: string;
  session: Session;
  error?: string;
  errorCode?: string;
  pendingApproval?: { tool: ToolName; preview: string };
}
