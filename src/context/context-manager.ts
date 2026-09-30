import type { ModelCapabilities } from "../providers/capabilities.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { RuntimeEventBus } from "../runtime/events.js";
import type {
  ProviderAdapter,
  Session,
  ToolDefinition,
} from "../types/domain.js";
import { assembleMessages } from "./assembler.js";
import { contextBudget } from "./budget.js";
import { compactProjection } from "./compactor.js";
import { requestTokens } from "./tokenizer.js";
import {
  type ContextFrame,
  type ContextOptions,
  DEFAULT_CONTEXT_OPTIONS,
} from "./types.js";
export interface ContextBuildRequest {
  session: Session;
  system: string;
  tools: ToolDefinition[];
  provider: ProviderAdapter;
  capabilities: ModelCapabilities;
  signal?: AbortSignal;
  requestedOutput?: number;
}
export class ContextManager {
  readonly options: ContextOptions;
  constructor(
    options: Partial<ContextOptions> = {},
    private readonly events?: RuntimeEventBus,
  ) {
    this.options = { ...DEFAULT_CONTEXT_OPTIONS, ...options };
  }
  async build(input: ContextBuildRequest): Promise<ContextFrame> {
    cancelled(input.signal);
    const budget = contextBudget(
      input.capabilities,
      this.options,
      input.requestedOutput,
    );
    let messages = assembleMessages(input.session);
    let estimatedInputTokens = await this.count(input, messages);
    if (
      budget.maxInputTokens !== undefined &&
      estimatedInputTokens > budget.maxInputTokens &&
      this.options.autoCompact
    ) {
      await this.compact(
        input.session,
        Math.min(
          this.options.keepRecentTokens,
          Math.floor(budget.maxInputTokens / 2),
        ),
      );
      messages = assembleMessages(input.session);
      estimatedInputTokens = await this.count(input, messages);
    }
    if (
      budget.maxInputTokens !== undefined &&
      estimatedInputTokens > budget.maxInputTokens
    )
      throw new RuntimeError(
        "CONTEXT_BUDGET_EXCEEDED",
        `Request needs approximately ${estimatedInputTokens} input tokens; budget is ${budget.maxInputTokens}. Reduce instructions, schemas or current input. User constraints were preserved.`,
      );
    return {
      system: input.system,
      messages,
      tools: input.tools,
      budget,
      estimatedInputTokens,
      checkpoint: input.session.context?.activeCheckpoint,
    };
  }
  async emergencyCompact(session: Session): Promise<void> {
    await this.events?.emit({ type: "overflow_recovery" });
    await this.compact(session, 0);
  }
  private async compact(session: Session, retain: number): Promise<void> {
    await this.events?.emit({ type: "context_compaction_started" });
    const changed = compactProjection(session, retain);
    if (changed)
      await this.events?.emit({ type: "context_compaction_completed" });
  }
  private async count(
    input: ContextBuildRequest,
    messages: ContextFrame["messages"],
  ): Promise<number> {
    cancelled(input.signal);
    if (
      input.capabilities.tokenCounting === "provider" &&
      input.provider.countTokens
    ) {
      const count = await input.provider.countTokens({
        model: input.session.model,
        system: input.system,
        messages,
        tools: input.tools,
        signal: input.signal,
      });
      cancelled(input.signal);
      if (count !== undefined && Number.isFinite(count) && count >= 0)
        return count;
    }
    return requestTokens(input.system, messages, input.tools);
  }
}
