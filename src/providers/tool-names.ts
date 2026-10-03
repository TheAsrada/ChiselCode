import { createHash } from "node:crypto";
import type { ChatMessage, ToolDefinition } from "../types/domain.js";

/** Provider APIs restrict names to 64 ASCII characters; domain/session names stay namespaced. */
export class ProviderToolNames {
  private forward = new Map<string, string>();
  private reverse = new Map<string, string>();
  constructor(tools: ToolDefinition[], messages: ChatMessage[]) {
    const names = new Set([
      ...tools.map((tool) => tool.name),
      ...messages.flatMap((message) =>
        message.content.flatMap((block) =>
          block.type === "tool_use" ? [block.name] : [],
        ),
      ),
    ]);
    for (const name of names) {
      const wire = /^[a-zA-Z0-9_-]{1,64}$/.test(name)
        ? name
        : `mcp_${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
      if (this.reverse.has(wire) && this.reverse.get(wire) !== name)
        throw new Error("Provider tool alias collision.");
      this.forward.set(name, wire);
      this.reverse.set(wire, name);
    }
  }
  wire(name: string): string {
    return this.forward.get(name) ?? name;
  }
  domain(name: string): string {
    return this.reverse.get(name) ?? name;
  }
  tools(tools: ToolDefinition[]): ToolDefinition[] {
    return tools.map((tool) => ({ ...tool, name: this.wire(tool.name) }));
  }
  messages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => ({
      ...message,
      content: message.content.map((block) =>
        block.type === "tool_use"
          ? { ...block, name: this.wire(block.name) }
          : block,
      ),
    }));
  }
}
