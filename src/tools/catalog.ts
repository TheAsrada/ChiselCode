import {
  type AgentMode,
  allowsToolInMode,
  DEFAULT_AGENT_MODE,
} from "../runtime/agent-mode.js";
import { RuntimeError } from "../runtime/errors.js";
import type { ToolDefinition } from "../types/domain.js";
import type { ToolHandler, ToolProvider } from "./types.js";
export class ToolCatalog {
  constructor(
    private readonly getMode: () => AgentMode = () => DEFAULT_AGENT_MODE,
  ) {}
  private handlers = new Map<string, ToolHandler>();
  register(handler: ToolHandler): void {
    if (this.handlers.has(handler.spec.name))
      throw new Error(`Duplicate tool registration: ${handler.spec.name}`);
    this.handlers.set(handler.spec.name, handler);
  }
  async addProvider(provider: ToolProvider): Promise<void> {
    for (const spec of await provider.listTools())
      this.register(await provider.getHandler(spec.name));
  }
  get(name: string): ToolHandler {
    const handler = this.handlers.get(name);
    if (!handler)
      throw new RuntimeError("INVALID_TOOL_INPUT", `Unknown tool: ${name}`);
    return handler;
  }
  selectForTurn(_input?: { prompt?: string }): ToolDefinition[] {
    return [...this.handlers.values()]
      .filter(({ spec }) => allowsToolInMode(this.getMode(), spec.effect))
      .map(({ spec }) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        requiresApproval: spec.effect !== "read",
      }));
  }
}
