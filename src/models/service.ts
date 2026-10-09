import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CapturedModelConfiguration } from "../app/model-runtime.js";
import { contextBudget } from "../context/budget.js";
import { DEFAULT_CONTEXT_OPTIONS } from "../context/types.js";
import { abortable, frozenClone } from "../extensions/lifecycle.js";
import { estimateProviderCost } from "../providers/cost.js";
import { normalizeProviderError, ProviderError } from "../providers/errors.js";
import type { SecretRedactor } from "../security/redaction.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
  TokenUsage,
} from "../types/domain.js";
import { addTokenUsage } from "./accounting.js";
import {
  buildModelRequestContext,
  type ConversationCapture,
  utf8Prefix,
} from "./context.js";
import {
  MODEL_REQUEST_LIMITS,
  type ModelRequestEvent,
  type ModelRequestInput,
  type ModelRequestOwner,
  type ModelRequestPort,
  type ModelRequestResult,
  type ModelRequestStatus,
  type SideQueryRecord,
} from "./contracts.js";
import { StreamingModelRedactor } from "./redaction.js";

const inputSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .refine(
        (text) =>
          Buffer.byteLength(text, "utf8") <= MODEL_REQUEST_LIMITS.questionBytes,
      ),
    context: z.enum(["conversation", "none"]),
    limits: z
      .object({
        inputTokens: z.number().int().positive().optional(),
        outputTokens: z.number().int().positive().optional(),
        outputBytes: z.number().int().positive().optional(),
        deadlineMs: z.number().int().positive().optional(),
        attempts: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface ModelInvocationDependencies {
  owner: ModelRequestOwner;
  invocationId: string;
  command: string;
  acceptedAt: number;
  signal: AbortSignal;
  capture: ConversationCapture;
  model: CapturedModelConfiguration;
  redactor: SecretRedactor;
  resolveAdapter(): Promise<ProviderAdapter>;
  resolveInstructions?(): Promise<string>;
  assertAvailable(): void;
  checkpoint?(record: SideQueryRecord): Promise<void>;
  onRecord?(record: Readonly<SideQueryRecord>): void;
  /** Safe late accounting stays bound to this owner; never emits text or reopens UI. */
  onLateUsage?(
    operationId: string,
    usage: TokenUsage,
    source: "observed" | "partial",
  ): Promise<void>;
}
export interface ModelInvocation {
  readonly port: ModelRequestPort;
  readonly results: readonly ModelRequestResult[];
  close(): Promise<void>;
}

/** Application-owned concurrency and invocation tracking, never a global singleton. */
export class ModelRequestService {
  private readonly active = new Map<string, number>();
  private activeCount = 0;
  private closed = false;
  private readonly operations = new Set<Promise<ModelRequestResult>>();
  private readonly shutdown = new AbortController();
  private disposal?: Promise<void>;

  createInvocation(dependencies: ModelInvocationDependencies): ModelInvocation {
    let closed = false;
    let count = 0;
    const pending = new Set<Promise<ModelRequestResult>>();
    const results: ModelRequestResult[] = [];
    const signal = AbortSignal.any([this.shutdown.signal, dependencies.signal]);
    const assertAvailable = () => {
      if (closed || this.closed || signal.aborted)
        throw new ProviderError("cancelled", "Model invocation is closed.");
      dependencies.assertAvailable();
    };
    const port: ModelRequestPort = Object.freeze({
      request: (
        raw: ModelRequestInput,
        observer?: (event: Readonly<ModelRequestEvent>) => void,
      ) => {
        const operationId =
          count++ === 0 ? dependencies.invocationId : randomUUID();
        let input: ModelRequestInput;
        try {
          assertAvailable();
          input = inputSchema.parse(raw);
        } catch {
          const result = this.rejected(
            dependencies,
            operationId,
            signal.aborted || closed || this.closed
              ? "MODEL_INVOCATION_CLOSED"
              : "MODEL_REQUEST_INVALID_INPUT",
          );
          results.push(result);
          return Promise.resolve(result);
        }
        const key = dependencies.owner.conversationId;
        if (
          (this.active.get(key) ?? 0) >=
            MODEL_REQUEST_LIMITS.activePerConversation ||
          this.activeCount >= MODEL_REQUEST_LIMITS.activePerApplication
        ) {
          const result = this.rejected(
            dependencies,
            operationId,
            (this.active.get(key) ?? 0)
              ? "MODEL_CONVERSATION_BUSY"
              : "MODEL_APPLICATION_BUSY",
          );
          results.push(result);
          return Promise.resolve(result);
        }
        this.active.set(key, (this.active.get(key) ?? 0) + 1);
        this.activeCount++;
        // Ownership is installed synchronously, before bootstrap/counting/network can await.
        const runningAvailable = () => {
          if (this.closed || signal.aborted)
            throw new ProviderError("cancelled", "Model operation cancelled.");
          dependencies.assertAvailable();
        };
        const release = () => {
          pending.delete(work);
          this.operations.delete(work);
          const remaining = (this.active.get(key) ?? 1) - 1;
          if (remaining) this.active.set(key, remaining);
          else this.active.delete(key);
          this.activeCount--;
        };
        const work = Promise.resolve()
          .then(() =>
            this.perform(
              { ...dependencies, signal, assertAvailable: runningAvailable },
              operationId,
              input,
              observer,
            ),
          )
          .then(
            (result) => {
              results.push(result);
              release();
              return result;
            },
            (error: unknown) => {
              release();
              throw error;
            },
          );
        pending.add(work);
        this.operations.add(work);
        void work.catch(() => {});
        return work;
      },
    });
    let disposal: Promise<void> | undefined;
    return {
      port,
      results,
      close: () =>
        (disposal ??= (async () => {
          closed = true;
          await Promise.allSettled([...pending]);
        })()),
    };
  }

  private rejected(
    dependencies: ModelInvocationDependencies,
    operationId: string,
    code: string,
  ): ModelRequestResult {
    return frozenClone({
      operationId,
      owner: dependencies.owner,
      status: "failed",
      text: "",
      error: {
        code,
        message:
          code === "MODEL_CONVERSATION_BUSY"
            ? "Побочный вопрос уже выполняется."
            : code === "MODEL_APPLICATION_BUSY"
              ? "Достигнут лимит побочных запросов приложения."
              : code === "MODEL_INVOCATION_CLOSED"
                ? "Model invocation is closed."
                : "Укажите непустой вопрос длиной до 8 KiB.",
      },
      usageSource: "unknown",
      cost: { source: "unknown" },
      knownCost: 0,
      context: dependencies.capture.provenance,
      attempts: 0,
    });
  }

  private async perform(
    dependencies: ModelInvocationDependencies,
    operationId: string,
    input: ModelRequestInput,
    observer?: (event: Readonly<ModelRequestEvent>) => void,
  ): Promise<ModelRequestResult> {
    const limit = <
      K extends
        | "inputTokens"
        | "outputTokens"
        | "outputBytes"
        | "deadlineMs"
        | "attempts",
    >(
      key: K,
    ) =>
      Math.min(
        MODEL_REQUEST_LIMITS[key],
        input.limits?.[key] ?? MODEL_REQUEST_LIMITS[key],
      );
    const abort = new AbortController();
    const signal = AbortSignal.any([dependencies.signal, abort.signal]);
    const expiresAt = dependencies.acceptedAt + limit("deadlineMs");
    const persistenceAbort = new AbortController();
    const finalDeadline = setTimeout(
      () => persistenceAbort.abort(),
      Math.max(0, expiresAt - Date.now()),
    );
    let timedOut = false;
    let truncated = false;
    let fence = false;
    // Reserve a small part of the same deadline for mandatory terminal persistence.
    const persistenceReserve = Math.min(
      2000,
      Math.floor(limit("deadlineMs") / 10),
    );
    const timer = setTimeout(
      () => {
        timedOut = true;
        abort.abort();
      },
      Math.max(0, expiresAt - Date.now() - persistenceReserve),
    );
    const { redactor } = dependencies;
    const record: SideQueryRecord = {
      ...this.rejected(dependencies, operationId, "MODEL_REQUEST_PREPARING"),
      status: "accepted",
      error: undefined,
      question: "",
      command: dependencies.command,
      providerId: dependencies.model.definition.id,
      profileId: dependencies.model.profileId,
      model: redactor.text(dependencies.model.model),
      acceptedAt: new Date(dependencies.acceptedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      afterMessage: dependencies.capture.provenance.sourceMessageCount,
      revision: 0,
    };
    let outputBytes = 0;
    let receivedText = false;
    const streamRedactor = new StreamingModelRedactor(redactor);
    const emit = (event: ModelRequestEvent) => {
      if (fence) return;
      const safe = frozenClone(redactor.value(event));
      try {
        observer?.(safe);
      } catch {
        /* An observer cannot change request ownership or terminal status. */
      }
    };
    const publish = () => {
      if (!fence) {
        try {
          dependencies.onRecord?.(frozenClone(redactor.value(record)));
        } catch {
          /* Presentation is isolated from transport. */
        }
      }
    };
    const append = (text: string) => {
      if (!text || fence) return;
      const remaining = Math.max(
        0,
        limit("outputBytes") - Buffer.byteLength(record.text, "utf8"),
      );
      const bounded = utf8Prefix(text, remaining);
      record.text += bounded;
      emit({ type: "text", operationId, owner: record.owner, text: bounded });
      publish();
      if (bounded !== text) {
        truncated = true;
        abort.abort();
      }
    };
    const checkpoint = async () => {
      record.revision++;
      record.updatedAt = new Date().toISOString();
      try {
        await dependencies.checkpoint?.(
          redactor.value(structuredClone(record)),
        );
      } catch {
        record.persistenceError =
          "Не удалось сохранить побочный ответ. Он доступен в этом окне до закрытия приложения.";
      }
    };
    const state = (status: ModelRequestStatus) => {
      record.status = status;
      emit({ type: "status", operationId, owner: record.owner, status });
      publish();
    };
    let finishAccounting!: () => void;
    const accountingReady = new Promise<void>((resolve) => {
      finishAccounting = resolve;
    });
    const observed = new Map<number, TokenUsage>();
    const observe = (attempt: number, usage?: TokenUsage) => {
      if (usage) observed.set(attempt, { ...usage });
    };
    try {
      dependencies.assertAvailable();
      if (Date.now() >= expiresAt) {
        timedOut = true;
        abort.abort();
      }
      const adapter = await abortable(dependencies.resolveAdapter, signal);
      const instructions = dependencies.resolveInstructions
        ? await abortable(dependencies.resolveInstructions, signal)
        : undefined;
      dependencies.assertAvailable();
      record.question = redactor.text(input.text);
      state("accepted");
      await abortable(checkpoint, signal);
      if (record.persistenceError)
        throw new Error("MODEL_REQUEST_PERSISTENCE_FAILED");
      state("preparing");
      const capabilities = dependencies.model.capabilities;
      const budget = contextBudget(
        capabilities,
        DEFAULT_CONTEXT_OPTIONS,
        limit("outputTokens"),
      );
      const inputCap = Math.max(
        0,
        Math.min(
          limit("inputTokens"),
          budget.maxInputTokens ?? limit("inputTokens"),
        ),
      );
      const context = buildModelRequestContext({
        capture: dependencies.capture,
        question: input.text,
        instructions,
        context: input.context,
        maxInputTokens: inputCap,
        sanitize: (text) => redactor.text(text),
      });
      record.context = context.provenance;
      const countTokens = adapter.countTokens?.bind(adapter);
      const counted = countTokens
        ? await abortable(
            () =>
              countTokens({
                model: dependencies.model.model,
                ...context,
                tools: [],
                signal,
              }),
            signal,
          )
        : undefined;
      const inputTokens = counted ?? context.provenance.estimatedTokens;
      if (inputTokens > inputCap)
        throw new Error("MODEL_REQUEST_BUDGET_EXCEEDED");
      if (counted !== undefined) {
        record.context.accounting = "count_tokens";
        record.context.estimatedTokens = counted;
      }
      const requestBudget = contextBudget(
        capabilities,
        DEFAULT_CONTEXT_OPTIONS,
        limit("outputTokens"),
        inputTokens,
      );
      if (
        requestBudget.contextWindow !== undefined &&
        inputTokens +
          (requestBudget.maxOutputTokens ?? 0) +
          requestBudget.safetyBufferTokens >
          requestBudget.contextWindow
      )
        throw new Error("MODEL_REQUEST_BUDGET_EXCEEDED");
      await abortable(checkpoint, signal);
      for (let attempt = 1; attempt <= limit("attempts"); attempt++) {
        dependencies.assertAvailable();
        record.attempts = attempt;
        const request: ProviderRequest = {
          model: dependencies.model.model,
          system: context.system,
          messages: context.messages,
          tools: [],
          maxTokens: requestBudget.maxOutputTokens ?? limit("outputTokens"),
          purpose: "extension_request",
          signal,
          transport: {
            maxRetries: 0,
            timeoutMs: Math.max(1, expiresAt - Date.now()),
            compatibilityRetries: false,
          },
        };
        let terminal = false;
        let failure: Extract<StreamEvent, { type: "error" }> | undefined;
        let invalidTool = false;
        const worker = (async () => {
          for await (const event of adapter.streamChat(request)) {
            if (event.type === "turn_complete" || event.type === "error") {
              observe(
                attempt,
                event.type === "turn_complete" && event.usageObserved === false
                  ? undefined
                  : event.usage,
              );
              if (
                (fence || signal.aborted) &&
                event.usage &&
                !(
                  event.type === "turn_complete" &&
                  event.usageObserved === false
                )
              ) {
                await accountingReady;
                const total: TokenUsage = { inputTokens: 0, outputTokens: 0 };
                for (const usage of observed.values())
                  addTokenUsage(total, usage);
                await dependencies.onLateUsage?.(
                  operationId,
                  total,
                  observed.size === record.attempts ? "observed" : "partial",
                );
              }
            }
            if (fence || signal.aborted) continue;
            if (event.type === "text_delta") {
              if (terminal) throw new Error("MODEL_REQUEST_PROTOCOL_ERROR");
              receivedText ||= event.text.length > 0;
              state("receiving");
              outputBytes += Buffer.byteLength(event.text, "utf8");
              const safeInput = utf8Prefix(
                event.text,
                Math.max(
                  0,
                  limit("outputBytes") -
                    (outputBytes - Buffer.byteLength(event.text, "utf8")),
                ),
              );
              append(streamRedactor.push(safeInput));
              if (outputBytes > limit("outputBytes")) {
                truncated = true;
                abort.abort();
              }
            } else if (event.type === "tool_call") invalidTool = true;
            else if (event.type === "error") {
              if (terminal) throw new Error("MODEL_REQUEST_PROTOCOL_ERROR");
              failure = event;
              terminal = true;
            } else if (event.type === "turn_complete") {
              if (terminal) throw new Error("MODEL_REQUEST_PROTOCOL_ERROR");
              terminal = true;
              if (
                event.message.role !== "assistant" ||
                event.message.content.some((block) => block.type !== "text")
              )
                invalidTool = true;
              if (event.stopReason === "refusal")
                failure = {
                  type: "error",
                  code: "refusal",
                  message: "Модель отказалась отвечать на побочный вопрос.",
                };
              if (
                event.stopReason === "length" ||
                event.stopReason === "max_tokens"
              )
                failure = {
                  type: "error",
                  code: "output_truncated",
                  message: "Ответ обрезан по лимиту токенов.",
                };
              if (!receivedText && !invalidTool && !failure) {
                const text = event.message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n");
                outputBytes += Buffer.byteLength(text, "utf8");
                append(
                  streamRedactor.push(utf8Prefix(text, limit("outputBytes"))),
                );
                if (outputBytes > limit("outputBytes")) {
                  truncated = true;
                  abort.abort();
                }
              }
            }
          }
        })();
        await abortable(() => worker, signal);
        if (invalidTool) throw new Error("MODEL_REQUEST_TOOLS_UNSUPPORTED");
        if (!terminal) throw new Error("MODEL_REQUEST_PROTOCOL_ERROR");
        if (failure) {
          const canRetry =
            !receivedText &&
            !record.text &&
            attempt < limit("attempts") &&
            (failure.status === 429 ||
              (failure.status !== undefined &&
                failure.status >= 500 &&
                failure.status <= 599));
          if (canRetry) {
            await abortable(
              () =>
                new Promise<void>((resolve) => {
                  const finish = () => {
                    clearTimeout(backoff);
                    signal.removeEventListener("abort", finish);
                    resolve();
                  };
                  const backoff = setTimeout(finish, 200 * attempt);
                  signal.addEventListener("abort", finish, { once: true });
                }),
              signal,
            );
            continue;
          }
          throw new ProviderError(
            failure.code ?? "unknown",
            failure.message,
            failure.status,
          );
        }
        append(streamRedactor.flush());
        if (!record.text.trim())
          throw new Error("MODEL_REQUEST_EMPTY_RESPONSE");
        state("completed");
        break;
      }
    } catch (error) {
      append(streamRedactor.flush());
      const failure = normalizeProviderError(error, signal);
      const code = timedOut
        ? "MODEL_REQUEST_TIMEOUT"
        : truncated || failure.code === "output_truncated"
          ? "MODEL_REQUEST_TRUNCATED"
          : signal.aborted
            ? "CANCELLED"
            : error instanceof Error &&
                /^MODEL_REQUEST_[A-Z_]+$/.test(error.message)
              ? error.message
              : failure.code;
      record.error = {
        code,
        message: redactor
          .text(
            timedOut
              ? `Превышено время ожидания побочного ответа (${Math.ceil(limit("deadlineMs") / 1000)} секунд).`
              : truncated || failure.code === "output_truncated"
                ? "Ответ обрезан по установленному лимиту; сохранён доступный текст."
                : signal.aborted
                  ? "Побочный ответ остановлен; сохранён доступный текст."
                  : code === "MODEL_REQUEST_TOOLS_UNSUPPORTED"
                    ? "Модель предложила вызов инструмента. В побочном ответе инструменты недоступны."
                    : code === "MODEL_REQUEST_BUDGET_EXCEEDED"
                      ? "Вопрос и необходимые правила не помещаются в бюджет выбранной модели."
                      : code === "MODEL_REQUEST_PROTOCOL_ERROR"
                        ? "Провайдер вернул незавершённый или некорректный ответ."
                        : code === "MODEL_REQUEST_EMPTY_RESPONSE"
                          ? "Модель завершила запрос без текстового ответа."
                          : failure.message,
          )
          .slice(0, 1000),
      };
      state(
        timedOut
          ? "timed_out"
          : truncated || failure.code === "output_truncated"
            ? "truncated"
            : signal.aborted
              ? "cancelled"
              : "failed",
      );
    } finally {
      clearTimeout(timer);
      record.question = redactor.text(input.text);
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      for (const item of observed.values()) addTokenUsage(usage, item);
      record.usage = observed.size ? usage : undefined;
      record.usageSource = observed.size
        ? observed.size === record.attempts
          ? "observed"
          : "partial"
        : "unknown";
      const cost = record.usage
        ? estimateProviderCost(
            dependencies.model.definition,
            dependencies.model.model,
            usage.inputTokens,
            usage.outputTokens,
          )
        : { source: "unknown" as const };
      record.knownCost = cost.usd ?? 0;
      record.cost =
        record.usageSource === "observed" ? cost : { source: "unknown" };
      record.finishedAt = new Date().toISOString();
      try {
        await abortable(checkpoint, persistenceAbort.signal);
      } catch {
        record.persistenceError =
          "Не удалось подтвердить сохранение побочного ответа в срок. Ответ доступен в текущем окне.";
      }
      clearTimeout(finalDeadline);
      publish();
      const result: ModelRequestResult = redactor.value({
        operationId,
        owner: record.owner,
        status: record.status,
        text: record.text,
        error: record.error,
        usage: record.usage,
        usageSource: record.usageSource,
        cost: record.cost,
        knownCost: record.knownCost,
        context: record.context,
        attempts: record.attempts,
      });
      emit({ type: "terminal", operationId, owner: record.owner, result });
      fence = true;
      finishAccounting();
    }
    return frozenClone(
      redactor.value({
        operationId,
        owner: record.owner,
        status: record.status,
        text: record.text,
        error: record.error,
        usage: record.usage,
        usageSource: record.usageSource,
        cost: record.cost,
        knownCost: record.knownCost,
        context: record.context,
        attempts: record.attempts,
      }),
    );
  }

  async dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.closed = true;
      this.shutdown.abort();
      await Promise.allSettled([...this.operations]);
    })();
    return this.disposal;
  }
}
