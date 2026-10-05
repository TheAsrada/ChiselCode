import { ContextManager } from "../context/context-manager.js";
import { modelSummarizer } from "../context/model-summary.js";
import { AgentRuntime, type RuntimeOptions } from "../runtime/agent-runtime.js";
import { type RuntimeEvent, RuntimeEventBus } from "../runtime/events.js";
import type { ToolRegistry } from "../tools/registry.js";
import type {
  ProviderAdapter,
  Session,
  ToolExecutionResult,
} from "../types/domain.js";

export interface AgentEventHandlers {
  onEvent?(event: RuntimeEvent): void;
  onText?(text: string): void;
  onThinking?(text: string): void;
  onToolStart?(
    name: string,
    input: Record<string, unknown>,
    source?: import("../tools/types.js").ToolSource,
  ): void;
  onToolResult?(name: string, result: ToolExecutionResult): void;
}
export type AgentLoopOptions = RuntimeOptions;
/** Legacy API adapter. The application uses AgentRuntime directly. */
export class AgentLoop {
  constructor(
    private readonly provider: ProviderAdapter,
    private readonly tools: ToolRegistry,
    private readonly system: string,
    private readonly handlers: AgentEventHandlers = {},
  ) {}
  async run(session: Session, prompt: string, options: RuntimeOptions = {}) {
    const events = new RuntimeEventBus(session.id);
    const detach = events.subscribe((event) => {
      this.handlers.onEvent?.(event);
      if (event.type === "provider_text_delta")
        this.handlers.onText?.(event.text ?? "");
      if (event.type === "provider_thinking_delta")
        this.handlers.onThinking?.(event.text ?? "");
      if (event.type === "tool_started")
        this.handlers.onToolStart?.(
          event.name ?? "",
          event.input ?? {},
          event.toolSource,
        );
      if (
        (event.type === "tool_completed" || event.type === "tool_failed") &&
        event.result
      )
        this.handlers.onToolResult?.(event.name ?? "", event.result);
    });
    const local = this.tools.runtime;
    if (local) {
      local.context.events = events;
      local.context.signal = options.signal;
      local.context.checkpoint = () =>
        options.onCheckpoint?.(session) ?? Promise.resolve();
    }
    const runtime = new AgentRuntime(
      this.provider,
      new ContextManager({}, events, undefined, modelSummarizer),
      {
        getApprovalMode: local?.getApprovalMode,
        instructionsForTurn: local
          ? (selected) => local.catalog.instructionsForTurn(selected)
          : undefined,
        selectForTurn: () => this.tools.getDefinitions(),
        execute: async (calls, signal) => {
          if (local) return local.scheduler.execute(calls, signal);
          const results: ToolExecutionResult[] = [];
          for (const call of calls) {
            await events.emit({
              type: "tool_started",
              name: call.name,
              input: call.input,
              invocationId: call.id,
            });
            const result = await this.tools.execute(call.name, call.input);
            results.push(result);
            await events.emit({
              type: "tool_completed",
              name: call.name,
              result,
              invocationId: call.id,
            });
            if (result.requiresApproval) break;
          }
          return results;
        },
      },
      this.system,
      events,
    );
    try {
      return await runtime.run(session, prompt, options);
    } finally {
      detach();
    }
  }
}
