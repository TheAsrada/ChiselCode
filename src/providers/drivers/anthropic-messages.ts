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
      const stream = this.client.messages.stream(
        {
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

      const toolArguments = new Map<number, string>();
      let terminated = false;
      for await (const event of stream) {
        if (event.type === "message_stop") terminated = true;
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "input_json_delta")
          toolArguments.set(
            event.index,
            (toolArguments.get(event.index) ?? "") + event.delta.partial_json,
          );
        if (event.delta.type === "text_delta") {
          yield { type: "text_delta", text: event.delta.text };
        }
        if (event.delta.type === "thinking_delta") {
          yield { type: "thinking_delta", text: event.delta.thinking };
        }
      }

      if (!terminated)
        throw new ProviderError(
          "transport",
          "Provider stream ended without a message_stop marker.",
        );
      for (const json of toolArguments.values()) {
        try {
          JSON.parse(json);
        } catch {
          throw new ProviderError(
            "transport",
            "Invalid JSON arguments in provider tool call.",
          );
        }
      }
      const message = await stream.finalMessage();
      const normalized = fromAnthropicContent(message.content);
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
        stopReason: message.stop_reason ?? "unknown",
        usage: normalizeAnthropicUsage(message.usage),
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
