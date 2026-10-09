import type { CostEstimate } from "../providers/contracts.js";
import type { TokenUsage } from "../types/domain.js";

/** Internal model-only API. Neither the model nor the owner is caller-selectable. */
export interface ModelRequestInput {
  text: string;
  context: "conversation" | "none";
  limits?: {
    inputTokens?: number;
    outputTokens?: number;
    outputBytes?: number;
    deadlineMs?: number;
    attempts?: number;
  };
}

export type ModelRequestStatus =
  | "accepted"
  | "preparing"
  | "receiving"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "truncated"
  | "interrupted";

export interface ModelRequestOwner {
  readonly extensionId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly generation: number;
}

export interface ModelContextProvenance {
  capturedAt: string;
  sourceMessageCount: number;
  summaryId?: string;
  includedMessageRanges: Array<{ from: number; to: number }>;
  sources: string[];
  truncated: boolean;
  estimatedTokens: number;
  accounting: "estimated" | "count_tokens";
}

export interface ModelRequestResult {
  operationId: string;
  owner: ModelRequestOwner;
  status: ModelRequestStatus;
  text: string;
  error?: { code: string; message: string };
  usage?: TokenUsage;
  usageSource: "observed" | "partial" | "unknown";
  cost: CostEstimate;
  knownCost: number;
  context: ModelContextProvenance;
  attempts: number;
}

export type ModelRequestEvent =
  | {
      type: "status";
      operationId: string;
      owner: ModelRequestOwner;
      status: ModelRequestStatus;
    }
  | {
      type: "text";
      operationId: string;
      owner: ModelRequestOwner;
      text: string;
    }
  | {
      type: "terminal";
      operationId: string;
      owner: ModelRequestOwner;
      result: ModelRequestResult;
    };

export interface ModelRequestPort {
  request(
    input: ModelRequestInput,
    observer?: (event: Readonly<ModelRequestEvent>) => void,
  ): Promise<ModelRequestResult>;
}

/** Durable DTO only: never includes credentials, callbacks or the captured history text. */
export interface SideQueryRecord extends ModelRequestResult {
  command: string;
  question: string;
  providerId: string;
  profileId: string;
  model: string;
  acceptedAt: string;
  updatedAt: string;
  finishedAt?: string;
  afterMessage: number;
  revision: number;
  persistenceError?: string;
}

export interface ModelSpend {
  usage: TokenUsage;
  knownCost: number;
  unknownCost: boolean;
  unknownUsage: boolean;
}

export const MODEL_REQUEST_LIMITS = Object.freeze({
  questionBytes: 8 * 1024,
  inputTokens: 16_000,
  snapshotBytes: 64 * 1024,
  outputTokens: 2_048,
  outputBytes: 64 * 1024,
  deadlineMs: 120_000,
  activePerConversation: 1,
  activePerApplication: 4,
  attempts: 3,
  retainedRecords: 50,
});

export function isModelRequestActive(status: ModelRequestStatus): boolean {
  return (
    status === "accepted" || status === "preparing" || status === "receiving"
  );
}
