import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { abortable } from "../extensions/lifecycle.js";
import { addTokenUsage, emptySpend } from "../models/accounting.js";
import { StreamingModelRedactor } from "../models/redaction.js";
import type { ModelCapabilities } from "../providers/capabilities.js";
import type { ProviderDefinition } from "../providers/contracts.js";
import { estimateProviderCost } from "../providers/cost.js";
import { normalizeProviderError, ProviderError } from "../providers/errors.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { SecretRedactor } from "../security/redaction.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
  TokenUsage,
} from "../types/domain.js";
import { SUBAGENT_LIMITS } from "./config.js";
import type { SubagentAttempt, SubagentRecord } from "./contracts.js";

export class ChildBudget {
  private ended = false;
  constructor(
    readonly record: SubagentRecord,
    private readonly abort: AbortController,
    private readonly checkpoint: () => Promise<void>,
  ) {}
  assert(): void {
    cancelled(this.abort.signal);
    if (this.ended) this.exhaust("Лимит операций помощника исчерпан.");
  }
  private exhaust(message: string): never {
    this.ended = true;
    this.abort.abort(new RuntimeError("SUBAGENT_BUDGET_EXHAUSTED", message));
    throw new RuntimeError("SUBAGENT_BUDGET_EXHAUSTED", message);
  }
  async tool(): Promise<void> {
    this.assert();
    if (this.record.consumption.tools >= this.record.limits.tools)
      this.exhaust("Лимит инструментов помощника исчерпан.");
    this.record.consumption.tools++;
    await this.checkpoint();
  }
  async start(request: ProviderRequest): Promise<SubagentAttempt> {
    this.assert();
    if (this.record.attempts.length >= this.record.limits.attempts)
      this.exhaust("Лимит запросов модели исчерпан.");
    const attempt: SubagentAttempt = {
      id: randomUUID(),
      purpose:
        request.purpose === "context_summary" ? "compaction" : "generation",
      usageSource: "unknown",
      completed: false,
    };
    this.record.attempts.push(attempt);
    this.record.spend.unknownUsage = true;
    this.record.spend.unknownCost = true;
    await this.checkpoint();
    return attempt;
  }
  async complete(
    attempt: SubagentAttempt,
    usage?: TokenUsage,
    observed = false,
    definition?: ProviderDefinition,
  ): Promise<void> {
    if (attempt.completed) return;
    attempt.completed = true;
    if (usage) {
      attempt.usage = { ...usage };
      attempt.usageSource = observed ? "observed" : "partial";
    }
    const spend = emptySpend();
    for (const current of this.record.attempts) {
      if (current.usage) {
        addTokenUsage(spend.usage, current.usage);
        const cost = definition
          ? estimateProviderCost(
              definition,
              this.record.model,
              current.usage.inputTokens,
              current.usage.outputTokens,
            )
          : { source: "unknown" as const };
        spend.knownCost += cost.usd ?? 0;
        spend.unknownCost ||= cost.source === "unknown";
      } else spend.unknownCost = true;
      spend.unknownUsage ||= current.usageSource !== "observed";
    }
    this.record.spend = spend;
    await this.checkpoint();
  }
}

/** Same production driver. One controlled retry layer, including compaction requests. */
export function boundedChildProvider(input: {
  adapter: ProviderAdapter;
  definition: ProviderDefinition;
  capabilities: ModelCapabilities;
  budget: ChildBudget;
  signal: AbortSignal;
  deadline: number;
  redactor: SecretRedactor;
  beforeRequest(): Promise<void>;
}): ProviderAdapter {
  return {
    providerId: input.adapter.providerId,
    getCapabilities: async (model) => ({
      ...input.capabilities,
      ...(await abortable(
        () => input.adapter.getCapabilities?.(model),
        input.signal,
      )),
      tokenCounting: "local_estimate",
    }),
    // Local counting avoids an unbounded auxiliary SDK request; accounting remains estimated.
    async *streamChat(raw) {
      let last: unknown;
      for (let retry = 0; retry < 3; retry++) {
        cancelled(input.signal);
        await input.beforeRequest();
        const remaining = input.deadline - Date.now();
        if (remaining <= 0)
          throw new ProviderError("cancelled", "Время помощника истекло.");
        const request: ProviderRequest = {
          ...raw,
          signal: raw.signal
            ? AbortSignal.any([input.signal, raw.signal])
            : input.signal,
          transport: {
            maxRetries: 0,
            timeoutMs: Math.min(remaining, 120000),
            compatibilityRetries: false,
            validateTerminal: true,
          },
        };
        const attempt = await input.budget.start(request);
        const redaction = new StreamingModelRedactor(input.redactor);
        let usage: TokenUsage | undefined;
        let observed = false;
        let delivered = false;
        let terminal:
          | Extract<StreamEvent, { type: "turn_complete" }>
          | undefined;
        let error: Extract<StreamEvent, { type: "error" }> | undefined;
        try {
          for await (const event of input.adapter.streamChat(request)) {
            if (event.type === "turn_complete") {
              usage = event.usage;
              observed = event.usageObserved !== false;
            }
            if (event.type === "error" && event.usage) usage = event.usage;
            if (request.signal?.aborted)
              throw new ProviderError("cancelled", "Запрос помощника отменён.");
            if (event.type === "thinking_delta") continue;
            if (event.type === "error") {
              error = event;
              break;
            }
            if (event.type === "text_delta") {
              delivered = true;
              const text = redaction.push(event.text);
              if (text) yield { type: "text_delta", text };
            } else if (event.type === "turn_complete") {
              if (terminal)
                throw new ProviderError(
                  "transport",
                  "Повторное финальное сообщение провайдера.",
                );
              terminal = {
                ...event,
                message: input.redactor.value(event.message),
              };
            } else if (event.type === "tool_call") {
              if (
                Buffer.byteLength(JSON.stringify(event.call.input), "utf8") >
                65536
              )
                throw new ProviderError(
                  "output_truncated",
                  "Аргументы инструмента слишком большие.",
                );
              yield {
                type: "tool_call",
                call: input.redactor.value(event.call),
              };
            }
          }
          if (error) {
            last = new ProviderError(
              error.code ?? "transport",
              input.redactor.text(error.message),
            );
            await input.budget.complete(
              attempt,
              usage,
              false,
              input.definition,
            );
            if (
              !delivered &&
              retry < 2 &&
              error.status &&
              (error.status === 429 || error.status >= 500)
            ) {
              const wait = error.retryAfterMs ?? 250 * 2 ** retry;
              if (wait < input.deadline - Date.now()) {
                await delay(wait, undefined, { signal: request.signal });
                continue;
              }
            }
            const partial = redaction.flush();
            if (partial) yield { type: "text_delta", text: partial };
            yield { ...error, message: input.redactor.text(error.message) };
            return;
          }
          const tail = redaction.flush();
          if (tail) yield { type: "text_delta", text: tail };
          await input.budget.complete(
            attempt,
            usage,
            observed,
            input.definition,
          );
          if (terminal) yield terminal;
          return;
        } catch (error) {
          const tail = redaction.flush();
          if (tail && !input.signal.aborted)
            yield { type: "text_delta", text: tail };
          await input.budget.complete(
            attempt,
            usage,
            observed,
            input.definition,
          );
          if (error instanceof RuntimeError) throw error;
          const failure = normalizeProviderError(error, request.signal);
          last = failure;
          throw new ProviderError(
            failure.code,
            input.redactor.text(failure.message),
          );
        }
      }
      throw last ?? new ProviderError("transport", "Сервис модели недоступен.");
    },
  };
}
