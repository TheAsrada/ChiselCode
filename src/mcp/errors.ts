import { RuntimeError, type RuntimeErrorCode } from "../runtime/errors.js";
import type { McpRedactor } from "./redaction.js";

export function mcpError(
  error: unknown,
  redactor: McpRedactor,
  fallback: RuntimeErrorCode = "MCP_CONNECTION_FAILED",
  signal?: AbortSignal,
): RuntimeError {
  if (signal?.aborted)
    return new RuntimeError("MCP_CANCELLED", "Вызов MCP отменён.", {
      retryable: false,
    });
  if (error instanceof RuntimeError)
    return new RuntimeError(
      error.code,
      redactor.text(error.message),
      redactor.value(error.details),
    );
  const value = error as
    | {
        name?: string;
        message?: string;
        code?: string | number;
        status?: number;
        statusCode?: number;
        data?: { status?: number; statusCode?: number };
      }
    | undefined;
  const status =
    value?.status ??
    value?.statusCode ??
    value?.data?.status ??
    value?.data?.statusCode ??
    (typeof value?.code === "number" && value.code >= 400 && value.code < 600
      ? value.code
      : undefined);
  const message = redactor.text(value?.message ?? String(error)).slice(0, 1000);
  if (
    value?.name === "UnauthorizedError" ||
    status === 401 ||
    status === 403 ||
    /authentication|unauthorized|\b401\b|\b403\b/i.test(message)
  )
    return new RuntimeError(
      "MCP_AUTH_REQUIRED",
      "Сервер требует авторизацию. Добавьте учётные данные в /mcp.",
      { retryable: false },
    );
  if (value?.name === "AbortError")
    return new RuntimeError("MCP_CANCELLED", "Вызов MCP отменён.", {
      retryable: false,
    });
  if (value?.code === -32601 || /unknown tool|tool not found/i.test(message))
    return new RuntimeError(
      "MCP_TOOL_NOT_FOUND",
      "Инструмент больше не доступен на MCP-сервере. Обновите список.",
      { retryable: false },
    );
  if (/schema|parse|invalid.*response|protocol|json|negotiat/i.test(message))
    return new RuntimeError(
      "MCP_PROTOCOL_ERROR",
      `Сервер вернул некорректный ответ: ${message}`,
      { retryable: false },
    );
  return new RuntimeError(fallback, message || "Соединение MCP недоступно.", {
    retryable:
      [408, 429, 500, 502, 503, 504].includes(status ?? 0) ||
      /\b(?:408|429|500|502|503|504)\b|closed|connect|timeout|network|fetch|socket|econn/i.test(
        message,
      ),
  });
}
