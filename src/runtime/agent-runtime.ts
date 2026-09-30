import { randomUUID } from "node:crypto";
import type { ContextManager } from "../context/context-manager.js";
import { partitionTranscript } from "../context/partition.js";
import { ProviderError } from "../providers/errors.js";
import { attachSessionRecorder } from "../sessions/checkpoints.js";
import { initializeSessionState } from "../sessions/migrations.js";
import type {
  AgentResult,
  ProviderAdapter,
  Session,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
} from "../types/domain.js";
import { cancelled, RuntimeError } from "./errors.js";
import type { RuntimeEventBus } from "./events.js";
import { TurnRunner } from "./turn-runner.js";
import type { TurnState } from "./turn-state.js";
export interface RuntimeTools {
  selectForTurn(): ToolDefinition[] | Promise<ToolDefinition[]>;
  execute(
    calls: ToolCall[],
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult[]>;
}
export interface RuntimeOptions {
  maxIterations?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onCheckpoint?: (session: Session) => Promise<void>;
}
export class AgentRuntime {
  constructor(
    private readonly provider: ProviderAdapter,
    private readonly context: ContextManager,
    private readonly tools: RuntimeTools,
    private readonly system: string,
    readonly events: RuntimeEventBus,
  ) {}
  async run(
    session: Session,
    input: string | { text: string },
    options: RuntimeOptions = {},
  ): Promise<AgentResult> {
    initializeSessionState(session);
    const runtime = session.runtime;
    if (!runtime) throw new Error("Missing session runtime.");
    runtime.turnId = randomUUID();
    this.events.turnId = runtime.turnId;
    const detach = attachSessionRecorder(session, this.events);
    let finalText = "";
    let overflowRecovered = false;
    let emptyRetried = false;
    const checkpoint = async () => {
      await options.onCheckpoint?.(session);
      await this.events.emit({ type: "checkpoint_saved" });
    };
    const state = (value: TurnState) =>
      this.events.emit({ type: "turn_state", state: value });
    const streamed = this.events.subscribe((event) => {
      if (event.type === "provider_text_delta") finalText += event.text ?? "";
    });
    const executePending = async (): Promise<AgentResult | undefined> => {
      const pending = partitionTranscript(session.messages).find(
        (unit) => unit.pending,
      );
      if (!pending) return;
      const content = pending.messages.flatMap((message) => message.content);
      const results = new Set(
        content
          .filter((item) => item.type === "tool_result")
          .map((item) => item.toolUseId),
      );
      const calls = content.filter(
        (item): item is Extract<typeof item, { type: "tool_use" }> =>
          item.type === "tool_use" && !results.has(item.id),
      );
      await state("executing_tools");
      const outcomes = await this.tools.execute(calls, options.signal);
      const completed = [] as Session["messages"][number]["content"];
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index];
        const result = outcomes[index];
        if (!call || !result) continue;
        if (result.requiresApproval) {
          if (completed.length)
            session.messages.push({ role: "user", content: completed });
          await state("awaiting_approval");
          await checkpoint();
          return {
            status: "approval_required",
            text: finalText,
            session,
            errorCode: "APPROVAL_UNAVAILABLE",
            pendingApproval: {
              tool: call.name,
              preview: result.preview ?? result.output,
            },
          };
        }
        completed.push({
          type: "tool_result",
          toolUseId: call.id,
          content: result.output,
          isError: result.isError,
        });
      }
      if (completed.length)
        session.messages.push({ role: "user", content: completed });
      await checkpoint();
    };
    try {
      const pending = await executePending();
      if (pending) return pending;
      const text = typeof input === "string" ? input : input.text;
      if (text.trim())
        session.messages.push({
          role: "user",
          content: [{ type: "text", text }],
        });
      await checkpoint();
      const capabilities = (await this.provider.getCapabilities?.(
        session.model,
      )) ?? { tokenCounting: "local_estimate" as const };
      const runner = new TurnRunner(this.provider, this.events);
      for (
        let iteration = 0;
        iteration < (options.maxIterations ?? 100);
        iteration++
      ) {
        cancelled(options.signal);
        await state("preparing_context");
        const frame = await this.context.build({
          session,
          system: this.system,
          tools: await this.tools.selectForTurn(),
          provider: this.provider,
          capabilities,
          signal: options.signal,
          requestedOutput: options.maxTokens,
        });
        await checkpoint();
        await state("calling_provider");
        let response: import("./turn-runner.js").AssistantTurn;
        try {
          response = await runner.run(
            {
              model: session.model,
              system: frame.system,
              messages: frame.messages,
              tools: frame.tools,
              maxTokens: frame.budget.reservedOutputTokens,
              signal: options.signal,
            },
            frame.estimatedInputTokens,
          );
        } catch (error) {
          if (
            error instanceof ProviderError &&
            error.code === "context_overflow" &&
            !overflowRecovered
          ) {
            overflowRecovered = true;
            await this.context.emergencyCompact(session);
            await checkpoint();
            iteration--;
            continue;
          }
          throw error;
        }
        await state("processing_response");
        await checkpoint();
        if (response.stopReason === "refusal")
          throw new ProviderError(
            "refusal",
            "The provider refused this request.",
          );
        const hasTools = response.message.content.some(
          (content) => content.type === "tool_use",
        );
        if (hasTools) {
          const pending = await executePending();
          if (pending) return pending;
          continue;
        }
        const text =
          finalText ||
          response.message.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("\n");
        if (!text.trim() && !emptyRetried) {
          emptyRetried = true;
          session.messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: "Give a short text response to the original request; the previous response was empty.",
              },
            ],
          });
          continue;
        }
        if (!text.trim())
          throw new ProviderError(
            "unknown",
            "Provider returned an empty response twice.",
          );
        await state("completed");
        await checkpoint();
        return { status: "completed", text, session };
      }
      throw new RuntimeError(
        "PROVIDER_FAILURE",
        `Agent stopped after ${options.maxIterations ?? 100} iterations.`,
      );
    } catch (error) {
      const isCancelled =
        options.signal?.aborted ||
        (error instanceof RuntimeError && error.code === "CANCELLED") ||
        (error instanceof ProviderError && error.code === "cancelled");
      await state(isCancelled ? "cancelled" : "failed");
      await checkpoint();
      return {
        status: isCancelled ? "cancelled" : "failed",
        text: finalText,
        session,
        error: error instanceof Error ? error.message : String(error),
        errorCode:
          error instanceof ProviderError
            ? error.code === "context_overflow"
              ? "PROVIDER_CONTEXT_OVERFLOW"
              : error.code
            : error instanceof RuntimeError
              ? error.code
              : "PROVIDER_FAILURE",
      };
    } finally {
      detach();
      streamed();
    }
  }
}
