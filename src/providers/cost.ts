import type { CostEstimate, ProviderDefinition } from "./contracts.js";
export function estimateProviderCost(
  definition: ProviderDefinition | undefined,
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostEstimate {
  const rates = definition?.pricing?.[model];
  if (!rates) return { source: "unknown" };
  return {
    usd:
      (Math.max(0, inputTokens) * rates.input +
        Math.max(0, outputTokens) * rates.output) /
      1_000_000,
    source: "estimated",
  };
}
