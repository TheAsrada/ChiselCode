import OpenAI from "openai";
import type {
  ChatContent,
  ChatMessage,
  ModelInfo,
  ProviderAdapter,
  ProviderKind,
  ProviderRequest,
  StreamEvent,
  ToolDefinition,
} from "../types/domain.js";
import { ToolNameSchema } from "../types/domain.js";

export interface OpenAIAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  kind?: Extract<ProviderKind, "openai" | "openai-compatible">;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly kind: Extract<ProviderKind, "openai" | "openai-compatible">;
  private readonly client: OpenAI;

  constructor(options: OpenAIAdapterOptions = {}) {
    this.kind = options.kind ?? "openai";
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
    });
  }

  async *streamChat(request: ProviderRequest): AsyncIterable<StreamEvent> {
    try {
      const stream = await this.client.chat.completions.create({
        model: request.model,
        stream: true,
        max_completion_tokens: request.maxTokens,
        messages: toOpenAIMessages(request.system, request.messages),
        tools: toOpenAITools(request.tools),
      });
      const toolCalls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason = "end_turn";

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        finishReason =
          normalizeFinishReason(choice.finish_reason) ?? finishReason;
        const reasoning = reasoningText(choice.delta);
        if (reasoning) yield { type: "thinking_delta", text: reasoning };
        if (choice.delta.content) {
          text += choice.delta.content;
          yield { type: "text_delta", text: choice.delta.content };
        }
        for (const call of choice.delta.tool_calls ?? []) {
          const index = call.index;
          const current = toolCalls.get(index) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments)
            current.arguments += call.function.arguments;
          toolCalls.set(index, current);
        }
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }
      }

      const content: ChatContent[] = text ? [{ type: "text", text }] : [];
      for (const call of toolCalls.values()) {
        const parsedName = ToolNameSchema.safeParse(call.name);
        if (!parsedName.success) {
          content.push({
            type: "text",
            text: `Provider requested unknown tool: ${call.name}`,
          });
          continue;
        }
        try {
          content.push({
            type: "tool_use",
            id: call.id,
            name: parsedName.data,
            input: JSON.parse(call.arguments) as Record<string, unknown>,
          });
        } catch {
          content.push({
            type: "text",
            text: `Provider sent invalid JSON for ${call.name}.`,
          });
        }
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
        usage: { inputTokens, outputTokens },
      };
    } catch (error) {
      yield { type: "error", message: formatOpenAIError(error) };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = await this.client.models.list();
    return models.data.map((model) => ({ id: model.id }));
  }

  async countTokens(): Promise<number> {
    throw new Error(
      `Token counting is unavailable for ${this.kind}; use provider-reported usage after a request.`,
    );
  }
}

export class OpenAICompatibleAdapter extends OpenAIAdapter {
  constructor(options: Omit<OpenAIAdapterOptions, "kind">) {
    if (!options.baseUrl)
      throw new Error("OpenAI-compatible providers require baseUrl.");
    super({ ...options, kind: "openai-compatible" });
  }
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
