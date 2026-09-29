import type {
  ContextSnapshot,
  ModelInfo,
  ProviderKind,
  TokenUsage,
} from "../types/domain.js";

/** Anthropic reports uncached input separately; OpenAI prompt_tokens already includes cache. */
export function observedInputTokens(
  provider: ProviderKind,
  usage: TokenUsage,
): number {
  const safe = (value?: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : 0;
  const uncached = safe(usage.inputTokens);
  return provider === "anthropic" || provider === "anthropic-compatible"
    ? uncached + safe(usage.cacheReadTokens) + safe(usage.cacheCreationTokens)
    : uncached;
}

export function observedContextSnapshot(
  provider: ProviderKind,
  model: string,
  usage: TokenUsage,
  knownModel?: ModelInfo,
  observedAt = new Date().toISOString(),
): ContextSnapshot {
  const window =
    knownModel?.id === model ? knownModel.contextWindow : undefined;
  return {
    model,
    observedInputTokens: observedInputTokens(provider, usage),
    ...(window !== undefined && Number.isFinite(window) && window > 0
      ? { contextWindow: window }
      : {}),
    observedAt,
    source: "provider_usage",
    status: "observed",
  };
}

/** The percentage is absent when the model's window is not actually known. */
export function contextProgress(snapshot?: ContextSnapshot): {
  label: string;
  barPercent?: number;
} {
  if (!snapshot) return { label: "—" };
  const tokens = snapshot.observedInputTokens;
  if (!snapshot.contextWindow || snapshot.contextWindow <= 0)
    return { label: `${tokens.toLocaleString("ru-RU")} токенов` };
  const percent = (tokens / snapshot.contextWindow) * 100;
  return {
    label: `${tokens.toLocaleString("ru-RU")} / ${snapshot.contextWindow.toLocaleString("ru-RU")} · ${percent.toFixed(0)}%`,
    barPercent: Math.min(100, Math.max(0, percent)),
  };
}
