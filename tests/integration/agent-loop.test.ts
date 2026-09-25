import { describe, expect, test } from "bun:test";
import { AgentLoop } from "../../src/core/agent-loop.js";
import { createSession } from "../../src/sessions/store.js";
import { buildFileDiff } from "../../src/tools/file-diff.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
  ToolDefinition,
} from "../../src/types/domain.js";

class MockProvider implements ProviderAdapter {
  readonly kind = "anthropic" as const;
  private turn = 0;

  async *streamChat(_request: ProviderRequest): AsyncIterable<StreamEvent> {
    this.turn += 1;
    if (this.turn === 1) {
      yield {
        type: "tool_call",
        call: { id: "call-1", name: "read_file", input: { path: "README.md" } },
      };
      yield {
        type: "turn_complete",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "read_file",
              input: { path: "README.md" },
            },
          ],
        },
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      return;
    }
    yield { type: "text_delta", text: "Done" };
    yield {
      type: "turn_complete",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }

  async listModels() {
    return [];
  }
  async countTokens() {
    return 0;
  }
}

describe("AgentLoop", () => {
  test("checkpoints only complete conversation stages", async () => {
    const snapshots: number[] = [];
    const tools = {
      getDefinitions: () => [],
      execute: async () => ({ output: "content" }),
    };
    const result = await new AgentLoop(
      new MockProvider(),
      tools as never,
      "system",
    ).run(createSession("/project", "anthropic", "test"), "Inspect", {
      onCheckpoint: async (session) => {
        snapshots.push(session.messages.length);
      },
    });
    expect(result.status).toBe("completed");
    expect(snapshots).toEqual([1, 3, 4]);
  });
  test("keeps applied UI diffs in the session but never in provider messages", async () => {
    const requests: ProviderRequest[] = [];
    const diff = buildFileDiff("new.ts", null, "hello\n");
    const provider: ProviderAdapter = {
      kind: "openai-compatible",
      async *streamChat(request) {
        requests.push(structuredClone(request));
        yield {
          type: "turn_complete",
          message:
            requests.length === 1
              ? {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: "write-1",
                      name: "write_file",
                      input: { path: "new.ts", content: "hello\n" },
                    },
                  ],
                }
              : {
                  role: "assistant",
                  content: [{ type: "text", text: "Done" }],
                },
          stopReason: requests.length === 1 ? "tool_use" : "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async listModels() {
        return [];
      },
      async countTokens() {
        return 0;
      },
    };
    const tools = {
      getDefinitions: () => [],
      execute: async () => ({ output: "Wrote new.ts.", fileDiff: diff }),
    };
    const result = await new AgentLoop(provider, tools as never, "system").run(
      createSession("/project", "openai-compatible", "test"),
      "write",
    );
    expect(result.status).toBe("completed");
    expect(result.session.fileDiffs?.["write-1"]).toBe(diff);
    expect(requests[1]?.messages.at(-1)?.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "write-1",
        content: "Wrote new.ts.",
        isError: undefined,
      },
    ]);
    expect(JSON.stringify(requests)).not.toContain('"fileDiff');
    expect(JSON.stringify(requests)).not.toContain(diff.patch);
  });
  test("feeds tool results back into the provider until completion", async () => {
    const tools = {
      getDefinitions: (): ToolDefinition[] => [],
      async execute() {
        return { output: "README content" };
      },
    };
    const loop = new AgentLoop(new MockProvider(), tools as never, "system");
    const result = await loop.run(
      createSession("/project", "anthropic", "test"),
      "Inspect the README",
    );
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Done");
    expect(result.session.messages).toHaveLength(4);
  });

  test("asks once more when a provider returns an empty completed turn", async () => {
    let requests = 0;
    const provider: ProviderAdapter = {
      kind: "openai-compatible",
      async *streamChat() {
        requests += 1;
        if (requests === 1) {
          yield {
            type: "turn_complete",
            message: { role: "assistant", content: [] },
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        yield { type: "text_delta", text: "Здравствуйте!" };
        yield {
          type: "turn_complete",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Здравствуйте!" }],
          },
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      async listModels() {
        return [];
      },
      async countTokens() {
        return 0;
      },
    };
    const tools = { getDefinitions: (): ToolDefinition[] => [] };
    const result = await new AgentLoop(provider, tools as never, "system").run(
      createSession("/project", "openai-compatible", "test"),
      "Привет",
    );
    expect(requests).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Здравствуйте!");
  });
});
