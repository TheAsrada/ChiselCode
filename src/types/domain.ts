import { z } from "zod";

export const ProviderKindSchema = z.enum([
  "anthropic",
  "anthropic-compatible",
  "openai",
  "openai-compatible",
  "agentrouter",
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ToolNameSchema = z.enum([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "delete_file",
  "run_shell",
  "git_diff",
  "git_commit",
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

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
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
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
  | { type: "error"; message: string };

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  streamChat(request: ProviderRequest): AsyncIterable<StreamEvent>;
  listModels(): Promise<ModelInfo[]>;
  countTokens(
    request: Pick<ProviderRequest, "model" | "system" | "messages" | "tools">,
  ): Promise<number>;
}

export interface ProjectConfig {
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
  defaultProvider?: ProviderKind;
  defaultModel?: string;
  providers: Partial<Record<ProviderKind, ProviderConfig>>;
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
  model: string;
  provider: ProviderKind;
  totalTokens: TokenUsage;
  totalCost: number;
  undoStack: UndoEntry[];
  createdAt: string;
  updatedAt: string;
  /** Короткое название для списков: первая строка первого промпта. */
  title?: string;
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
}

export interface AgentResult {
  status: "completed" | "approval_required" | "failed" | "cancelled";
  text: string;
  session: Session;
  error?: string;
  pendingApproval?: { tool: ToolName; preview: string };
}
