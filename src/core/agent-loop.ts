import { estimateCost } from "../sessions/store.js";
import type { ToolRegistry } from "../tools/registry.js";
import type {
  AgentResult,
  ChatMessage,
  ProviderAdapter,
  Session,
  StreamEvent,
  TokenUsage,
  ToolExecutionResult,
} from "../types/domain.js";
import { compactMessages } from "./prompt.js";

export interface AgentEventHandlers {
  onText?(text: string): void;
  onThinking?(text: string): void;
  onToolStart?(name: string, input: Record<string, unknown>): void;
  onToolResult?(name: string, result: ToolExecutionResult): void;
}

export interface AgentLoopOptions {
  maxIterations?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export class AgentLoop {
  constructor(
    private readonly provider: ProviderAdapter,
    private readonly tools: ToolRegistry,
    private readonly system: string,
    private readonly handlers: AgentEventHandlers = {},
  ) {}

  async run(
    session: Session,
    prompt: string,
    options: AgentLoopOptions = {},
  ): Promise<AgentResult> {
    const maxIterations = options.maxIterations ?? 100;
    session.messages.push({
      role: "user",
      content: [{ type: "text", text: prompt }],
    });
    let finalText = "";

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (options.signal?.aborted)
        return { status: "cancelled", text: finalText, session };

      let completed:
        | Extract<StreamEvent, { type: "turn_complete" }>
        | undefined;
      let providerError: string | undefined;
      const requestMessages = compactMessages(session.messages);

      for await (const event of this.provider.streamChat({
        model: session.model,
        system: this.system,
        messages: requestMessages,
        tools: this.tools.getDefinitions(),
        maxTokens: options.maxTokens ?? 64_000,
        signal: options.signal,
      })) {
        if (event.type === "text_delta") {
          finalText += event.text;
          this.handlers.onText?.(event.text);
        } else if (event.type === "thinking_delta") {
          this.handlers.onThinking?.(event.text);
        } else if (event.type === "turn_complete") {
          completed = event;
        } else if (event.type === "error") {
          providerError = event.message;
        }
      }

      if (providerError)
        return {
          status: "failed",
          text: finalText,
          session,
          error: providerError,
        };
      if (!completed)
        return {
          status: "failed",
          text: finalText,
          session,
          error: "Provider stream ended without a final message.",
        };

      session.messages.push(completed.message);
      addUsage(session, completed.usage);
      const toolCalls = completed.message.content.filter(
        (content) => content.type === "tool_use",
      );

      if (toolCalls.length === 0 || completed.stopReason === "refusal") {
        return {
          status: completed.stopReason === "refusal" ? "failed" : "completed",
          text: finalText || extractText(completed.message),
          session,
          error:
            completed.stopReason === "refusal"
              ? "The provider refused this request."
              : undefined,
        };
      }

      const results = [] as ChatMessage["content"];
      for (const call of toolCalls) {
        this.handlers.onToolStart?.(call.name, call.input);
        const result = await this.tools.execute(call.name, call.input);
        this.handlers.onToolResult?.(call.name, result);
        if (result.requiresApproval) {
          return {
            status: "approval_required",
            text: finalText || extractText(completed.message),
            session,
            pendingApproval: {
              tool: call.name,
              preview: result.preview ?? result.output,
            },
          };
        }
        results.push({
          type: "tool_result",
          toolUseId: call.id,
          content: result.output,
          isError: result.isError,
        });
      }
      session.messages.push({ role: "user", content: results });
    }

    return {
      status: "failed",
      text: finalText,
      session,
      error: `Agent stopped after ${maxIterations} tool-use iterations.`,
    };
  }
}

function addUsage(session: Session, usage: TokenUsage): void {
  session.totalTokens.inputTokens += usage.inputTokens;
  session.totalTokens.outputTokens += usage.outputTokens;
  session.totalTokens.cacheReadTokens =
    (session.totalTokens.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
  session.totalTokens.cacheCreationTokens =
    (session.totalTokens.cacheCreationTokens ?? 0) +
    (usage.cacheCreationTokens ?? 0);
  session.totalCost += estimateCost(
    session.provider,
    session.model,
    usage.inputTokens,
    usage.outputTokens,
  );
}

function extractText(message: ChatMessage): string {
  return message.content
    .filter(
      (
        content,
      ): content is Extract<ChatMessage["content"][number], { type: "text" }> =>
        content.type === "text",
    )
    .map((content) => content.text)
    .join("\n");
}
