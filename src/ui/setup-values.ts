import {
  AGENTROUTER_BASE_URL,
  AGENTROUTER_DEFAULT_MODEL,
} from "../providers/agentrouter.js";
import type { ProviderKind } from "../types/domain.js";
export interface SetupValues {
  provider: ProviderKind;
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export function defaultModelFor(provider: ProviderKind): string {
  if (provider === "anthropic") return "claude-opus-5";
  if (provider === "openai") return "gpt-5";
  if (provider === "agentrouter") return AGENTROUTER_DEFAULT_MODEL;
  return "";
}

/** Где взять ключ для каждого сервиса. Переиспользуется экраном ключа в /settings. */
export const PROVIDER_HINT: Record<ProviderKind, string> = {
  anthropic: "Ключ создаётся в Anthropic Console → console.anthropic.com",
  openai: "Ключ создаётся на OpenAI Platform → platform.openai.com/api-keys",
  "openai-compatible":
    "Подойдёт Ollama, OpenRouter, Groq, LM Studio и любой OpenAI-совместимый сервер.",
  "anthropic-compatible":
    "Прокси с Anthropic Messages API (как для Claude Code через ANTHROPIC_BASE_URL).",
  agentrouter:
    "Ключ выдаётся в AgentRouter Console → agentrouter.org/console/token " +
    `(формат sk-…). Адрес подставится сам: ${AGENTROUTER_BASE_URL}. ` +
    "Модель — любая из вашей консоли (список со временем меняется).",
};

export function isValidApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
