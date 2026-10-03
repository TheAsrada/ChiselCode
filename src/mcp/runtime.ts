import { z } from "zod";
import type { ToolCatalog } from "../tools/catalog.js";
import { defineTool } from "../tools/handler.js";
import type { McpConnectionManager } from "./manager.js";
import { McpToolProvider } from "./provider.js";

/** Attaches normal providers and a bounded schema-discovery path to a turn. */
export class McpRuntimeBinding {
  private providers = new Set<string>();
  private dirty = true;
  private refreshing?: Promise<void>;
  private readonly detach: () => void;
  constructor(
    readonly manager: McpConnectionManager,
    readonly catalog: ToolCatalog,
  ) {
    this.detach = manager.subscribe(() => {
      this.dirty = true;
    });
    catalog.register(
      defineTool(
        {
          name: "discover_mcp_tools",
          description:
            "Find additional MCP tools by server or keyword. Select returned names in tools to expose their schemas on the next turn. Read-only discovery; permissions and Plan restrictions still apply. Use this when relevant external tools are not in the current subset.",
          effect: "read",
          permission: "read",
          parallelSafe: true,
          outputPolicy: { maxInlineTokens: 2000 },
        },
        z.object({
          server: z.string().optional(),
          query: z.string().max(200).optional(),
          tools: z.array(z.string().min(1).max(128)).max(12).default([]),
        }),
        async (_context, input) => ({
          data: input,
          preview: "MCP tool discovery",
          resources: [],
        }),
        async (_context, { data }) => {
          await this.refresh();
          const allowed = catalog
            .specs()
            .filter((spec) => spec.source?.type === "mcp");
          const words = (data.query ?? "")
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
          const tools = allowed.filter(
            (spec) =>
              spec.source?.type === "mcp" &&
              (!data.server || spec.source.serverId === data.server) &&
              (!words.length ||
                words.some((word) =>
                  `${spec.name} ${spec.description}`
                    .toLowerCase()
                    .includes(word),
                )),
          );
          catalog.include(
            data.tools.filter((name) =>
              allowed.some((spec) => spec.name === name),
            ),
          );
          // Top matches are included automatically, so a single discovery call is enough.
          catalog.include(tools.slice(0, 12).map((spec) => spec.name));
          return {
            output: JSON.stringify(
              {
                servers: manager.list().map((server) => ({
                  id: server.id,
                  state: server.state,
                  tools: server.toolsCount,
                  trustRequired: !server.trusted,
                })),
                tools: tools.slice(0, 40).map((spec) => ({
                  name: spec.name,
                  description: spec.description.slice(0, 300),
                  effect: spec.effect,
                })),
                remaining: Math.max(0, tools.length - 40),
              },
              null,
              2,
            ),
          };
        },
      ),
    );
  }
  async refresh(signal?: AbortSignal): Promise<void> {
    await this.manager.startEnabled(signal);
    if (!this.dirty) return;
    if (this.refreshing) return this.refreshing;
    this.dirty = false;
    const task = (async () => {
      const active = this.manager
        .list()
        .filter((status) => status.state === "connected");
      for (const id of this.providers)
        if (!active.some((server) => server.id === id)) {
          await this.catalog.replaceProvider(`mcp:${id}`);
          this.providers.delete(id);
        }
      for (const server of active) {
        await this.catalog.replaceProvider(
          `mcp:${server.id}`,
          new McpToolProvider(this.manager, server.id),
        );
        this.providers.add(server.id);
      }
    })();
    this.refreshing = task;
    try {
      await task;
    } finally {
      if (this.refreshing === task) this.refreshing = undefined;
    }
  }
  dispose(): void {
    this.detach();
  }
}
