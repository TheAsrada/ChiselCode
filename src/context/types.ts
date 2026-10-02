import type { ModelCapabilities } from "../providers/capabilities.js";
import type {
  ChatMessage,
  ProviderAdapter,
  TokenUsage,
  ToolDefinition,
} from "../types/domain.js";
export interface StructuredSummary {
  goal: string;
  userConstraints: string[];
  relevantArchitecture: string[];
  decisions: string[];
  workCompleted: string[];
  changedFiles: Record<string, string>;
  verification: string[];
  failedAttempts: string[];
  openProblems: string[];
  importantReferences: string[];
  nextAction: string;
}
export interface ContextCheckpoint {
  id: string;
  summary: StructuredSummary;
  throughMessageIndex: number;
  createdAt: string;
  estimatedTokens: number;
  preservedUserMessageIndex?: number;
  source?: "model" | "evidence";
}
export interface ContextCompactionRecord {
  id: string;
  afterMessage: number;
  beforeTokens: number;
  afterTokens: number;
  estimated: boolean;
  durationMs: number;
  reason: "auto" | "overflow";
  source: "model" | "evidence";
  createdAt: string;
}
export interface ContextSummaryRequest {
  model: string;
  provider: ProviderAdapter;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  messages: ChatMessage[];
  currentRequest?: ChatMessage;
  prior?: StructuredSummary;
  targetTokens: number;
  signal?: AbortSignal;
  onUsage(usage: TokenUsage): Promise<void>;
}
export type ContextSummarizer = (
  input: ContextSummaryRequest,
) => Promise<StructuredSummary | undefined>;
export interface ContextBudget {
  contextWindow?: number;
  reservedOutputTokens: number;
  maxOutputTokens?: number;
  safetyBufferTokens: number;
  maxInputTokens?: number;
}
export interface ContextFrame {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  budget: ContextBudget;
  estimatedInputTokens: number;
  localInputTokens: number;
  checkpoint?: ContextCheckpoint;
}
export interface ContextOptions {
  autoCompact: boolean;
  bufferRatio: number;
  keepRecentTokens: number;
  maxInlineToolResultTokens: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}
export const DEFAULT_CONTEXT_OPTIONS: ContextOptions = {
  autoCompact: true,
  bufferRatio: 0.1,
  keepRecentTokens: 16_000,
  maxInlineToolResultTokens: 10_000,
};
