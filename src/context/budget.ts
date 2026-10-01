import type { ModelCapabilities } from "../providers/capabilities.js";
import type { ContextBudget, ContextOptions } from "./types.js";
export function contextBudget(
  capabilities: ModelCapabilities,
  options: ContextOptions,
  requestedOutput?: number,
  inputTokens = 0,
): ContextBudget {
  const contextWindow =
    capabilities.contextWindow === undefined
      ? options.contextWindow
      : Math.min(options.contextWindow ?? Infinity, capabilities.contextWindow);
  const requested =
    requestedOutput ?? options.maxOutputTokens ?? capabilities.maxOutputTokens;
  let maxOutputTokens =
    requested === undefined
      ? undefined
      : Math.min(requested, capabilities.maxOutputTokens ?? requested);
  const safetyBufferTokens =
    contextWindow === undefined
      ? 0
      : Math.ceil(contextWindow * options.bufferRatio);
  if (contextWindow !== undefined && maxOutputTokens !== undefined)
    maxOutputTokens = Math.min(
      maxOutputTokens,
      Math.max(1, contextWindow - safetyBufferTokens - inputTokens),
    );
  const reservedOutputTokens = maxOutputTokens ?? 0;
  const maxInputTokens =
    contextWindow === undefined
      ? capabilities.maxInputTokens
      : Math.min(
          capabilities.maxInputTokens ?? Infinity,
          contextWindow - safetyBufferTokens - reservedOutputTokens,
        );
  return {
    contextWindow,
    reservedOutputTokens,
    maxOutputTokens,
    safetyBufferTokens,
    maxInputTokens,
  };
}
