import { describe, expect, test } from "bun:test";
import { AnthropicCompatibleAdapter } from "../../src/providers/anthropic.js";
import type { ProviderRequest } from "../../src/types/domain.js";

const request: ProviderRequest = {
  model: "test-model",
  system: "Test system prompt",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
  maxTokens: 32,
};

function sse(): Response {
  const events = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "test-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ] as const;
  const text = events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
  return new Response(text, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("AnthropicCompatibleAdapter", () => {
  test("uses the Messages API with Bearer authentication", async () => {
    let captured: Request | undefined;
    const adapter = new AnthropicCompatibleAdapter({
      authToken: "test-token",
      baseUrl: "https://proxy.example.test",
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return sse();
      },
    });

    const events = [];
    for await (const event of adapter.streamChat(request)) events.push(event);

    expect(adapter.kind).toBe("anthropic-compatible");
    expect(captured?.url).toBe("https://proxy.example.test/v1/messages");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.get("authorization")).toBe("Bearer test-token");
    expect(captured?.headers.get("x-api-key")).toBeNull();
    expect(events).toContainEqual({ type: "text_delta", text: "Hi" });
  });

  test("requires a proxy base URL", () => {
    expect(
      () => new AnthropicCompatibleAdapter({ authToken: "test-token" }),
    ).toThrow("Anthropic-compatible providers require baseUrl.");
  });
});
