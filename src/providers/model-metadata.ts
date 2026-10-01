import type { ModelInfo } from "../types/domain.js";
import catalog from "./model-limits.json" with { type: "json" };

type Limits = Pick<
  ModelInfo,
  "contextWindow" | "maxInputTokens" | "maxOutputTokens" | "limitsSource"
>;
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function positive(...values: unknown[]): number | undefined {
  return values.find(
    (value) =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  ) as number | undefined;
}

/** Exact IDs and documented Fireworks short IDs; never guess limits from a model family. */
export function catalogModelLimits(providerId: string, model: string): Limits {
  const providers = catalog.providers as Record<string, Record<string, Limits>>;
  const direct = providers[providerId]?.[model];
  if (direct) return { ...direct, limitsSource: "catalog" };
  for (const provider of ["openai", "anthropic", "deepseek"]) {
    const limits =
      providers[provider]?.[model] ??
      providers[provider]?.[
        model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : ""
      ];
    if (limits) return { ...limits, limitsSource: "catalog" };
  }
  const fireworks = providers["fireworks-ai"] ?? {};
  const exact =
    fireworks[model] ?? fireworks[`accounts/fireworks/models/${model}`];
  return exact ? { ...exact, limitsSource: "catalog" } : {};
}

/** Compatible APIs expose several documented names for the same model limits. */
export function modelInfo(
  raw: unknown,
  providerId: string,
): ModelInfo | undefined {
  const model = record(raw);
  if (typeof model.id !== "string" || !model.id.trim()) return;
  const top = record(model.top_provider);
  const limit = record(model.limit);
  const fallback = catalogModelLimits(providerId, model.id);
  const contextWindow = positive(
    top.context_length,
    model.contextWindow,
    model.context_window,
    model.context_length,
    model.max_model_len,
    model.max_context_length,
    model.context,
    limit.context,
    model.max_input_tokens,
  );
  const maxInputTokens = positive(
    model.maxInputTokens,
    model.max_input_tokens,
    limit.input,
  );
  const maxOutputTokens = positive(
    top.max_completion_tokens,
    model.maxOutputTokens,
    model.max_output_tokens,
    model.max_completion_tokens,
    model.max_output,
    model.max_tokens,
    limit.output,
  );
  return {
    id: model.id,
    displayName:
      typeof model.name === "string"
        ? model.name
        : typeof model.display_name === "string"
          ? model.display_name
          : undefined,
    contextWindow: contextWindow ?? fallback.contextWindow,
    maxInputTokens: maxInputTokens ?? fallback.maxInputTokens,
    maxOutputTokens: maxOutputTokens ?? fallback.maxOutputTokens,
    limitsSource:
      contextWindow !== undefined ? "provider" : fallback.limitsSource,
  };
}
