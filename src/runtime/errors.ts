export type RuntimeErrorCode =
  | "WORKTREE_UNAVAILABLE"
  | "WORKTREE_UNSUPPORTED"
  | "WORKTREE_GIT_ERROR"
  | "WORKTREE_RECOVERY_REQUIRED"
  | "WORKTREE_IN_USE"
  | "WORKTREE_DIRTY"
  | "WORKTREE_CONFLICT"
  | "WORKTREE_STALE"
  | "LSP_UNAVAILABLE"
  | "LSP_UNSUPPORTED"
  | "LSP_PROTOCOL_ERROR"
  | "EXTENSION_HOOK_DENIED"
  | "EXTENSION_HOOK_FAILED"
  | "EXTENSION_CONTEXT_FAILED"
  | "WEB_NETWORK_DENIED"
  | "WEB_NETWORK_CONFIGURATION"
  | "WEB_UNSAFE_ADDRESS"
  | "WEB_TIMEOUT"
  | "WEB_TOO_LARGE"
  | "WEB_REDIRECT_LIMIT"
  | "WEB_HTTP_ERROR"
  | "WEB_UNSUPPORTED_CONTENT"
  | "WEB_SEARCH_NOT_CONFIGURED"
  | "WEB_SEARCH_FAILED"
  | "WEB_FETCH_FAILED"
  | "WEB_PROTOCOL_ERROR"
  | "WEB_RATE_LIMITED"
  | "WEB_REQUEST_LIMIT"
  | "MCP_SERVER_UNAVAILABLE"
  | "MCP_CONNECTION_FAILED"
  | "MCP_AUTH_REQUIRED"
  | "MCP_TOOL_NOT_FOUND"
  | "MCP_TOOL_CHANGED"
  | "MCP_TOOL_CALL_FAILED"
  | "MCP_PROTOCOL_ERROR"
  | "MCP_CANCELLED"
  | "MCP_TRUST_REQUIRED"
  | "MCP_FEATURE_UNSUPPORTED"
  | "CONTEXT_BUDGET_EXCEEDED"
  | "PROVIDER_CONTEXT_OVERFLOW"
  | "PROVIDER_FAILURE"
  | "PROTOCOL_ERROR"
  | "INVALID_TOOL_INPUT"
  | "PERMISSION_DENIED"
  | "MODE_RESTRICTION"
  | "APPROVAL_UNAVAILABLE"
  | "TOOL_TIMEOUT"
  | "TOOL_EXECUTION_FAILURE"
  | "STALE_FILE_REVISION"
  | "STALE_WORKSPACE"
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
