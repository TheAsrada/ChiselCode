import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
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
import type { ModelCapabilities, TokenCountRequest } from "../capabilities.js";
import type { ProviderDriver } from "../contracts.js";
import { normalizeProviderError, ProviderError } from "../errors.js";
import { parseToolArguments } from "../tool-arguments.js";

export interface AnthropicAdapterOptions {
  apiKey?: string | null;
  authToken?: string;
  baseUrl?: string;
  providerId?: string;
  adaptiveThinking?: boolean;
  nativeTokenCounting?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export class AnthropicProtocolAdapter implements ProviderAdapter {
  readonly kind: string;
  readonly providerId: string;
  private readonly options: AnthropicAdapterOptions;
  private readonly client: Anthropic;

  constructor(options: AnthropicAdapterOptions = {}) {
    this.options = options;
    this.kind = this.providerId = options.providerId ?? "anthropic";
    this.client = new Anthropic({
      apiKey: options.apiKey,
      authToken: options.authToken,
      baseURL: options.baseUrl,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 10 * 60 * 1_000,
      fetch: options.fetch,
    });
  }

  async *streamChat(request: ProviderRequest): AsyncIterable<StreamEvent> {
    try {
      // Read raw events: MessageStream's eager partial-JSON parser can fail before
      // max_tokens is known, and must not decide whether a tool call is complete.
      const stream = await this.client.messages.create(
        {
          stream: true,
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          tools: toAnthropicTools(request.tools),
          // Новые параметры (adaptive thinking, effort) шлём только
          // официальному API: совместимые шлюзы их часто не знают и
          // отвечают 400 на весь запрос.
          ...(this.options.adaptiveThinking
            ? {
                thinking: { type: "adaptive" },
                output_config: { effort: "high" },
              }
            : {}),
        },
        { signal: request.signal },
      );

      const blocks = new Map<
        number,
        { block: Anthropic.ContentBlock; json: string }
      >();
      let usage: Anthropic.Usage | undefined;
      let stopReason: string | undefined;
      let terminated = false;
      for await (const event of stream) {
        if (request.signal?.aborted)
          throw new ProviderError("cancelled", "Provider request cancelled.");
        if (event.type === "message_start") {
          if (event.message.role !== "assistant")
            throw new ProviderError(
              "transport",
              "Invalid provider message role.",
            );
          usage = event.message.usage;
        }
        if (event.type === "message_delta") {
          if (usage)
            usage = {
              ...usage,
              input_tokens: event.usage.input_tokens ?? usage.input_tokens,
              output_tokens: event.usage.output_tokens ?? usage.output_tokens,
              cache_read_input_tokens:
                event.usage.cache_read_input_tokens ??
                usage.cache_read_input_tokens,
              cache_creation_input_tokens:
                event.usage.cache_creation_input_tokens ??
                usage.cache_creation_input_tokens,
            };
          stopReason = event.delta.stop_reason ?? stopReason;
        }
        if (event.type === "message_stop") terminated = true;
        if (event.type === "content_block_start") {
          if (
            !Number.isInteger(event.index) ||
            event.index < 0 ||
            blocks.has(event.index)
          )
            throw new ProviderError(
              "transport",
              "Invalid or duplicate provider content block index.",
            );
          blocks.set(event.index, {
            block: { ...event.content_block } as Anthropic.ContentBlock,
            json: "",
          });
        }
        if (event.type !== "content_block_delta") continue;
        const current = blocks.get(event.index);
        if (!current)
          throw new ProviderError(
            "transport",
            "Provider delta has no content block.",
          );
        if (event.delta.type === "input_json_delta") {
          if (current.block.type !== "tool_use")
            throw new ProviderError(
              "transport",
              "Tool arguments delta has an invalid block type.",
            );
          current.json += event.delta.partial_json;
        }
        if (event.delta.type === "text_delta") {
          if (current.block.type !== "text")
            throw new ProviderError(
              "transport",
              "Text delta has an invalid block type.",
            );
          current.block.text += event.delta.text;
          yield { type: "text_delta", text: event.delta.text };
        }
        if (event.delta.type === "thinking_delta") {
          yield { type: "thinking_delta", text: event.delta.thinking };
        }
      }

      if (!terminated || !usage)
        throw new ProviderError(
          "transport",
          "Provider stream ended without a message_stop marker.",
        );
      if (stopReason === "max_tokens")
        throw new ProviderError(
          "output_truncated",
          "Ответ провайдера обрезан по лимиту токенов. Неполные вызовы инструментов не выполнены; большую правку нужно разбить на части.",
        );
      if (stopReason === "model_context_window_exceeded")
        throw new ProviderError(
          "context_overflow",
          "Provider context window exceeded.",
        );
      const content = [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, { block, json }]) => {
          if (block.type === "tool_use" && json.trim())
            block.input = parseToolArguments(json, block.name);
          return block;
        });
      const normalized = fromAnthropicContent(content);
      const ids = new Set<string>();
      for (const content of normalized) {
        if (content.type === "tool_use") {
          if (ids.has(content.id))
            throw new ProviderError(
              "transport",
              "Duplicate provider tool call ID.",
            );
          ids.add(content.id);
        }
      }
      for (const content of normalized) {
        if (content.type === "tool_use") {
          yield {
            type: "tool_call",
            call: { id: content.id, name: content.name, input: content.input },
          };
        }
      }

      yield {
        type: "turn_complete",
        message: { role: "assistant", content: normalized },
        stopReason: stopReason ?? "unknown",
        usage: normalizeAnthropicUsage(usage),
      };
    } catch (error) {
      const failure = normalizeProviderError(error, request.signal);
      yield {
        type: "error",
        message: formatAnthropicError(error),
        code: failure.code,
      };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const page = await this.client.models.list();
      return page.data.map((model) => ({
        id: model.id,
        displayName: model.display_name ?? undefined,
        contextWindow: model.max_input_tokens ?? undefined,
        maxOutputTokens: model.max_tokens ?? undefined,
      }));
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async getCapabilities(model: string): Promise<ModelCapabilities> {
    if (!this.options.nativeTokenCounting)
      return { tokenCounting: "local_estimate" };
    try {
      const info = await this.client.models.retrieve(model);
      return {
        contextWindow: info.max_input_tokens ?? undefined,
        maxOutputTokens: info.max_tokens ?? undefined,
        tokenCounting: "provider",
      };
    } catch {
      return { tokenCounting: "local_estimate" };
    }
  }

  async countTokens(request: TokenCountRequest): Promise<number | undefined> {
    if (!this.options.nativeTokenCounting) return undefined;
    try {
      const result = await this.client.messages.countTokens(
        {
          model: request.model,
          system: request.system,
          messages: toAnthropicMessages(request.messages),
          tools: toAnthropicTools(request.tools),
        },
        { signal: request.signal },
      );
      return result.input_tokens;
    } catch (error) {
      throw normalizeProviderError(error, request.signal);
    }
  }
}

export function normalizeAnthropicUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
    contextInputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
  };
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  })) as Anthropic.Tool[];
}

function toAnthropicMessages(
  messages: ChatMessage[],
): Anthropic.MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map(toAnthropicContent),
  })) as unknown as Anthropic.MessageParam[];
}

function toAnthropicContent(content: ChatContent): Anthropic.ContentBlockParam {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: content.id,
        name: content.name,
        input: content.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: content.toolUseId,
        content: content.content,
        is_error: content.isError ?? false,
      };
  }
}

function fromAnthropicContent(
  content: Anthropic.ContentBlock[],
): ChatContent[] {
  return content.flatMap((block): ChatContent[] => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type !== "tool_use") return [];

    const parsedName = ToolNameSchema.safeParse(block.name);
    if (
      !parsedName.success ||
      !block.id ||
      !block.input ||
      typeof block.input !== "object" ||
      Array.isArray(block.input)
    )
      throw new ProviderError("transport", "Malformed provider tool call.");

    return [
      {
        type: "tool_use",
        id: block.id,
        name: parsedName.data,
        input: block.input as Record<string, unknown>,
      },
    ];
  });
}

function formatAnthropicError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError)
    return "Anthropic authentication failed.";
  if (error instanceof Anthropic.RateLimitError)
    return "Anthropic rate limit exceeded. Try again later.";
  if (error instanceof Anthropic.BadRequestError)
    return `Anthropic rejected the request: ${error.message}`;
  if (error instanceof Anthropic.APIError)
    return `Anthropic API error (${error.status ?? "unknown"}): ${error.message}`;
  return error instanceof Error ? error.message : "Unknown Anthropic error.";
}

const optionsSchema = z
  .object({
    authMode: z.enum(["api-key", "bearer"]).optional(),
    adaptiveThinking: z.boolean().optional(),
    nativeTokenCounting: z.boolean().optional(),
  })
  .strict();
export const anthropicMessagesDriver: ProviderDriver = {
  id: "anthropic-messages",
  validateDefinition(definition) {
    return optionsSchema.safeParse(definition.driverOptions ?? {}).success
      ? []
      : [
          {
            severity: "error",
            code: "invalid_driver_options",
            providerId: definition.id,
            message:
              "Invalid anthropic-messages driverOptions; expected authMode/adaptiveThinking/nativeTokenCounting.",
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
    const adapter: ProviderAdapter = new AnthropicProtocolAdapter({
      ...options,
      nativeTokenCounting:
        options.nativeTokenCounting ??
        definition.capabilities.tokenCounting === "native",
      providerId: definition.id,
      baseUrl,
      ...(options.authMode === "bearer"
        ? { apiKey: null, authToken: apiKey ?? "chisel-no-auth" }
        : { apiKey: apiKey ?? "chisel-no-auth" }),
    });
    if (!definition.capabilities.modelListing) adapter.listModels = undefined;
    if (definition.capabilities.tokenCounting !== "native")
      adapter.countTokens = undefined;
    return adapter;
  },
};
