import type { ModelCapabilities } from "../providers/capabilities.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { RuntimeEventBus } from "../runtime/events.js";
import type {
  ContextSnapshot,
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
    private readonly connectionId?: string,
  ) {
    this.options = { ...DEFAULT_CONTEXT_OPTIONS, ...options };
  }
  async build(input: ContextBuildRequest): Promise<ContextFrame> {
    cancelled(input.signal);
    let messages = assembleMessages(input.session);
    let count = await this.count(input, messages);
    // Try to free old history for the model's full response before shrinking output.
    const preferredBudget = contextBudget(
      input.capabilities,
      this.options,
      input.requestedOutput,
    );
    if (
      preferredBudget.maxInputTokens !== undefined &&
      count.tokens > preferredBudget.maxInputTokens &&
      this.options.autoCompact
    ) {
      const changed = await this.compact(
        input.session,
        Math.min(
          this.options.keepRecentTokens,
          Math.max(0, Math.floor(preferredBudget.maxInputTokens / 2)),
        ),
      );
      messages = assembleMessages(input.session);
      count = await this.count(input, messages, !changed);
    }
    const budget = contextBudget(
      input.capabilities,
      this.options,
      input.requestedOutput,
      count.tokens,
    );
    if (
      budget.maxInputTokens !== undefined &&
      count.tokens > budget.maxInputTokens
    )
      throw new RuntimeError(
        "CONTEXT_BUDGET_EXCEEDED",
        `Request needs approximately ${count.tokens} input tokens; budget is ${budget.maxInputTokens}. Reduce instructions, schemas or current input. User constraints were preserved.`,
      );
    await this.publish(input, count);
    return {
      system: input.system,
      messages,
      tools: input.tools,
      budget,
      estimatedInputTokens: count.tokens,
      localInputTokens: count.localTokens,
      checkpoint: input.session.context?.activeCheckpoint,
    };
  }
  /** Refresh after the reply using the same system/tools as the actual request. */
  async refresh(input: ContextBuildRequest): Promise<void> {
    await this.publish(
      input,
      await this.count(input, assembleMessages(input.session)),
    );
  }
  private async publish(
    input: ContextBuildRequest,
    count: { tokens: number; localTokens: number; exact: boolean },
  ): Promise<void> {
    const snapshot: ContextSnapshot = {
      model: input.session.model,
      observedInputTokens:
        input.session.contextSnapshot?.connectionId === this.connectionId
          ? (input.session.contextSnapshot?.observedInputTokens ?? count.tokens)
          : count.tokens,
      occupiedTokens: count.tokens,
      localTokens: count.localTokens,
      connectionId: this.connectionId,
      contextWindow:
        input.capabilities.contextWindow ?? this.options.contextWindow,
      windowSource:
        input.capabilities.contextWindow !== undefined
          ? input.capabilities.limitsSource
          : this.options.contextWindow !== undefined
            ? "config"
            : undefined,
      observedAt: new Date().toISOString(),
      source: count.exact ? "count_tokens" : "local_estimate",
      status: count.exact ? "observed" : "estimated",
    };
    input.session.contextSnapshot = snapshot;
    await this.events?.emit({
      type: "context_updated",
      contextSnapshot: snapshot,
    });
  }
  async emergencyCompact(session: Session): Promise<void> {
    await this.events?.emit({ type: "overflow_recovery" });
    await this.compact(session, 0);
  }
  private async compact(session: Session, retain: number): Promise<boolean> {
    await this.events?.emit({ type: "context_compaction_started" });
    const changed = compactProjection(session, retain);
    if (changed) {
      session.contextSnapshot = undefined;
      await this.events?.emit({ type: "context_compaction_completed" });
    }
    return changed;
  }
  private async count(
    input: ContextBuildRequest,
    messages: ContextFrame["messages"],
    calibrate = true,
  ): Promise<{ tokens: number; localTokens: number; exact: boolean }> {
    cancelled(input.signal);
    const localTokens = requestTokens(input.system, messages, input.tools);
    if (
      input.capabilities.tokenCounting === "provider" &&
      input.provider.countTokens
    ) {
      try {
        const count = await input.provider.countTokens({
          model: input.session.model,
          system: input.system,
          messages,
          tools: input.tools,
          signal: input.signal,
        });
        cancelled(input.signal);
        if (count !== undefined && Number.isFinite(count) && count >= 0)
          return { tokens: count, localTokens, exact: true };
      } catch {
        cancelled(input.signal);
      }
    }
    const prior = input.session.contextSnapshot;
    const tokens =
      calibrate &&
      prior?.model === input.session.model &&
      prior.connectionId === this.connectionId &&
      prior.localTokens !== undefined
        ? Math.max(
            0,
            (prior.occupiedTokens ?? prior.observedInputTokens) +
              localTokens -
              prior.localTokens,
          )
        : localTokens;
    return { tokens, localTokens, exact: false };
  }
}
