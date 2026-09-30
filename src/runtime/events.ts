import { randomUUID } from "node:crypto";
import type { ToolInvocationState } from "../tools/invocation.js";
import type {
  ChatMessage,
  JsonObject,
  TokenUsage,
  ToolExecutionResult,
} from "../types/domain.js";
import type { TurnState } from "./turn-state.js";
export type RuntimeEventType =
  | "turn_state"
  | "provider_request_started"
  | "provider_text_delta"
  | "provider_thinking_delta"
  | "provider_turn_completed"
  | "provider_failed"
  | "context_compaction_started"
  | "context_compaction_completed"
  | "overflow_recovery"
  | "tool_queued"
  | "tool_prepared"
  | "tool_approval_requested"
  | "tool_started"
  | "tool_completed"
  | "tool_failed"
  | "workspace_changed"
  | "checkpoint_saved";
export interface RuntimeEvent {
  id: string;
  sessionId: string;
  turnId?: string;
  timestamp: string;
  type: RuntimeEventType;
  text?: string;
  name?: string;
  invocationId?: string;
  input?: JsonObject;
  result?: ToolExecutionResult;
  message?: ChatMessage;
  usage?: TokenUsage;
  state?: TurnState | ToolInvocationState;
  errorCode?: string;
  durationMs?: number;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
}
export class RuntimeEventBus {
  private listeners = new Set<(event: RuntimeEvent) => void | Promise<void>>();
  constructor(
    readonly sessionId: string,
    public turnId?: string,
  ) {}
  subscribe(
    listener: (event: RuntimeEvent) => void | Promise<void>,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async emit(
    event: Omit<RuntimeEvent, "id" | "sessionId" | "timestamp" | "turnId">,
  ): Promise<void> {
    const record: RuntimeEvent = {
      ...event,
      id: randomUUID(),
      sessionId: this.sessionId,
      turnId: this.turnId,
      timestamp: new Date().toISOString(),
    };
    for (const listener of this.listeners) await listener(record);
  }
}
