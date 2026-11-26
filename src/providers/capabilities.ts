export type ReasoningEffortCapability =
  | { levels: readonly string[]; defaultLevel?: string; reason?: never }
  | { levels?: never; defaultLevel?: never; reason: string };

export const unknownReasoningEffort: ReasoningEffortCapability = {
  reason: "Подключение не сообщило уровни reasoning effort для этой модели.",
};

export function resolveReasoningEffort(
  capability: ReasoningEffortCapability | undefined,
  selection: string = "auto",
): string | undefined {
  return capability?.levels?.includes(selection) ? selection : undefined;
}

export function reasoningEffortKey(
  profileId: string | undefined,
  model: string,
): string {
  return JSON.stringify([profileId, model]);
}

export interface ModelCapabilities {
  displayName?: string;
  reasoningEffort?: ReasoningEffortCapability;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  limitsSource?: "provider" | "catalog" | "config";
  tokenCounting: "provider" | "local_estimate" | "unsupported";
  parallelToolCalls?: boolean;
  nativeCompaction?: boolean;
  toolImages?: boolean;
}
export type TokenCountRequest = Pick<
  import("../types/domain.js").ProviderRequest,
  "model" | "system" | "messages" | "tools"
> & { signal?: AbortSignal };
