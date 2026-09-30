export type RuntimeErrorCode =
  | "CONTEXT_BUDGET_EXCEEDED"
  | "PROVIDER_CONTEXT_OVERFLOW"
  | "PROVIDER_FAILURE"
  | "PROTOCOL_ERROR"
  | "INVALID_TOOL_INPUT"
  | "PERMISSION_DENIED"
  | "APPROVAL_UNAVAILABLE"
  | "TOOL_TIMEOUT"
  | "TOOL_EXECUTION_FAILURE"
  | "STALE_FILE_REVISION"
  | "PATCH_CONFLICT"
  | "PATCH_PARTIAL_FAILURE"
  | "PROTOCOL_ERROR_DUPLICATE_CALL_ID"
  | "REPEATED_CALL_DETECTED"
  | "CANCELLED"
  | "INTERRUPTED_INVOCATION";
export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new RuntimeError("CANCELLED", "Operation cancelled.");
}
export function runtimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) return error;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "CanceledError")
  )
    return new RuntimeError("CANCELLED", error.message);
  return new RuntimeError(
    "TOOL_EXECUTION_FAILURE",
    error instanceof Error ? error.message : String(error),
  );
}
