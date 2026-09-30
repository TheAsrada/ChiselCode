import type { ModelCapabilities } from "../providers/capabilities.js";
import type { ContextBudget, ContextOptions } from "./types.js";
export function contextBudget(
  capabilities: ModelCapabilities,
  options: ContextOptions,
  requestedOutput?: number,
): ContextBudget {
  const contextWindow = options.contextWindow ?? capabilities.contextWindow;
  let reservedOutputTokens = Math.min(
    requestedOutput ?? options.maxOutputTokens ?? 4096,
    capabilities.maxOutputTokens ?? Number.POSITIVE_INFINITY,
  );
  if (contextWindow !== undefined)
    reservedOutputTokens = Math.min(
      reservedOutputTokens,
      Math.max(1, Math.floor(contextWindow / 4)),
    );
  const safetyBufferTokens =
    contextWindow === undefined
      ? 0
      : Math.ceil(contextWindow * options.bufferRatio);
  return {
    contextWindow,
    reservedOutputTokens,
    safetyBufferTokens,
    maxInputTokens:
      contextWindow === undefined
        ? undefined
        : contextWindow - reservedOutputTokens - safetyBufferTokens,
  };
}
