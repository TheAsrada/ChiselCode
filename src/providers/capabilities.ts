export interface ModelCapabilities {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  limitsSource?: "provider" | "catalog" | "config";
  tokenCounting: "provider" | "local_estimate" | "unsupported";
  parallelToolCalls?: boolean;
  nativeCompaction?: boolean;
}
export type TokenCountRequest = Pick<
  import("../types/domain.js").ProviderRequest,
  "model" | "system" | "messages" | "tools"
> & { signal?: AbortSignal };
