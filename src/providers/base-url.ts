import type { ProviderKind } from "../types/domain.js";

/**
 * Нормализация адресов совместимых API.
 *
 * Практика шлюзов в стиле One API / New API (AgentRouter, OpenRouter и т.п.):
 * - OpenAI-совместимый адрес обязан заканчиваться `/v1`
 *   (иначе `/chat/completions` уходит в корень и возвращает HTML главной);
 * - Anthropic-совместимый адрес обязан быть корнем БЕЗ `/v1`
 *   (SDK сам дописывает `/v1/messages`, иначе будет `/v1/v1/messages` → 404).
 */

const TRAILING_SLASHES = /\/+$/;

/** OpenAI-совместимый адрес: голому хосту добавляет `/v1`, пути не трогает. */
export function normalizeOpenAiCompatibleBaseUrl(value: string): string {
  const trimmed = value.trim().replace(TRAILING_SLASHES, "");
  if (!trimmed) return trimmed;
  let path = "";
  try {
    path = new URL(trimmed).pathname;
  } catch {
    // Невалидный адрес не чиним здесь — его отклонит валидация/запрос.
    return trimmed;
  }
  if (path === "" || path === "/") return `${trimmed}/v1`;
  return trimmed;
}

/** Anthropic-совместимый адрес: убирает хвостовой `/v1`, корень не трогает. */
export function normalizeAnthropicCompatibleBaseUrl(value: string): string {
  const trimmed = value.trim().replace(TRAILING_SLASHES, "");
  if (!trimmed) return trimmed;
  if (trimmed.toLowerCase().endsWith("/v1")) {
    const stripped = trimmed
      .slice(0, -"/v1".length)
      .replace(TRAILING_SLASHES, "");
    if (stripped) return stripped;
  }
  return trimmed;
}

/** Нормализация под конкретный сервис; остальные провайдеры — как есть. */
export function normalizeBaseUrlForProvider(
  provider: ProviderKind,
  baseUrl: string | undefined,
): string | undefined {
  if (!baseUrl) return baseUrl;
  if (provider === "openai-compatible")
    return normalizeOpenAiCompatibleBaseUrl(baseUrl);
  if (provider === "anthropic-compatible")
    return normalizeAnthropicCompatibleBaseUrl(baseUrl);
  return baseUrl;
}
