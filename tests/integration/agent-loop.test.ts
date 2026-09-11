import { describe, expect, test } from "bun:test";
import { AgentLoop } from "../../src/core/agent-loop.js";
import { createSession } from "../../src/sessions/store.js";
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
});
