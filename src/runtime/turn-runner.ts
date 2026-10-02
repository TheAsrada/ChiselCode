import { normalizeProviderError, ProviderError } from "../providers/errors.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
  TokenUsage,
} from "../types/domain.js";
import type { RuntimeEventBus } from "./events.js";
export type AssistantTurn = Extract<StreamEvent, { type: "turn_complete" }>;
export class TurnRunner {
  constructor(
    readonly provider: ProviderAdapter,
    private readonly events: RuntimeEventBus,
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
    try {
      for await (const event of this.provider.streamChat(request)) {
        if (request.signal?.aborted)
          throw new ProviderError("cancelled", "Provider request cancelled.");
        if (event.type === "error") {
          observedUsage = event.usage;
          throw new ProviderError(
            event.code ?? normalizeProviderError(new Error(event.message)).code,
            event.message,
          );
        }
        if (event.type === "text_delta")
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
      await this.events.emit({
        type: "provider_turn_completed",
        message: completed.message,
        usage: completed.usage,
        durationMs: performance.now() - started,
      });
      return completed;
    } catch (error) {
      const failure = normalizeProviderError(error, request.signal);
      await this.events.emit({
        type: "provider_failed",
        errorCode: failure.code,
        text: failure.message,
        usage: observedUsage,
        durationMs: performance.now() - started,
      });
      throw failure;
    }
  }
}
