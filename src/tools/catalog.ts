import {
  type AgentMode,
  allowsToolInMode,
  DEFAULT_AGENT_MODE,
} from "../runtime/agent-mode.js";
import { RuntimeError } from "../runtime/errors.js";
import type { ToolDefinition } from "../types/domain.js";
import { isReadEffect } from "./effects.js";
import type { ToolHandler, ToolProvider } from "./types.js";
export class ToolCatalog {
  constructor(
    private readonly getMode: () => AgentMode = () => DEFAULT_AGENT_MODE,
  ) {}
  private handlers = new Map<string, ToolHandler>();
  private providers = new Map<string, Set<string>>();
  private explicit = new Map<string, number>();
  private selectionSequence = 0;
  private retiredMcp = new Set<string>();
  register(handler: ToolHandler): void {
    if (this.handlers.has(handler.spec.name))
      throw new Error(`Duplicate tool registration: ${handler.spec.name}`);
    this.handlers.set(handler.spec.name, handler);
    handler.spec.source ??= { type: "local" };
  }
  async addProvider(provider: ToolProvider): Promise<void> {
    for (const spec of await provider.listTools())
      this.register(await provider.getHandler(spec.name));
  }
  /** Publish a complete provider snapshot atomically; executing handlers retain theirs. */
  async replaceProvider(id: string, provider?: ToolProvider): Promise<void> {
    const snapshot: ToolHandler[] = [];
    if (provider)
      for (const spec of await provider.listTools())
        snapshot.push(await provider.getHandler(spec.name));
    const old = this.providers.get(id) ?? new Set<string>();
    for (const handler of snapshot)
      if (this.handlers.has(handler.spec.name) && !old.has(handler.spec.name))
        throw new Error(`Duplicate tool registration: ${handler.spec.name}`);
    for (const name of old) {
      if (this.handlers.get(name)?.spec.source?.type === "mcp")
        this.retiredMcp.add(name);
      this.handlers.delete(name);
      if (!snapshot.some((handler) => handler.spec.name === name))
        this.explicit.delete(name);
    }
    for (const handler of snapshot) {
      this.handlers.set(handler.spec.name, handler);
      this.retiredMcp.delete(handler.spec.name);
    }
    while (this.retiredMcp.size > 2000)
      this.retiredMcp.delete(this.retiredMcp.values().next().value as string);
    this.providers.set(
      id,
      new Set(snapshot.map((handler) => handler.spec.name)),
    );
  }
  include(names: string[]): void {
    for (const name of names)
      if (this.handlers.has(name))
        this.explicit.set(name, ++this.selectionSequence);
  }
  specs() {
    return [...this.handlers.values()].map((handler) => handler.spec);
  }
  get(name: string): ToolHandler {
    const handler = this.handlers.get(name);
    if (!handler)
      throw new RuntimeError(
        this.retiredMcp.has(name) ? "MCP_TOOL_NOT_FOUND" : "INVALID_TOOL_INPUT",
        `Unknown tool: ${name}`,
      );
    return handler;
  }
  selectForTurn(input?: {
    prompt?: string;
    recentTools?: string[];
  }): ToolDefinition[] {
    const permitted = [...this.handlers.values()].filter(({ spec }) =>
      allowsToolInMode(this.getMode(), spec.effect),
    );
    const local = permitted.filter(({ spec }) => spec.source?.type !== "mcp");
    const mcp = permitted.filter(({ spec }) => spec.source?.type === "mcp");
    const words = [
      ...new Set(
        (input?.prompt ?? "").toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [],
      ),
    ];
    const mentioned = new Set(
      (input?.prompt ?? "").match(
        /\b[a-z][a-z0-9_-]{0,31}\.[A-Za-z0-9_.:-]+\b/g,
      ) ?? [],
    );
    const score = (handler: ToolHandler) => {
      const { spec } = handler;
      const description = `${spec.name} ${spec.description}`.toLowerCase();
      return (
        (mentioned.has(spec.name)
          ? 10000 + this.selectionSequence
          : this.explicit.has(spec.name)
            ? 5000 + (this.explicit.get(spec.name) ?? 0)
            : spec.pinned
              ? 3000
              : input?.recentTools?.includes(spec.name)
                ? 2000
                : 0) +
        Math.min(
          500,
          words.reduce(
            (total, word) => total + (description.includes(word) ? 1 : 0),
            0,
          ),
        )
      );
    };
    const ranked = mcp
      .map((handler, index) => ({ handler, score: score(handler), index }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const selected = (
      mcp.length <= 16
        ? ranked
        : ranked
            .filter((item, index) => item.score > 0 || index < 4)
            .slice(0, 32)
    ).map((item) => item.handler);
    let schemaBytes = 0;
    const bounded = selected.filter(({ spec }) => {
      const bytes = Buffer.byteLength(
        JSON.stringify({
          name: spec.name,
          description: spec.description,
          inputSchema: spec.inputSchema,
        }),
      );
      if (schemaBytes + bytes > 96 * 1024) return false;
      schemaBytes += bytes;
      return true;
    });
    return [...local, ...bounded].map(({ spec }) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      requiresApproval:
        !isReadEffect(spec.effect) ||
        spec.source?.type === "mcp" ||
        spec.permission === "network",
    }));
  }
}
