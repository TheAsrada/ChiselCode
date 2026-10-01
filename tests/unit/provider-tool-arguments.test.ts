import { expect, test } from "bun:test";
import { AnthropicProtocolAdapter } from "../../src/providers/drivers/anthropic-messages.js";
import { OpenAIProtocolAdapter } from "../../src/providers/drivers/openai-chat.js";
import {
  LocalToolProvider,
  SkillsToolProvider,
} from "../../src/tools/local/provider.js";
import type { ProviderAdapter, StreamEvent } from "../../src/types/domain.js";

function response(
  anthropic: boolean,
  argumentsJson: string[],
  reason?: string,
  name = "write_file",
  duplicateId = false,
) {
  const records: unknown[] = [];
  if (anthropic) {
    records.push({
      type: "message_start",
      message: {
        id: "msg",
        type: "message",
        role: "assistant",
        model: "mock",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    for (const [index, json] of argumentsJson.entries()) {
      records.push({
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: duplicateId ? "same" : `call-${index}`,
          name,
          input: {},
        },
      });
      for (let start = 0; start < json.length; start += 13)
        records.push({
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: json.slice(start, start + 13),
          },
        });
      records.push({ type: "content_block_stop", index });
    }
    records.push(
      {
        type: "message_delta",
        delta: { stop_reason: reason ?? "tool_use", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    );
  } else {
    for (
      let start = 0;
      start < Math.max(1, ...argumentsJson.map((json) => json.length));
      start += 13
    ) {
      records.push({
        id: "msg",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: argumentsJson.map((json, index) => ({
                index,
                ...(start === 0
                  ? {
                      id: duplicateId ? "same" : `call-${index}`,
                      type: "function",
                    }
                  : {}),
                function: { name, arguments: json.slice(start, start + 13) },
              })),
            },
            finish_reason: null,
          },
        ],
      });
    }
    if (reason !== "disconnect")
      records.push({
        id: "msg",
        choices: [
          { index: 0, delta: {}, finish_reason: reason ?? "tool_calls" },
        ],
      });
  }
  const bytes = new TextEncoder().encode(
    records
      .map(
        (record) =>
          `${anthropic ? `event: ${(record as { type: string }).type}\n` : ""}data: ${JSON.stringify(record)}\n\n`,
      )
      .join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        // Network chunks can split both SSE records and multibyte UTF-8 characters.
        for (let offset = 0; offset < bytes.length; offset += 31)
          controller.enqueue(bytes.slice(offset, offset + 31));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function adapter(anthropic: boolean, reply: () => Response): ProviderAdapter {
  const options = {
    apiKey: "test",
    baseUrl: "https://provider.test",
    maxRetries: 0,
    fetch: async () => reply(),
  };
  return anthropic
    ? new AnthropicProtocolAdapter(options)
    : new OpenAIProtocolAdapter(options);
}
async function collect(provider: ProviderAdapter) {
  const events: StreamEvent[] = [];
  for await (const event of provider.streamChat({
    model: "mock",
    system: "system",
    messages: [],
    tools: [],
    maxTokens: 4096,
  }))
    events.push(event);
  return events;
}
for (const anthropic of [false, true]) {
  const protocol = anthropic ? "Anthropic" : "OpenAI";
  test(`${protocol}: all registered tool names preserve fragmented argument strings`, async () => {
    const specs = [
      ...(await new LocalToolProvider().listTools()),
      ...(await new SkillsToolProvider([]).listTools()),
    ];
    const input = { sample: 'quote " and slash \\ and newline\nПривет' };
    for (const spec of specs) {
      const events = await collect(
        adapter(anthropic, () =>
          response(anthropic, [JSON.stringify(input)], undefined, spec.name),
        ),
      );
      expect(events).toContainEqual({
        type: "tool_call",
        call: { id: "call-0", name: spec.name, input },
      });
    }
  });
  test(`${protocol}: fragmented HTML/code strings round-trip exactly`, async () => {
    const content =
      '<script>\nconst x = "Привет 👩‍💻";\nconst path = "C:\\\\tmp";\n</script>\n'.repeat(
        300,
      );
    const input = { path: "салют.html", content };
    const events = await collect(
      adapter(anthropic, () => response(anthropic, [JSON.stringify(input)])),
    );
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", call: { id: "call-0", name: "write_file", input } },
    ]);
    expect(events.at(-1)?.type).toBe("turn_complete");
  });
  test(`${protocol}: output limit is detected before partial arguments are parsed`, async () => {
    const events = await collect(
      adapter(anthropic, () =>
        response(
          anthropic,
          ['{"path":"file.html","content":"unfinished'],
          anthropic ? "max_tokens" : "length",
        ),
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "output_truncated",
    });
    expect(
      events.some(
        (event) => event.type === "tool_call" || event.type === "turn_complete",
      ),
    ).toBe(false);
  });
  for (const json of ['{"content":"bad\nstring"}', "[]", "null", "123"])
    test(`${protocol}: invalid object ${JSON.stringify(json)} rejects the whole batch`, async () => {
      const events = await collect(
        adapter(anthropic, () =>
          response(anthropic, ['{"path":"safe","content":"complete"}', json]),
        ),
      );
      expect(events.at(-1)).toMatchObject({
        type: "error",
        code: "invalid_tool_arguments",
      });
      expect(
        events.some(
          (event) =>
            event.type === "tool_call" || event.type === "turn_complete",
        ),
      ).toBe(false);
    });
  test(`${protocol}: duplicate IDs never reach tool execution`, async () => {
    const events = await collect(
      adapter(anthropic, () =>
        response(anthropic, ["{}", "{}"], undefined, "git_status", true),
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", code: "transport" });
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
  });
  test(`${protocol}: empty arguments are an object for argument-free tools`, async () => {
    const events = await collect(
      adapter(anthropic, () =>
        response(anthropic, [""], undefined, "git_status"),
      ),
    );
    expect(events).toContainEqual({
      type: "tool_call",
      call: { id: "call-0", name: "git_status", input: {} },
    });
  });
}
test("OpenAI: disconnect is a transport error, never a malformed-JSON retry", async () => {
  const events = await collect(
    adapter(false, () =>
      response(false, ['{"path":"unfinished'], "disconnect"),
    ),
  );
  expect(events.at(-1)).toMatchObject({ type: "error", code: "transport" });
  expect(events.some((event) => event.type === "tool_call")).toBe(false);
});
