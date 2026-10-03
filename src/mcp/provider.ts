import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { RuntimeError } from "../runtime/errors.js";
import { isReadEffect } from "../tools/effects.js";
import type {
  ToolHandler,
  ToolProvider,
  ToolSource,
  ToolSpec,
} from "../tools/types.js";
import type { JsonObject } from "../types/domain.js";
import type { McpConnectionManager, McpToolInfo } from "./manager.js";
import { formatMcpPreview, mcpApprovalPreview } from "./preview.js";
import { normalizeMcpResult } from "./result.js";

/** Exactly one server is represented by each provider. */
export class McpToolProvider implements ToolProvider {
  private handlers = new Map<string, ToolHandler>();
  constructor(
    readonly manager: McpConnectionManager,
    readonly serverId: string,
  ) {}
  async listTools(): Promise<ToolSpec[]> {
    this.refresh();
    return [...this.handlers.values()].map((handler) => handler.spec);
  }
  async getHandler(name: string): Promise<ToolHandler> {
    const handler = this.handlers.get(name);
    if (!handler)
      throw new RuntimeError(
        "MCP_TOOL_NOT_FOUND",
        "Инструмент MCP недоступен.",
      );
    return handler;
  }
  private refresh(): void {
    const handlers = new Map<string, ToolHandler>();
    for (const info of this.manager.tools(this.serverId)) {
      if (
        Buffer.byteLength(JSON.stringify(info.tool.inputSchema)) >
        64 * 1024
      ) {
        this.manager.report(
          this.serverId,
          "warn",
          `JSON schema превышает 64 KiB: ${info.tool.name}. Инструмент недоступен агенту.`,
        );
        continue;
      }
      try {
        const handler = this.handler(info);
        handlers.set(handler.spec.name, handler);
      } catch {
        this.manager.report(
          this.serverId,
          "warn",
          `Неподдерживаемая JSON schema: ${info.tool.name}. Инструмент недоступен агенту.`,
        );
      }
    }
    this.handlers = handlers;
  }
  private handler(info: McpToolInfo): ToolHandler {
    const { tool, classification, fingerprint } = info;
    const entry = this.manager.entry(this.serverId);
    const source: Extract<ToolSource, { type: "mcp" }> = {
      type: "mcp",
      serverId: this.serverId,
      serverTitle: entry.config.label ?? this.serverId,
      originalName: tool.name,
      title: tool.title,
      annotations: tool.annotations,
      category: classification.category,
      classificationReason: classification.reason,
    };
    const validate = new AjvJsonSchemaValidator().getValidator(
      tool.inputSchema as JsonSchemaType,
    );
    const spec: ToolSpec = {
      name: `${this.serverId}.${tool.name}`,
      description: `${source.serverTitle}: ${(tool.description ?? tool.title ?? tool.name).slice(0, 1500)} [${classification.category}]`,
      inputSchema: tool.inputSchema,
      effect: classification.effect,
      source,
      permission: `mcp:${this.serverId}:${tool.name}`,
      parallelSafe: isReadEffect(classification.effect),
      timeoutMs: entry.config.callTimeoutMs,
      outputPolicy: { maxInlineTokens: 2000 },
      pinned: entry.config.pinnedTools.includes(tool.name),
      workspaceAccess:
        entry.config.transport.type === "stdio"
          ? isReadEffect(classification.effect)
            ? "read"
            : "write"
          : "none",
    };
    return {
      spec,
      permissions: () => this.manager.entry(this.serverId).permissions,
      rememberApproval: () =>
        this.manager.rememberTool(this.serverId, tool.name, fingerprint),
      parse: (input: JsonObject) => {
        if (!validate(input).valid)
          throw new RuntimeError(
            "INVALID_TOOL_INPUT",
            `MCP input does not match the schema of ${spec.name}. Check required fields and value types.`,
          );
        return structuredClone(input);
      },
      prepare: async (_context, input) => {
        const preview = mcpApprovalPreview(
          source,
          spec.effect,
          input as JsonObject,
          this.manager.redactor,
        );
        return {
          data: input,
          preview: formatMcpPreview(preview),
          resources: [],
          approval: preview,
        };
      },
      execute: async (context, plan) => {
        let lastProgress = 0;
        const result = await this.manager.invoke(
          this.serverId,
          tool.name,
          fingerprint,
          plan.data as JsonObject,
          context.signal,
          (progress) => {
            if (
              performance.now() - lastProgress < 150 &&
              progress.total !== progress.progress
            )
              return;
            lastProgress = performance.now();
            void context.events
              .emit({
                type: "tool_progress",
                name: spec.name,
                text: progress.message,
                progress: progress.progress,
                total: progress.total,
              })
              .catch(() => {});
          },
        );
        return normalizeMcpResult(result, this.manager.redactor, {
          server: source.serverTitle,
          tool: source.title ?? tool.name,
        });
      },
    };
  }
}
