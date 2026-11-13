import { z } from "zod";
import {
  normalizeProviderError,
  ProviderError,
} from "../../../providers/errors.js";
import {
  catalogModelLimits,
  modelInfo,
} from "../../../providers/model-metadata.js";
import { parseToolArguments } from "../../../providers/tool-arguments.js";
import { ProviderToolNames } from "../../../providers/tool-names.js";
import type {
  ChatContent,
  ModelInfo,
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "../../../types/domain.js";
import {
  type ChatGptTransport,
  readChatGptJson,
  responseEvents,
} from "./transport.js";
import type { ChatGptUsage } from "./usage.js";

const OutputItem = z.object({
  type: z.string(),
  call_id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        refusal: z.string().optional(),
      }),
    )
    .optional(),
});
const Completed = z.object({
  status: z.literal("completed"),
  output: z.array(OutputItem),
  usage: z
    .object({
      input_tokens: z.number().nonnegative(),
      output_tokens: z.number().nonnegative(),
      input_tokens_details: z
        .object({ cached_tokens: z.number().nonnegative().optional() })
        .optional(),
    })
    .nullish(),
});
const Catalog = z.object({ models: z.array(z.unknown()) });
const CatalogEntry = z
  .object({ slug: z.string().trim().min(1), visibility: z.unknown() })
  .passthrough();
// The subscription backend gates its catalog by Codex client version.
// Use the verified protocol baseline, independent of ChiselCode's release number.
const CODEX_CATALOG_VERSION = "0.166.0";
export function responsesInput(
  request: ProviderRequest,
  names: ProviderToolNames,
) {
  return request.messages.flatMap((message) => {
    const items: Record<string, unknown>[] = [];
    let text: string[] = [];
    const flush = () => {
      if (text.length)
        items.push({
          role: message.role,
          content: text.map((value) => ({
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: value,
          })),
        });
      text = [];
    };
    for (const block of message.content) {
      if (block.type === "text") text.push(block.text);
      else {
        flush();
        if (block.type === "tool_use")
          items.push({
            type: "function_call",
            call_id: block.id,
            name: names.wire(block.name),
            arguments: JSON.stringify(block.input),
          });
        else
          items.push({
            type: "function_call_output",
            call_id: block.toolUseId,
            output: block.content,
          });
      }
    }
    flush();
    return items;
  });
}
export class ChatGptAdapter implements ProviderAdapter {
  readonly providerId = "chatgpt";
  private metadata?: Promise<ModelInfo[]>;
  constructor(
    private profileId: string,
    private transport: ChatGptTransport,
    private usage: ChatGptUsage,
  ) {}
  listModels(): Promise<ModelInfo[]> {
    this.metadata ??= this.loadModels().catch((error) => {
      this.metadata = undefined;
      throw error;
    });
    return this.metadata.then((models) =>
      models.map((model) => ({ ...model })),
    );
  }
  private async loadModels() {
    const response = await this.transport.request(
      this.profileId,
      `/codex/models?client_version=${CODEX_CATALOG_VERSION}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    const catalog = Catalog.safeParse(await readChatGptJson(response));
    if (!catalog.success)
      throw new ProviderError(
        "transport",
        "Некорректный каталог моделей ChatGPT.",
      );
    const models: ModelInfo[] = [];
    for (const raw of catalog.data.models) {
      const entry = CatalogEntry.safeParse(raw);
      if (!entry.success) continue;
      const { slug, visibility } = entry.data;
      if (visibility != null && visibility !== "list") continue;
      const model = modelInfo({ ...entry.data, id: slug }, this.providerId);
      if (model) models.push(model);
    }
    if (!models.length)
      throw new ProviderError(
        "unavailable",
        "ChatGPT не вернул доступные модели для этого профиля.",
      );
    return models;
  }
  async getCapabilities(model: string) {
    let info: ModelInfo | undefined;
    try {
      info = (await this.listModels()).find((entry) => entry.id === model);
    } catch {
      /* Exact catalog limits remain available offline. */
    }
    return {
      ...catalogModelLimits(this.providerId, model),
      ...info,
      tokenCounting: "local_estimate" as const,
      parallelToolCalls: true,
    };
  }
  async *streamChat(request: ProviderRequest): AsyncIterable<StreamEvent> {
    const signal = AbortSignal.any([
      ...(request.signal ? [request.signal] : []),
      AbortSignal.timeout(request.transport?.timeoutMs ?? 600_000),
    ]);
    const names = new ProviderToolNames(request.tools, request.messages);
    try {
      const response = await this.transport.request(
        this.profileId,
        "/codex/responses",
        {
          method: "POST",
          signal,
          headers: { Accept: "text/event-stream" },
          body: JSON.stringify({
            model: request.model,
            instructions: request.system,
            input: responsesInput(request, names),
            stream: true,
            store: false,
            parallel_tool_calls: true,
            ...(request.tools.length
              ? {
                  tools: names.tools(request.tools).map((tool) => ({
                    type: "function",
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                    strict: false,
                  })),
                  tool_choice: "auto",
                }
              : {}),
          }),
        },
      );
      this.usage.headers(this.profileId, response.headers);
      let text = "";
      let terminal = false;
      for await (const event of responseEvents(response)) {
        signal.throwIfAborted();
        if (
          event.type === "response.output_text.delta" &&
          typeof event.delta === "string"
        ) {
          text += event.delta;
          yield { type: "text_delta", text: event.delta };
        } else if (
          event.type === "response.reasoning_summary_text.delta" &&
          typeof event.delta === "string"
        ) {
          yield { type: "thinking_delta", text: event.delta };
        } else if (
          event.type === "response.function_call_arguments.delta" &&
          typeof event.delta === "string" &&
          event.delta
        ) {
          yield { type: "tool_delta" };
        } else if (event.type === "response.failed" || event.type === "error") {
          const failed = z
            .object({
              error: z.object({ code: z.string().optional() }).nullish(),
            })
            .safeParse(event.response ?? event);
          const code = failed.success ? failed.data.error?.code : undefined;
          throw new ProviderError(
            code === "context_length_exceeded"
              ? "context_overflow"
              : code === "usage_limit_reached" || code === "rate_limit_exceeded"
                ? "rate_limit"
                : code === "model_not_found"
                  ? "model_not_found"
                  : "unavailable",
            code === "context_length_exceeded"
              ? "Превышено окно контекста ChatGPT."
              : code === "usage_limit_reached" || code === "rate_limit_exceeded"
                ? "Лимит подписки ChatGPT исчерпан."
                : "ChatGPT не завершил ответ. Повторите запрос.",
          );
        } else if (event.type === "response.incomplete") {
          throw new ProviderError(
            "output_truncated",
            "ChatGPT прервал ответ до завершения.",
          );
        } else if (
          event.type === "response.completed" ||
          event.type === "response.done"
        ) {
          const completed = Completed.parse(event.response);
          const content: ChatContent[] = [];
          const finalText = completed.output
            .flatMap((item) => item.content ?? [])
            .filter((item) => item.type === "output_text")
            .map((item) => item.text ?? "")
            .join("");
          if (finalText && finalText !== text) {
            if (!finalText.startsWith(text))
              throw new ProviderError(
                "transport",
                "Итог ChatGPT не совпадает с потоком ответа.",
              );
            const tail = finalText.slice(text.length);
            text = finalText;
            yield { type: "text_delta", text: tail };
          }
          if (text) content.push({ type: "text", text });
          const callIds = new Set<string>();
          for (const item of completed.output) {
            if (item.content?.some((part) => part.type === "refusal"))
              throw new ProviderError("refusal", "ChatGPT отклонил запрос.");
            if (item.type !== "function_call") continue;
            if (
              !item.call_id ||
              !item.name ||
              item.arguments === undefined ||
              item.arguments.length > 1024 * 1024
            )
              throw new ProviderError(
                "invalid_tool_arguments",
                "ChatGPT вернул неполный вызов инструмента.",
              );
            if (callIds.has(item.call_id))
              throw new ProviderError(
                "invalid_tool_arguments",
                "ChatGPT повторил идентификатор вызова инструмента.",
              );
            callIds.add(item.call_id);
            const call = {
              id: item.call_id,
              name: names.domain(item.name),
              input: parseToolArguments(
                item.arguments,
                names.domain(item.name),
              ),
            };
            content.push({ type: "tool_use", ...call });
          }
          // Validate every tool before emitting any of them.
          for (const item of content)
            if (item.type === "tool_use")
              yield {
                type: "tool_call",
                call: { id: item.id, name: item.name, input: item.input },
              };
          const observed = completed.usage;
          const inputTokens = observed?.input_tokens ?? 0;
          yield {
            type: "turn_complete",
            message: { role: "assistant", content },
            stopReason: content.some((item) => item.type === "tool_use")
              ? "tool_use"
              : "stop",
            usage: {
              inputTokens,
              contextInputTokens: inputTokens,
              outputTokens: observed?.output_tokens ?? 0,
              cacheReadTokens: observed?.input_tokens_details?.cached_tokens,
            },
            usageObserved: !!observed,
          };
          terminal = true;
          break;
        }
      }
      if (!terminal)
        throw new ProviderError(
          "transport",
          "Поток ChatGPT оборвался до завершения ответа.",
        );
    } catch (error) {
      const failure =
        signal.aborted && !request.signal?.aborted
          ? new ProviderError("timeout", "Превышено время ожидания ChatGPT.")
          : normalizeProviderError(error, request.signal);
      yield {
        type: "error",
        message: failure.message,
        code: failure.code,
        status: failure.status,
        retryAfterMs: failure.retryAfterMs,
      };
    }
  }
}
