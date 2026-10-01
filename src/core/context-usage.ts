import type {
  ContextSnapshot,
  ModelInfo,
  ProviderId,
  TokenUsage,
} from "../types/domain.js";

/** @deprecated provider argument is retained for callers; drivers normalize protocol semantics. */
export function observedInputTokens(
  _provider: string,
  usage: TokenUsage,
): number {
  const value = usage.contextInputTokens ?? usage.inputTokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function observedContextSnapshot(
  provider: ProviderId,
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
    occupiedTokens: observedInputTokens(provider, usage),
    windowSource:
      knownModel?.id === model ? knownModel.limitsSource : undefined,
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
  const tokens = snapshot.occupiedTokens ?? snapshot.observedInputTokens;
  const prefix = snapshot.status === "estimated" ? "~" : "";
  if (!snapshot.contextWindow || snapshot.contextWindow <= 0)
    return { label: `${prefix}${tokens.toLocaleString("ru-RU")} токенов` };
  const percent = (tokens / snapshot.contextWindow) * 100;
  const percentLabel = percent.toLocaleString("ru-RU", {
    maximumFractionDigits: percent >= 10 ? 0 : 1,
  });
  return {
    label: `${prefix}${tokens.toLocaleString("ru-RU")} / ${snapshot.contextWindow.toLocaleString("ru-RU")} · ${prefix}${percentLabel}%`,
    barPercent: Math.min(100, Math.max(0, percent)),
  };
}
