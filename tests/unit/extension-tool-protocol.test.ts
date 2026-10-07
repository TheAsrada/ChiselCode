import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachExtensionTools,
  ExtensionHost,
} from "../../src/extensions/index.js";
import { AnthropicProtocolAdapter } from "../../src/providers/drivers/anthropic-messages.js";
import { OpenAIProtocolAdapter } from "../../src/providers/drivers/openai-chat.js";
import { ProviderToolNames } from "../../src/providers/tool-names.js";
import { ToolCatalog } from "../../src/tools/catalog.js";
import { fixtureTool, toolExtension } from "../fixtures/tool-extension.js";

for (const anthropic of [false, true])
  test(`${anthropic ? "Anthropic" : "OpenAI"} adapters roundtrip canonical extension names and resumed history`, async () => {
    const root = await mkdtemp(join(tmpdir(), "chisel-extension-wire-"));
    const owner = `Vendor/A${"x".repeat(120)}`;
    const host = new ExtensionHost([toolExtension(owner, [fixtureTool()])]);
    try {
      const scope = await host.open(root);
      const catalog = new ToolCatalog();
      await attachExtensionTools(scope, catalog);
      const tools = catalog.selectForTurn();
      const canonical = `ext:${owner}:inspect`;
      const wire = new ProviderToolNames(tools, []).wire(canonical);
      let body: Record<string, unknown> | undefined;
      const events: Record<string, unknown>[] = anthropic
        ? [
            {
              type: "message_start",
              message: {
                id: "m",
                type: "message",
                model: "mock",
                role: "assistant",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "new",
                name: wire,
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: "{}" },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ]
        : [
            {
              id: "m",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "new",
                        type: "function",
                        function: { name: wire, arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ];
      const data =
        events
          .map(
            (event) =>
              `${anthropic ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
          )
          .join("") + (anthropic ? "" : "data: [DONE]\n\n");
      const options = {
        apiKey: "fixture",
        baseUrl: "https://offline.test",
        maxRetries: 0,
        fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
          body = JSON.parse(String(init?.body));
          return new Response(data, {
            headers: { "Content-Type": "text/event-stream" },
          });
        },
      };
      const provider = anthropic
        ? new AnthropicProtocolAdapter(options)
        : new OpenAIProtocolAdapter(options);
      let returned = "";
      for await (const event of provider.streamChat({
        model: "mock",
        system: "Core",
        maxTokens: 512,
        tools,
        messages: [
          { role: "user", content: [{ type: "text", text: "Inspect" }] },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "old", name: canonical, input: {} },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "old",
                content: "Already inspected",
              },
            ],
          },
        ],
      })) {
        if (event.type === "error")
          throw new Error(`${event.code}: ${event.message}`);
        if (event.type === "turn_complete")
          returned =
            event.message.content.find((block) => block.type === "tool_use")
              ?.name ?? "";
      }
      expect(returned).toBe(canonical);
      expect(JSON.stringify(body)).not.toContain(canonical);
      expect(JSON.stringify(body)).toContain(wire);
      expect(JSON.stringify(body)).toContain("Already inspected");
    } finally {
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
