import type { AgentEventPort } from "../extensions/agent-events.js";
import {
  finishAgentModelResponse,
  prepareAgentModelRequest,
  syntheticModelEvents,
} from "../extensions/agent-provider.js";
import { normalizeProviderError, ProviderError } from "../providers/errors.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
  TokenUsage,
} from "../types/domain.js";
import { RuntimeError } from "./errors.js";
import type { RuntimeEventBus } from "./events.js";
export type AssistantTurn = Extract<StreamEvent, { type: "turn_complete" }>;
export class TurnRunner {
  constructor(
    readonly provider: ProviderAdapter,
    private readonly events: RuntimeEventBus,
    private readonly hooks?: AgentEventPort,
  ) {}
  async run(
    request: ProviderRequest,
    estimatedInputTokens: number,
  ): Promise<AssistantTurn> {
    const started = performance.now();
    let observedUsage: TokenUsage | undefined;
    await this.events.emit({
      type: "provider_request_started",
      estimatedInputTokens,
      maxOutputTokens: request.maxTokens,
    });
    let completed: AssistantTurn | undefined;
    const filterText = !!this.hooks?.has("model.response");
    try {
      const context = {
        sessionId: this.events.sessionId,
        turnId: this.events.turnId,
      };
      const prepared = await prepareAgentModelRequest(
        request,
        this.hooks,
        context,
      );
      request = prepared.request;
      for await (const event of prepared.synthetic
        ? syntheticModelEvents(prepared.synthetic)
        : this.provider.streamChat(request)) {
        if (request.signal?.aborted)
          throw new ProviderError("cancelled", "Provider request cancelled.");
        if (event.type === "error") {
          observedUsage = event.usage;
          throw new ProviderError(
            event.code ?? normalizeProviderError(new Error(event.message)).code,
            event.message,
          );
        }
        if (event.type === "text_delta" && !filterText)
          await this.events.emit({
            type: "provider_text_delta",
            text: event.text,
          });
        else if (event.type === "thinking_delta")
          await this.events.emit({
            type: "provider_thinking_delta",
            text: event.text,
          });
        else if (event.type === "turn_complete") {
          if (completed)
            throw new ProviderError(
              "transport",
              "Multiple terminal messages in one stream.",
            );
          completed = event;
          observedUsage = event.usage;
        }
      }
      if (completed?.message.role !== "assistant")
        throw new ProviderError(
          "transport",
          "Provider stream ended without a final assistant message.",
        );
      if (["length", "max_tokens"].includes(completed.stopReason))
        throw new ProviderError(
          "output_truncated",
          "Ответ провайдера обрезан по лимиту токенов; неполные вызовы инструментов не выполнены.",
        );
      completed = await finishAgentModelResponse(
        completed,
        this.hooks,
        context,
        request.signal,
      );
      if (filterText)
        for (const block of completed.message.content)
          if (block.type === "text")
            await this.events.emit({
              type: "provider_text_delta",
              text: block.text,
            });
      await this.events.emit({
        type: "provider_turn_completed",
        message: completed.message,
        usage: completed.usage,
        model: request.model,
        durationMs: performance.now() - started,
      });
      return completed;
    } catch (error) {
      if (
        error instanceof RuntimeError &&
        error.code.startsWith("EXTENSION_")
      ) {
        if (observedUsage)
          await this.events.emit({
            type: "extension_notice",
            usage: observedUsage,
            model: request.model,
          });
        throw error;
      }
      const failure = normalizeProviderError(error, request.signal);
      await this.events.emit({
        type: "provider_failed",
        errorCode: failure.code,
        text: failure.message,
        usage: observedUsage,
        model: request.model,
        durationMs: performance.now() - started,
      });
      throw failure;
    }
  }
}
