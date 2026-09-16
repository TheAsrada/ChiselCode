import type { ProviderKind } from "../types/domain.js";
import { normalizeOpenAiCompatibleBaseUrl } from "./base-url.js";
import { OpenAIAdapter } from "./openai.js";

/**
 * AgentRouter (https://agentrouter.org) — единый шлюз к Claude, GPT,
 * DeepSeek, GLM и другим моделям за одним ключом.
 *
 * Протокол — обычный OpenAI-совместимый `/v1/chat/completions` с Bearer-ключом
 * `sk-...` (ключ выдаётся в agentrouter.org/console/token), поэтому адаптер
 * переиспользует OpenAI-движок, включая повтор с `max_tokens` при 400:
 * Claude-модели за шлюзом принимают только это имя параметра.
 *
 * Важно про адрес: нужен именно `https://agentrouter.org/v1` (с `/v1`),
 * иначе запросы уходят в корень и возвращают HTML главной. Нормализация
 * достраивает `/v1` голому хосту — как и для остальных совместимых шлюзов.
 * Идентификаторы моделей у шлюза меняются со временем и зависят от аккаунта
 * (источник правды — список моделей в консоли и `GET /v1/models`), поэтому
 * модель всегда свободная строка, а проверка подключения честно говорит,
 * если названия нет в списке шлюза.
 */
export const AGENTROUTER_BASE_URL = "https://agentrouter.org/v1";

/** Модель по умолчанию: актуальный Opus, есть почти на всех аккаунтах. */
export const AGENTROUTER_DEFAULT_MODEL = "claude-opus-5";

/** Переменная окружения с ключом (приоритет над сохранённым, как у остальных). */
export const AGENTROUTER_API_KEY_ENV = "AGENTROUTER_API_KEY";

/** Адрес по умолчанию для провайдера; остальные — без дефолта. */
export function defaultBaseUrlForProvider(
  provider: ProviderKind,
): string | undefined {
  return provider === "agentrouter" ? AGENTROUTER_BASE_URL : undefined;
}

export class AgentRouterAdapter extends OpenAIAdapter {
  constructor(options: { apiKey?: string; baseUrl?: string } = {}) {
    const trimmed = options.baseUrl?.trim();
    super({
      apiKey: options.apiKey,
      baseUrl: normalizeOpenAiCompatibleBaseUrl(
        trimmed ? trimmed : AGENTROUTER_BASE_URL,
      ),
      kind: "agentrouter",
    });
  }
}
