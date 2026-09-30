export type ProviderErrorCode =
  | "context_overflow"
  | "rate_limit"
  | "authentication"
  | "model_not_found"
  | "timeout"
  | "cancelled"
  | "transport"
  | "refusal"
  | "unknown";
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
export function normalizeProviderError(
  error: unknown,
  signal?: AbortSignal,
): ProviderError {
  if (error instanceof ProviderError) return error;
  const object = error as {
    status?: number;
    code?: string;
    name?: string;
    message?: string;
  };
  const message = object?.message ?? String(error);
  const code: ProviderErrorCode =
    signal?.aborted || /abort|cancel/i.test(object?.name ?? "")
      ? "cancelled"
      : /context[_ -]?(length|window|overflow)|too many tokens|prompt is too long|maximum context/i.test(
            message,
          )
        ? "context_overflow"
        : object?.status === 401 || object?.status === 403
          ? "authentication"
          : object?.status === 429
            ? "rate_limit"
            : /model.*(not found|does not exist)|model_not_found/i.test(message)
              ? "model_not_found"
              : /timeout|timed out/i.test(message)
                ? "timeout"
                : /connection|network|fetch failed/i.test(message)
                  ? "transport"
                  : "unknown";
  return new ProviderError(code, message);
}
