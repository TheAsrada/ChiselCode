import { ProviderError } from "./errors.js";

/** Decode complete arguments only. Never repair or execute a partial mutation. */
export function parseToolArguments(
  json: string,
  name: string,
): Record<string, unknown> {
  let input: unknown;
  try {
    // Some compatible gateways omit {} for tools without required arguments.
    input = JSON.parse(json.trim() || "{}");
  } catch {
    throw new ProviderError(
      "invalid_tool_arguments",
      `Некорректный JSON аргументов ${name}: провайдер вернул неполный или неверно экранированный вызов.`,
    );
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ProviderError(
      "invalid_tool_arguments",
      `Аргументы ${name} должны быть JSON-объектом.`,
    );
  return input as Record<string, unknown>;
}
