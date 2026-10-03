import { randomUUID } from "node:crypto";
import type { ContextManager } from "../context/context-manager.js";
import { partitionTranscript } from "../context/partition.js";
import { ProviderError } from "../providers/errors.js";
import {
  type ApprovalMode,
  approvalModeInstructions,
} from "../security/approval-mode.js";
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
import {
  type AgentMode,
  agentModeInstructions,
  DEFAULT_AGENT_MODE,
} from "./agent-mode.js";
import { cancelled, RuntimeError } from "./errors.js";
import type { RuntimeEventBus } from "./events.js";
import { TurnRunner } from "./turn-runner.js";
import type { TurnState } from "./turn-state.js";
export interface RuntimeTools {
  getApprovalMode?(requested?: ApprovalMode): ApprovalMode;
  selectForTurn(input?: {
    prompt?: string;
    recentTools?: string[];
  }): ToolDefinition[] | Promise<ToolDefinition[]>;
  execute(
    calls: ToolCall[],
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult[]>;
}
export interface RuntimeOptions {
  mode?: AgentMode;
  approvalMode?: ApprovalMode;
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
    const mode = options.mode ?? session.mode ?? DEFAULT_AGENT_MODE;
    session.mode = mode;
    runtime.turnMode = mode;
    const requestedApprovalMode = options.approvalMode ?? session.approvalMode;
    const approvalMode =
      this.tools.getApprovalMode?.(requestedApprovalMode) ??
      requestedApprovalMode;
    runtime.turnApprovalMode = approvalMode;
    if (approvalMode) session.approvalMode = approvalMode;
    const system = `${this.system}\n\n${agentModeInstructions(mode)}${approvalMode ? `\n\n${approvalModeInstructions(approvalMode)}` : ""}`;
    this.events.turnId = runtime.turnId;
    const detach = attachSessionRecorder(session, this.events);
    let finalText = "";
    let overflowRecovered = false;
    let emptyRetried = false;
    let responseRecoveries = 0;
    let responseRecoveryInstructions = "";
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
          system: `${system}${responseRecoveryInstructions}`,
          tools: await this.tools.selectForTurn({
            prompt: typeof input === "string" ? input : input.text,
            recentTools: session.messages
              .slice(-6)
              .flatMap((message) =>
                message.content.flatMap((block) =>
                  block.type === "tool_use" ? [block.name] : [],
                ),
              ),
          }),
          provider: this.provider,
          capabilities,
          signal: options.signal,
          requestedOutput: options.maxTokens,
        });
        await checkpoint();
        await state("calling_provider");
        let response: import("./turn-runner.js").AssistantTurn;
        const textBeforeRequest = finalText;
        try {
          response = await runner.run(
            {
              model: session.model,
              system: frame.system,
              messages: frame.messages,
              tools: frame.tools,
              maxTokens: frame.budget.maxOutputTokens,
              signal: options.signal,
            },
            frame.estimatedInputTokens,
          );
        } catch (error) {
          if (
            error instanceof ProviderError &&
            ["invalid_tool_arguments", "output_truncated"].includes(
              error.code,
            ) &&
            responseRecoveries < 2 &&
            !options.signal?.aborted
          ) {
            responseRecoveries++;
            finalText = textBeforeRequest;
            const limit = frame.budget.maxOutputTokens;
            responseRecoveryInstructions = `\n\nThe previous provider response was rejected before any of its tools ran: ${error.code}. Return complete, valid JSON objects for all tool arguments, with correctly escaped strings. ${limit === undefined ? "The provider truncated the response; keep each response smaller." : `Keep each response comfortably below the ${limit}-token output limit.`} Split large file creation or edits into small complete tool calls across separate turns; create a small valid file first, then extend it using fresh reads and edit_file or apply_patch. Do not repeat previously completed tool calls. Keep prose brief.`;
            await this.events.emit({
              type: "provider_response_recovery",
              errorCode: error.code,
            });
            iteration--;
            continue;
          }
          if (
            error instanceof ProviderError &&
            error.code === "context_overflow" &&
            !overflowRecovered &&
            this.context.options.autoCompact
          ) {
            overflowRecovered = true;
            const changed = await this.context.emergencyCompact(session, {
              session,
              system: frame.system,
              tools: frame.tools,
              provider: this.provider,
              capabilities,
              signal: options.signal,
              requestedOutput: options.maxTokens,
            });
            await checkpoint();
            if (changed) {
              iteration--;
              continue;
            }
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
        await this.context.refresh({
          session,
          system: frame.system,
          tools: frame.tools,
          provider: this.provider,
          capabilities,
          signal: options.signal,
        });
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
