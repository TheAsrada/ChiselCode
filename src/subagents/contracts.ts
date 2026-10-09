import type {
  ModelContextProvenance,
  ModelSpend,
} from "../models/contracts.js";
import type {
  JsonObject,
  TokenUsage,
  ToolExecutionResult,
} from "../types/domain.js";
import type { SUBAGENT_LIMITS } from "./config.js";

export const SUBAGENT_STATES = [
  "queued",
  "preparing",
  "running",
  "awaiting_approval",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exhausted",
  "approval_unavailable",
  "interrupted",
] as const;
export type SubagentStatus = (typeof SUBAGENT_STATES)[number];
export type SubagentMode = "readonly" | "coding";
export interface SubagentInput {
  task: string;
  label: string;
  mode: SubagentMode;
  context?: "conversation" | "none";
  limits?: {
    deadlineMs?: number;
    tokens?: number;
    iterations?: number;
    attempts?: number;
    tools?: number;
  };
}
export interface SubagentAttempt {
  id: string;
  purpose: "generation" | "compaction" | "count_tokens";
  reserved: number;
  accounted: number;
  usage?: TokenUsage;
  usageSource: "observed" | "partial" | "unknown";
  completed: boolean;
}
export interface SubagentProgress {
  sequence: number;
  at: string;
  type: "state" | "tool" | "text";
  text: string;
  tool?: string;
  outcome?: "completed" | "failed";
}
export interface SubagentDescriptor {
  id: string;
  rootOwnerId: string;
  parentSessionId: string;
  parentConversationId: string;
  parentGeneration: number;
  parentRoot: string;
  parentTurnId: string;
  invocationId: string;
  extensionId: string;
  depth: 1;
  ordinal: number;
  label: string;
  task: string;
  mode: SubagentMode;
  status: SubagentStatus;
  providerId: string;
  profileId: string;
  model: string;
  sessionId?: string;
  root?: string;
  worktree?: {
    id: string;
    path: string;
    label: string;
    base: string;
    origin: string;
  };
  acceptedAt: string;
  updatedAt: string;
  finishedAt?: string;
  revision: number;
  context: ModelContextProvenance;
  step: string;
  text: string;
  textTruncated: boolean;
  progress: SubagentProgress[];
  spend: ModelSpend;
  attempts: SubagentAttempt[];
  consumption: { accountedTokens: number; tools: number; iterations: number };
  limits: {
    deadlineMs: number;
    tokens: number;
    iterations: number;
    attempts: number;
    tools: number;
  };
  cleanup: {
    quiescent: boolean;
    incomplete?: boolean;
    recoveryRequired?: boolean;
  };
  error?: { code: string; message: string };
  artifact?: ToolExecutionResult["artifact"];
  persistenceError?: string;
}
export interface SubagentRecord extends SubagentDescriptor {
  schemaVersion: 1;
  operationKey: string;
  process?: {
    pid: number;
    host: string;
    start?: string;
    token: string;
    heartbeat: string;
  };
}
export type SubagentResult = Pick<
  SubagentDescriptor,
  | "id"
  | "mode"
  | "status"
  | "text"
  | "textTruncated"
  | "sessionId"
  | "root"
  | "worktree"
  | "spend"
  | "progress"
  | "cleanup"
  | "error"
  | "artifact"
  | "context"
>;
export interface SubagentPort {
  submit(input: SubagentInput): Promise<Readonly<SubagentDescriptor>>;
  list(): Promise<readonly Readonly<SubagentDescriptor>[]>;
  status(id: string): Promise<Readonly<SubagentDescriptor>>;
  wait(
    ids: readonly string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<readonly Readonly<SubagentDescriptor>[]>;
  result(id: string): Promise<Readonly<SubagentResult>>;
  cancel(id: string): Promise<Readonly<SubagentDescriptor>>;
}
export interface SubagentEvent {
  type: "accepted" | "changed" | "terminal";
  ownerId: string;
  child: Readonly<SubagentDescriptor>;
}
export interface ChildReceipt {
  revision: number;
  child: SubagentDescriptor;
  spend: ModelSpend;
}
export interface SubagentToolInput extends JsonObject {
  id?: string;
  ids?: string[];
  timeoutMs?: number;
  task?: string;
  label?: string;
  context?: "conversation" | "none";
}
export function subagentActive(status: SubagentStatus): boolean {
  return [
    "queued",
    "preparing",
    "running",
    "awaiting_approval",
    "cancelling",
  ].includes(status);
}
export type SubagentDefaults = typeof SUBAGENT_LIMITS;
