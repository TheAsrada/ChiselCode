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
import { observedToolReferences, planCompaction } from "./compactor.js";
import { estimateTokens, requestTokens } from "./tokenizer.js";
import {
  type ContextCompactionRecord,
  type ContextFrame,
  type ContextOptions,
  type ContextSummarizer,
  DEFAULT_CONTEXT_OPTIONS,
  type StructuredSummary,
} from "./types.js";

type ContextCount = { tokens: number; localTokens: number; exact: boolean };
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
    private readonly summarizer?: ContextSummarizer,
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
      const compressed = await this.compact(
        input,
        Math.min(
          this.options.keepRecentTokens,
          Math.max(0, Math.floor(preferredBudget.maxInputTokens / 2)),
        ),
        "auto",
        count,
      );
      messages = assembleMessages(input.session);
      count = compressed ?? count;
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
    count: ContextCount,
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
  async emergencyCompact(
    session: Session,
    request?: ContextBuildRequest,
  ): Promise<boolean> {
    if (!this.options.autoCompact) return false;
    await this.events?.emit({ type: "overflow_recovery" });
    const input: ContextBuildRequest = request ?? {
      session,
      system: "",
      tools: [],
      provider: { providerId: session.providerId, async *streamChat() {} },
      capabilities: { tokenCounting: "local_estimate" },
    };
    return Boolean(
      await this.compact(
        input,
        0,
        "overflow",
        await this.count(input, assembleMessages(session), Boolean(request)),
      ),
    );
  }
  private async compact(
    input: ContextBuildRequest,
    retain: number,
    reason: ContextCompactionRecord["reason"],
    before: ContextCount,
  ): Promise<ContextCount | undefined> {
    const { session } = input;
    const candidate = planCompaction(session, retain);
    if (!candidate) return;
    const startedAt = performance.now();
    await this.publish(input, before);
    await this.events?.emit({
      type: "context_compaction_started",
      compactionId: candidate.id,
      estimatedInputTokens: before.tokens,
    });
    try {
      if (this.summarizer) {
        const window = contextBudget(
          input.capabilities,
          this.options,
          input.requestedOutput,
        ).contextWindow;
        const targetTokens = Math.min(
          8192,
          Math.max(512, Math.floor((window ?? 100_000) * 0.05)),
          input.capabilities.maxOutputTokens ?? Infinity,
          input.requestedOutput ?? this.options.maxOutputTokens ?? Infinity,
        );
        let summary: StructuredSummary | undefined;
        try {
          summary = await this.summarizer({
            model: session.model,
            provider: input.provider,
            capabilities: input.capabilities,
            contextWindow: window,
            messages: session.messages.slice(
              session.context?.activeCheckpoint?.throughMessageIndex ?? 0,
              candidate.throughMessageIndex,
            ),
            prior: session.context?.activeCheckpoint?.summary,
            currentRequest: session.messages
              .slice(candidate.throughMessageIndex)
              .reverse()
              .find(
                (message) =>
                  message.role === "user" &&
                  message.content.length > 0 &&
                  message.content.every((item) => item.type === "text"),
              ),
            targetTokens,
            signal: input.signal,
            onUsage: async (usage) => {
              await this.events?.emit({
                type: "context_summary_usage",
                usage,
                compactionId: candidate.id,
              });
            },
          });
        } catch {
          cancelled(input.signal);
        }
        cancelled(input.signal);
        if (summary) {
          // Verification comes from observed tool results, never a model's claim that tests passed.
          summary.verification = candidate.summary.verification.map((result) =>
            result.length > 600
              ? `${result.slice(0, 300)} ... ${result.slice(-300)}`
              : result,
          );
          summary.changedFiles = {
            ...summary.changedFiles,
            ...candidate.summary.changedFiles,
          };
          summary.importantReferences = [
            ...new Set([
              ...summary.importantReferences,
              ...observedToolReferences(session, candidate.throughMessageIndex),
            ]),
          ].slice(-32);
          candidate.summary = summary;
          candidate.source = "model";
        }
      }
      cancelled(input.signal);
      const projected: Session = {
        ...session,
        context: { ...session.context, activeCheckpoint: candidate },
        contextSnapshot: undefined,
      };
      const after = await this.count(
        { ...input, session: projected },
        assembleMessages(projected),
        false,
      );
      if (!after.exact && before.localTokens > 0)
        after.tokens = Math.ceil(
          (after.localTokens * before.tokens) / before.localTokens,
        );
      if (
        after.localTokens >= before.localTokens ||
        after.tokens >= before.tokens
      ) {
        await this.events?.emit({
          type: "context_compaction_failed",
          compactionId: candidate.id,
          errorCode: "NO_REDUCTION",
        });
        return;
      }
      cancelled(input.signal);
      candidate.estimatedTokens = estimateTokens(candidate.summary);
      const compaction: ContextCompactionRecord = {
        id: candidate.id,
        afterMessage: session.messages.length,
        beforeTokens: before.tokens,
        afterTokens: after.tokens,
        estimated: !(before.exact && after.exact),
        durationMs: Math.max(0, performance.now() - startedAt),
        reason,
        source: candidate.source ?? "evidence",
        createdAt: new Date().toISOString(),
      };
      session.context = {
        ...session.context,
        activeCheckpoint: candidate,
        compactions: [...(session.context?.compactions ?? []), compaction],
      };
      session.contextSnapshot = undefined;
      await this.publish(input, after);
      await this.events?.emit({
        type: "context_compaction_completed",
        compactionId: candidate.id,
        compaction,
      });
      return after;
    } catch (error) {
      await this.events?.emit({
        type: "context_compaction_failed",
        compactionId: candidate.id,
        errorCode: input.signal?.aborted ? "CANCELLED" : "SUMMARY_FAILED",
      });
      cancelled(input.signal);
      throw error;
    }
  }
  private async count(
    input: ContextBuildRequest,
    messages: ContextFrame["messages"],
    calibrate = true,
  ): Promise<ContextCount> {
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
