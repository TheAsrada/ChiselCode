import OpenAI from "openai";
import { z } from "zod";
import { enterpriseFetch } from "../../network/fetch.js";
import type {
  ChatContent,
  ChatMessage,
  ModelInfo,
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
  TokenUsage,
  ToolDefinition,
} from "../../types/domain.js";
import { ToolNameSchema } from "../../types/domain.js";
import type { ProviderDriver } from "../contracts.js";
import { normalizeProviderError, ProviderError } from "../errors.js";
import { catalogModelLimits, modelInfo } from "../model-metadata.js";
import { parseToolArguments } from "../tool-arguments.js";
import { ProviderToolNames } from "../tool-names.js";

export interface OpenAIAdapterOptions {
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  apiKey?: string;
  baseUrl?: string;
  providerId?: string;
  includeUsage?: boolean;
  tokenLimitFallback?: boolean;
  allowModelMetadata?: boolean;
}

/** prompt_tokens already contains cached tokens in OpenAI completions. */
export function normalizeOpenAIUsage(
  usage: NonNullable<OpenAI.Chat.Completions.ChatCompletionChunk["usage"]>,
): TokenUsage {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    contextInputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? undefined,
  };
}

export class OpenAIProtocolAdapter implements ProviderAdapter {
  readonly kind: string;
  readonly providerId: string;
  private readonly options: OpenAIAdapterOptions;
  private readonly client: OpenAI;
  private metadata?: Promise<ModelInfo[]>;
  private usageSupported = true;

  constructor(options: OpenAIAdapterOptions = {}) {
    this.options = options;
    this.kind = this.providerId = options.providerId ?? "openai";
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 600_000,
      fetch: options.fetch ?? enterpriseFetch,
    });
  }

  /**
   * Создаёт стриминговый completion. Для совместимых шлюзов при 400
   * на параметр лимита токенов повторяет запрос один раз с другим именем
   * параметра: часть шлюзов принимает только `max_tokens`, часть
   * (новые модели OpenAI) — только `max_completion_tokens`. AgentRouter —
   * такой же шлюз (Claude-модели за ним понимают только `max_tokens`),
   * поэтому повтор включён и для него; настоящий OpenAI — без повтора.
   */
  private async createCompletionStream(
    request: ProviderRequest,
    useLegacyMaxTokens: boolean,
    includeUsage = this.usageSupported && (this.options.includeUsage ?? true),
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming =
      {
        model: request.model,
        stream: true,
        messages: toOpenAIMessages(request.system, request.messages),
        tools: toOpenAITools(request.tools),
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        ...(request.maxTokens === undefined
          ? {}
          : useLegacyMaxTokens
            ? { max_tokens: request.maxTokens }
            : { max_completion_tokens: request.maxTokens }),
      };
    try {
      return await this.client.chat.completions.create(params, {
        signal: request.signal,
        ...(request.transport
          ? {
              maxRetries: request.transport.maxRetries,
              timeout: request.transport.timeoutMs,
            }
          : {}),
      });
    } catch (error) {
      if (
        request.transport?.compatibilityRetries !== false &&
        includeUsage &&
        error instanceof OpenAI.APIError &&
        error.status === 400 &&
        /stream_options|include_usage/i.test(error.message)
      ) {
        this.usageSupported = false;
        return this.createCompletionStream(request, useLegacyMaxTokens, false);
      }
      if (
        request.transport?.compatibilityRetries !== false &&
        !useLegacyMaxTokens &&
        request.maxTokens !== undefined &&
        this.options.tokenLimitFallback &&
        isTokenLimitError(error)
      ) {
        return this.createCompletionStream(request, true, includeUsage);
      }
      throw error;
    }
  }

  async *streamChat(request: ProviderRequest): AsyncIterable<StreamEvent> {
    const names = new ProviderToolNames(request.tools, request.messages);
    const wireRequest = {
      ...request,
      tools: names.tools(request.tools),
      messages: names.messages(request.messages),
    };
    let observedUsage: TokenUsage | undefined;
    try {
      const stream = await this.createCompletionStream(wireRequest, false);
      const toolCalls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let text = "";
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let finishReason = "end_turn";
      let terminated = false;
      let refused = false;

      for await (const chunk of stream) {
        if (request.signal?.aborted)
          throw new ProviderError("cancelled", "Provider request cancelled.");
        if (chunk.usage) {
          usage = normalizeOpenAIUsage(chunk.usage);
          observedUsage = usage;
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (
          (request.purpose === "extension_request" ||
            request.transport?.validateTerminal) &&
          terminated &&
          (choice.finish_reason ||
            choice.delta.content ||
            choice.delta.tool_calls?.length)
        )
          throw new ProviderError(
            "transport",
            "Provider emitted data after its terminal message.",
          );
        if (choice.finish_reason) terminated = true;
        if (choice.delta.refusal) {
          text += choice.delta.refusal;
          refused = true;
          finishReason = "refusal";
        }
        finishReason = refused
          ? "refusal"
          : (normalizeFinishReason(choice.finish_reason) ?? finishReason);
        const reasoning = reasoningText(choice.delta);
        if (reasoning) yield { type: "thinking_delta", text: reasoning };
        if (choice.delta.content) {
          text += choice.delta.content;
          yield { type: "text_delta", text: choice.delta.content };
        }
        for (const call of choice.delta.tool_calls ?? []) {
          const index = call.index;
          if (!Number.isInteger(index) || index < 0)
            throw new ProviderError(
              "transport",
              "Invalid provider tool call index.",
            );
          const current = toolCalls.get(index) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (
            (call.id && current.id && call.id !== current.id) ||
            (call.function?.name &&
              current.name &&
              call.function.name !== current.name)
          )
            throw new ProviderError(
              "transport",
              "Provider changed a tool call ID or name during streaming.",
            );
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name = call.function.name;
          if (call.function?.arguments)
            current.arguments += call.function.arguments;
          toolCalls.set(index, current);
        }
        if (chunk.usage) {
          usage = normalizeOpenAIUsage(chunk.usage);
        }
      }

      if (!terminated)
        throw new ProviderError(
          "transport",
          "Provider stream ended without a finish marker.",
        );
      if (finishReason === "length")
        throw new ProviderError(
          "output_truncated",
          "Ответ провайдера обрезан по лимиту токенов. Неполные вызовы инструментов не выполнены; большую правку нужно разбить на части.",
        );
      const content: ChatContent[] = text ? [{ type: "text", text }] : [];
      const ids = new Set<string>();
      for (const [, call] of [...toolCalls.entries()].sort(
        ([a], [b]) => a - b,
      )) {
        const parsedName = ToolNameSchema.safeParse(names.domain(call.name));
        if (!parsedName.success || !call.id || ids.has(call.id))
          throw new ProviderError(
            "transport",
            "Malformed provider tool call: missing or duplicate ID, or invalid name.",
          );
        ids.add(call.id);
        const input = parseToolArguments(call.arguments, call.name);
        content.push({
          type: "tool_use",
          id: call.id,
          name: parsedName.data,
          input,
        });
      }

      for (const item of content) {
        if (item.type === "tool_use")
          yield {
            type: "tool_call",
            call: { id: item.id, name: item.name, input: item.input },
          };
      }
      yield {
        type: "turn_complete",
        message: { role: "assistant", content },
        stopReason: finishReason,
        usage,
        usageObserved: observedUsage !== undefined,
      };
    } catch (error) {
      const failure = normalizeProviderError(error, request.signal);
      yield {
        type: "error",
        message: formatOpenAIError(error),
        code: failure.code,
        status: failure.status,
        usage: observedUsage,
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const models = await this.client.models.list();
      return models.data.flatMap((model) => {
        const info = modelInfo(model, this.providerId);
        return info ? [info] : [];
      });
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async getCapabilities(model: string) {
    let limits = catalogModelLimits(this.providerId, model);
    if (this.options.allowModelMetadata !== false) {
      this.metadata ??= this.client.models
        .list({ timeout: 5000, maxRetries: 0 })
        .then((page) =>
          page.data.flatMap((item) => {
            const info = modelInfo(item, this.providerId);
            return info ? [info] : [];
          }),
        )
        .catch(() => []);
      const known = (await this.metadata).find((info) => info.id === model);
      if (known) limits = { ...limits, ...known };
    }
    return { ...limits, tokenCounting: "local_estimate" as const };
  }
  async countTokens(): Promise<undefined> {
    return undefined;
  }
}

/**
 * Ошибка 400 про лимит токенов: шлюз не принимает выбранное имя параметра.
 * Работает и с настоящими OpenAI.APIError, и с похожими объектами.
 */
export function isTokenLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status =
    error instanceof OpenAI.APIError
      ? error.status
      : (error as { status?: unknown }).status;
  if (status !== 400) return false;
  const message =
    error instanceof Error
      ? error.message
      : String((error as { message?: unknown }).message ?? "");
  return /max_(completion_)?tokens/i.test(message);
}

function toOpenAITools(
  tools: ToolDefinition[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function toOpenAIMessages(
  system: string,
  messages: ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];
  for (const message of messages) {
    const text = message.content
      .filter(
        (content): content is Extract<ChatContent, { type: "text" }> =>
          content.type === "text",
      )
      .map((content) => content.text)
      .join("\n");
    const toolUses = message.content.filter(
      (content): content is Extract<ChatContent, { type: "tool_use" }> =>
        content.type === "tool_use",
    );
    const toolResults = message.content.filter(
      (content): content is Extract<ChatContent, { type: "tool_result" }> =>
        content.type === "tool_result",
    );

    if (message.role === "assistant") {
      result.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolUses.map((tool) => ({
          type: "function",
          id: tool.id,
          function: { name: tool.name, arguments: JSON.stringify(tool.input) },
        })),
      });
    } else if (text) {
      result.push({ role: "user", content: text });
    }
    for (const tool of toolResults) {
      result.push({
        role: "tool",
        tool_call_id: tool.toolUseId,
        content: tool.content,
      });
    }
  }
  return result;
}

function reasoningText(delta: unknown): string | undefined {
  if (!delta || typeof delta !== "object") return undefined;
  const candidate = delta as Record<string, unknown>;
  const value =
    candidate.reasoning_content ?? candidate.reasoning ?? candidate.thinking;
  return typeof value === "string" && value ? value : undefined;
}

function normalizeFinishReason(reason: string | null): string | undefined {
  if (!reason) return undefined;
  if (reason === "tool_calls") return "tool_use";
  if (reason === "content_filter") return "refusal";
  if (reason === "stop") return "end_turn";
  return reason;
}

function formatOpenAIError(error: unknown): string {
  if (error instanceof OpenAI.AuthenticationError)
    return "Provider authentication failed.";
  if (error instanceof OpenAI.RateLimitError)
    return "Provider rate limit exceeded. Try again later.";
  if (error instanceof OpenAI.APIError)
    return `Provider API error (${error.status ?? "unknown"}): ${error.message}`;
  return error instanceof Error ? error.message : "Unknown provider error.";
}

const optionsSchema = z
  .object({
    includeUsage: z.boolean().optional(),
    tokenLimitFallback: z.boolean().default(true),
  })
  .strict();
export const openaiChatDriver: ProviderDriver = {
  id: "openai-chat",
  validateDefinition(definition) {
    return optionsSchema.safeParse(definition.driverOptions ?? {}).success
      ? []
      : [
          {
            severity: "error",
            code: "invalid_driver_options",
            providerId: definition.id,
            message:
              "Invalid openai-chat driverOptions; expected includeUsage/tokenLimitFallback booleans.",
          },
        ];
  },
  create({ definition, apiKey, baseUrl }) {
    if (!baseUrl)
      throw new ProviderError(
        "invalid_endpoint",
        "This HTTP protocol requires an effective baseUrl; configure definition endpoint or profile.baseUrl.",
      );
    const options = optionsSchema.parse(definition.driverOptions ?? {});
    const adapter: ProviderAdapter = new OpenAIProtocolAdapter({
      ...options,
      providerId: definition.id,
      allowModelMetadata: definition.capabilities.modelListing,
      apiKey: apiKey ?? "chisel-no-auth",
      baseUrl,
    });
    if (!definition.capabilities.modelListing) adapter.listModels = undefined;
    adapter.countTokens = undefined;
    return adapter;
  },
};
