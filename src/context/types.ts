import type { ChatMessage, ToolDefinition } from "../types/domain.js";
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
}
export interface ContextBudget {
  contextWindow?: number;
  reservedOutputTokens: number;
  safetyBufferTokens: number;
  maxInputTokens?: number;
}
export interface ContextFrame {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  budget: ContextBudget;
  estimatedInputTokens: number;
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
