import Anthropic from "@anthropic-ai/sdk";
import type {
	ChatContent,
	ChatMessage,
	ModelInfo,
	ProviderAdapter,
	ProviderRequest,
	StreamEvent,
	ToolDefinition,
} from "../types/domain.js";
import { ToolNameSchema } from "../types/domain.js";

const DEFAULT_MODEL = "claude-opus-5";

export interface AnthropicAdapterOptions {
	apiKey?: string;
	maxRetries?: number;
	timeoutMs?: number;
}

export class AnthropicAdapter implements ProviderAdapter {
	readonly kind = "anthropic" as const;
	private readonly client: Anthropic;

	constructor(options: AnthropicAdapterOptions = {}) {
		this.client = new Anthropic({
			apiKey: options.apiKey,
			maxRetries: options.maxRetries ?? 2,
			timeout: options.timeoutMs ?? 10 * 60 * 1_000,
		});
	}

	async *streamChat(request: ProviderRequest): AsyncIterable<StreamEvent> {
		try {
			const stream = this.client.messages.stream(
				{
					model: request.model || DEFAULT_MODEL,
					max_tokens: request.maxTokens,
					system: request.system,
					messages: toAnthropicMessages(request.messages),
					tools: toAnthropicTools(request.tools),
					thinking: { type: "adaptive" },
					output_config: { effort: "high" },
				},
				{ signal: request.signal },
			);

			for await (const event of stream) {
				if (event.type !== "content_block_delta") continue;
				if (event.delta.type === "text_delta") {
					yield { type: "text_delta", text: event.delta.text };
				}
				if (event.delta.type === "thinking_delta") {
					yield { type: "thinking_delta", text: event.delta.thinking };
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
				usage: {
					inputTokens: message.usage.input_tokens ?? 0,
					outputTokens: message.usage.output_tokens ?? 0,
					cacheReadTokens: message.usage.cache_read_input_tokens ?? undefined,
					cacheCreationTokens:
						message.usage.cache_creation_input_tokens ?? undefined,
				},
			};
		} catch (error) {
			yield { type: "error", message: formatAnthropicError(error) };
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		const page = await this.client.models.list();
		return page.data.map((model) => ({
			id: model.id,
			displayName: model.display_name ?? undefined,
			contextWindow: model.max_input_tokens ?? undefined,
		}));
	}

	async countTokens(
		request: Pick<ProviderRequest, "model" | "system" | "messages" | "tools">,
	): Promise<number> {
		const result = await this.client.messages.countTokens({
			model: request.model || DEFAULT_MODEL,
			system: request.system,
			messages: toAnthropicMessages(request.messages),
			tools: toAnthropicTools(request.tools),
		});
		return result.input_tokens;
	}
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
		if (!parsedName.success) {
			return [
				{
					type: "text",
					text: `Provider requested unknown tool: ${block.name}`,
				},
			];
		}

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
