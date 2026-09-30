export interface ModelCapabilities {
  contextWindow?: number;
  maxOutputTokens?: number;
  tokenCounting: "provider" | "local_estimate" | "unsupported";
  parallelToolCalls?: boolean;
  nativeCompaction?: boolean;
}
export type TokenCountRequest = Pick<
  import("../types/domain.js").ProviderRequest,
  "model" | "system" | "messages" | "tools"
> & { signal?: AbortSignal };
