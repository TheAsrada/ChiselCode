import { describe, expect, test } from "bun:test";
import { AnthropicAdapter } from "../../src/providers/anthropic.js";
import { OpenAIAdapter } from "../../src/providers/openai.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "../../src/types/domain.js";

const request: ProviderRequest = {
  model: "mock",
  system: "system",
  messages: [{ role: "user", content: [{ type: "text", text: "task" }] }],
  tools: [],
  maxTokens: 123,
};
function stream(
  anthropic: boolean,
  tools = false,
  malformed = false,
  refusal = false,
) {
  const events: Record<string, unknown>[] = [];
  if (anthropic) {
    events.push({
      type: "message_start",
      message: {
        id: "msg",
        type: "message",
        role: "assistant",
        model: "mock",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 0 },
      },
    });
    for (let index = 0; index < (tools ? 2 : 1); index++) {
      events.push({
        type: "content_block_start",
        index,
        content_block: tools
          ? {
              type: "tool_use",
              id: `call-${index}`,
              name: "read_file",
              input: {},
            }
          : { type: "text", text: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: tools
          ? {
              type: "input_json_delta",
              partial_json: malformed
                ? "{"
                : JSON.stringify({ path: `${index}.txt` }),
            }
          : { type: "text_delta", text: "Hello" },
      });
      events.push({ type: "content_block_stop", index });
    }
    events.push(
      {
        type: "message_delta",
        delta: {
          stop_reason: refusal ? "refusal" : tools ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    );
  } else {
    events.push({
      id: "msg",
      choices: [
        {
          index: 0,
          delta: tools
            ? {
                tool_calls: [0, 1].map((index) => ({
                  index,
                  id: `call-${index}`,
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: malformed
                      ? "{"
                      : JSON.stringify({ path: `${index}.txt` }),
                  },
                })),
              }
            : refusal
              ? { refusal: "Refused" }
              : { content: "Hello" },
          finish_reason: null,
        },
      ],
    });
    events.push({
      id: "msg",
      choices: [
        { index: 0, delta: {}, finish_reason: tools ? "tool_calls" : "stop" },
      ],
    });
    events.push({
      id: "msg",
      choices: [],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
    });
  }
  return new Response(
    events
      .map(
        (event) =>
          `${anthropic ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function collect(adapter: ProviderAdapter, signal?: AbortSignal) {
  const events: StreamEvent[] = [];
  for await (const event of adapter.streamChat({ ...request, signal }))
    events.push(event);
  return events;
}
for (const kind of [
  "anthropic",
  "anthropic-compatible",
  "openai",
  "openai-compatible",
  "agentrouter",
] as const) {
  describe(`${kind} provider contract`, () => {
    const anthropic = kind.startsWith("anthropic");
    function adapter(response: () => Response) {
      const options = {
        apiKey: "test",
        baseUrl: "https://provider.test",
        maxRetries: 0,
        fetch: async () => response(),
      };
      return anthropic
        ? new AnthropicAdapter({
            ...options,
            kind: kind as "anthropic" | "anthropic-compatible",
          })
        : new OpenAIAdapter({
            ...options,
            kind: kind as "openai" | "openai-compatible" | "agentrouter",
          });
    }
    test("normal text, usage and output limit", async () => {
      let maxOutput: unknown;
      const fetcher = async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        maxOutput = body.max_tokens ?? body.max_completion_tokens;
        return stream(anthropic);
      };
      const options = {
        apiKey: "test",
        baseUrl: "https://provider.test",
        maxRetries: 0,
        fetch: fetcher,
      };
      const provider = anthropic
        ? new AnthropicAdapter({
            ...options,
            kind: kind as "anthropic" | "anthropic-compatible",
          })
        : new OpenAIAdapter({
            ...options,
            kind: kind as "openai" | "openai-compatible" | "agentrouter",
          });
      const events = await collect(provider);
      expect(maxOutput).toBe(123);
      expect(events).toContainEqual({ type: "text_delta", text: "Hello" });
      const completed = events.find((event) => event.type === "turn_complete");
      expect(
        completed?.type === "turn_complete" && completed.usage,
      ).toMatchObject({ inputTokens: 9, outputTokens: 3 });
      expect(
        events.filter((event) => event.type === "turn_complete"),
      ).toHaveLength(1);
    });
    test("multiple calls preserve IDs, JSON arguments and order", async () => {
      const events = await collect(adapter(() => stream(anthropic, true)));
      expect(
        events
          .filter((event) => event.type === "tool_call")
          .map((event) => event.type === "tool_call" && event.call),
      ).toEqual(
        [0, 1].map((index) => ({
          id: `call-${index}`,
          name: "read_file",
          input: { path: `${index}.txt` },
        })),
      );
    });
    test("malformed tool JSON is an error rather than a successful turn", async () => {
      const events = await collect(
        adapter(() => stream(anthropic, true, true)),
      );
      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(events.some((event) => event.type === "turn_complete")).toBe(
        false,
      );
    });
    test("refusal survives the terminal marker", async () => {
      const events = await collect(
        adapter(() => stream(anthropic, false, false, true)),
      );
      expect(
        events.find((event) => event.type === "turn_complete"),
      ).toMatchObject({ stopReason: "refusal" });
    });
    test("context overflow is typed", async () => {
      const events = await collect(
        adapter(
          () =>
            new Response(
              JSON.stringify({
                error: {
                  type: "invalid_request_error",
                  message: "context length exceeded; prompt too long",
                  code: "context_length_exceeded",
                },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            ),
        ),
      );
      expect(events.find((event) => event.type === "error")).toMatchObject({
        code: "context_overflow",
      });
    });
    test("cancellation stops a provider request", async () => {
      const abort = new AbortController();
      abort.abort();
      expect(
        (
          await collect(
            adapter(() => stream(anthropic)),
            abort.signal,
          )
        ).find((event) => event.type === "error"),
      ).toMatchObject({ code: "cancelled" });
    });
  });
}
