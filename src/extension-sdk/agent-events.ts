import type { JsonObject, ToolResult } from "./index.js";

export interface AgentMessage {
  role: "user" | "assistant";
  content: (
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: JsonObject }
    | {
        type: "tool_result";
        toolUseId: string;
        content: string;
        isError?: boolean;
      }
  )[];
}
export interface AgentModelRequest {
  model: string;
  system: string;
  messages: AgentMessage[];
  maxTokens?: number;
}
export interface AgentModelResponse {
  message: AgentMessage;
  stopReason: string;
  usage?: {
    contextInputTokens?: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}
export interface AgentToolCall {
  callId: string;
  name: string;
  input: JsonObject;
}
export interface AgentToolResult {
  output: string;
  rawOutput?: string;
  preview?: string;
  isError?: boolean;
  errorCode?: string;
  details?: JsonObject;
}
export interface AgentEventData {
  "prompt.submit": { text: string };
  "model.request": AgentModelRequest;
  "model.response": AgentModelResponse;
  "tool.call": AgentToolCall;
  "tool.result": { callId: string; name: string; result: AgentToolResult };
}
export interface AgentEventResult {
  "prompt.submit": { text: string };
  "model.request":
    | { request: AgentModelRequest }
    | { response: AgentModelResponse };
  "model.response": AgentModelResponse;
  "tool.call": { call: AgentToolCall } | { result: AgentToolResult };
  "tool.result": { result: AgentToolResult };
}
export interface AgentEventContext {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly signal: AbortSignal;
}
export type AgentEventHandler<K extends keyof AgentEventData> = (
  event: AgentEventContext & {
    readonly type: K;
    readonly data: Readonly<AgentEventData[K]>;
  },
  next: (data?: AgentEventData[K]) => Promise<AgentEventResult[K]>,
) => AgentEventResult[K] | Promise<AgentEventResult[K]>;
/** Sanitized runtime events. Observers cannot replace the host's event or its listeners. */
export interface AgentObservedEvent {
  readonly type: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly invocationId?: string;
  readonly name?: string;
  readonly text?: string;
  readonly state?: string;
  readonly result?: ToolResult;
}
export interface AgentEvents {
  on<K extends keyof AgentEventData>(
    type: K,
    handler: AgentEventHandler<K>,
  ): void;
  observe(
    handler: (event: Readonly<AgentObservedEvent>) => void | Promise<void>,
  ): void;
}
