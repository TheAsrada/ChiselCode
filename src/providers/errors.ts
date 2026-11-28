import { retryAfterMs } from "../network/retry.js";
import type { StreamEvent } from "../types/domain.js";

export type ProviderErrorCode =
  | "context_overflow"
  | "rate_limit"
  | "quota_exhausted"
  | "authentication"
  | "model_not_found"
  | "timeout"
  | "cancelled"
  | "transport"
  | "invalid_tool_arguments"
  | "output_truncated"
  | "refusal"
  | "invalid_endpoint"
  | "bad_request"
  | "unavailable"
  | "unsupported"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
    readonly retryable = ["rate_limit", "timeout", "unavailable"].includes(
      code,
    ),
    readonly retryAfterMs?: number,
    readonly upstreamCode?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

type ErrorFields = {
  status?: number;
  code?: unknown;
  type?: unknown;
  name?: string;
  message?: string;
  headers?: Headers | Record<string, string>;
  error?: ErrorFields;
  cause?: ErrorFields;
};

function errorIdentifier(value: unknown): string | undefined {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text === "string" && /^[\w.:-]{1,128}$/.test(text)) return text;
}

function classify(
  status: number | undefined,
  identifiers: string,
  message: string,
): ProviderErrorCode {
  if (
    status === 401 ||
    status === 403 ||
    /\b(authentication_error|permission_error|invalid_api_key|invalid_token|invalid_grant|token_expired|unauthorized)\b/i.test(
      identifiers,
    )
  )
    return "authentication";
  if (
    status === 402 ||
    /\b(insufficient_quota|usage_limit_reached|quota_exceeded|quota_exhausted|billing_hard_limit_reached|billing_not_active|credit_balance_too_low|insufficient_balance|account_quota_exceeded|plan_limit_reached)\b/i.test(
      identifiers,
    ) ||
    /insufficient.quota|exceeded your current quota|credit balance is too low|out of credits|billing hard limit|quota (?:is )?(?:exceeded|exhausted)/i.test(
      message,
    )
  )
    return "quota_exhausted";
  if (
    /context[_ -]?(length|window|overflow)|too many tokens|prompt is too long|maximum context/i.test(
      `${identifiers} ${message}`,
    )
  )
    return "context_overflow";
  if (
    /model.*(not found|does not exist)|model_not_found/i.test(
      `${identifiers} ${message}`,
    )
  )
    return "model_not_found";
  if (
    status === 429 ||
    /\b(rate_limit_exceeded|rate_limit_error)\b/i.test(identifiers)
  )
    return "rate_limit";
  if (
    status === 408 ||
    /\b(timeout|timeout_error|request_timeout|ETIMEDOUT)\b/i.test(identifiers)
  )
    return "timeout";
  if (status !== undefined && status >= 500 && status <= 599)
    return "unavailable";
  if (status === 404) return "invalid_endpoint";
  if (status !== undefined && status >= 400) return "bad_request";
  if (
    /\b(invalid_request_error|validation_error|bad_request)\b/i.test(
      identifiers,
    )
  )
    return "bad_request";
  if (
    /\b(overloaded_error|api_error|server_error|internal_error|service_unavailable|temporarily_unavailable)\b/i.test(
      identifiers,
    )
  )
    return "unavailable";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (
    /connection|network|fetch failed|socket|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|UND_ERR_SOCKET/i.test(
      `${identifiers} ${message}`,
    )
  )
    return "transport";
  return "unknown";
}

export function normalizeProviderError(
  error: unknown,
  signal?: AbortSignal,
): ProviderError {
  const object = error as ErrorFields | undefined;
  const message = object?.message ?? String(error);
  if (
    signal?.aborted ||
    /abort|cancel/i.test(
      `${object?.name ?? ""} ${error instanceof Error ? error.constructor.name : ""}`,
    )
  )
    return new ProviderError("cancelled", message);
  if (error instanceof ProviderError) return error;
  const details = object?.error?.error ?? object?.error;
  const identifiers = [
    object?.code,
    details?.code,
    details?.type,
    object?.type,
    object?.cause?.code,
  ]
    .map(errorIdentifier)
    .filter((value) => value !== undefined);
  const status = object?.status;
  const code = classify(status, identifiers.join(" "), message);
  const headers = object?.headers;
  const retry =
    headers instanceof Headers
      ? headers.get("retry-after")
      : Object.entries(headers ?? {}).find(
          ([name]) => name.toLowerCase() === "retry-after",
        )?.[1];
  return new ProviderError(
    code,
    message,
    status,
    code === "transport" ? true : undefined,
    retryAfterMs(retry),
    identifiers[0],
  );
}

export function providerErrorEvent(
  failure: ProviderError,
  usage?: Extract<StreamEvent, { type: "error" }>["usage"],
): Extract<StreamEvent, { type: "error" }> {
  return {
    type: "error",
    message: failure.message,
    code: failure.code,
    status: failure.status,
    retryable: failure.retryable,
    retryAfterMs: failure.retryAfterMs,
    upstreamCode: failure.upstreamCode,
    usage,
  };
}

export function providerErrorFromEvent(
  event: Extract<StreamEvent, { type: "error" }>,
): ProviderError {
  const classified = normalizeProviderError(event);
  return new ProviderError(
    event.code ?? classified.code,
    event.message,
    event.status,
    event.retryable ?? (event.code ? undefined : classified.retryable),
    event.retryAfterMs,
    event.upstreamCode,
  );
}

export function isProviderAccessError(
  error: unknown,
): error is ProviderError & { code: "authentication" | "quota_exhausted" } {
  return (
    error instanceof ProviderError &&
    (error.code === "authentication" || error.code === "quota_exhausted")
  );
}

export function providerErrorDiagnostic(failure: ProviderError): string {
  const details = [
    failure.upstreamCode,
    failure.status === undefined ? undefined : `HTTP ${failure.status}`,
  ]
    .filter(Boolean)
    .join(", ");
  return details ? `${failure.message} (${details})` : failure.message;
}
