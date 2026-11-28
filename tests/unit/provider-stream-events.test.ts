import { expect, test } from "bun:test";
import { AnthropicProtocolAdapter } from "../../src/providers/drivers/anthropic-messages.js";
import { OpenAIProtocolAdapter } from "../../src/providers/drivers/openai-chat.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { TurnRunner } from "../../src/runtime/turn-runner.js";
import { attachSessionRecorder } from "../../src/sessions/checkpoints.js";
import { createSession } from "../../src/sessions/store.js";
import type {
  ChatMessage,
  ProviderRequest,
  StreamEvent,
} from "../../src/types/domain.js";

const request: ProviderRequest = {
  model: "fixture",
  system: "system",
  messages: [],
  tools: [],
  maxTokens: 128,
};
const text = { choices: [{ index: 0, delta: { content: "Привет ✓" } }] };
const stop = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };

function response(records: unknown[], anthropic = false) {
  const data =
    records
      .map((record) => {
        const type =
          record && typeof record === "object" && "type" in record
            ? record.type
            : "message_start";
        return `${anthropic ? `event: ${type}\n` : ""}data: ${JSON.stringify(record)}\n\n`;
      })
      .join("") + (anthropic ? "" : "data: [DONE]\n\n");
  const bytes = new TextEncoder().encode(data);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7)
          controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function adapter(fetch: () => Promise<Response>, anthropic = false) {
  const options = {
    apiKey: "fixture",
    maxRetries: 0,
    fetch,
  };
  return anthropic
    ? new AnthropicProtocolAdapter(options)
    : new OpenAIProtocolAdapter(options);
}
async function collect(
  records: unknown[],
  anthropic = false,
  overrides: Partial<ProviderRequest> = {},
) {
  const provider = adapter(async () => response(records, anthropic), anthropic);
  const events: StreamEvent[] = [];
  for await (const event of provider.streamChat({ ...request, ...overrides }))
    events.push(event);
  return events;
}

test("OpenAI usage-only gateway event without choices preserves text and actual usage", async () => {
  const events = await collect([
    text,
    stop,
    { usage: { prompt_tokens: 19, completion_tokens: 7 } },
  ]);
  expect(events).toContainEqual({ type: "text_delta", text: "Привет ✓" });
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    type: "turn_complete",
    usage: { inputTokens: 19, outputTokens: 7 },
    usageObserved: true,
  });
});

const tool = {
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"example.txt"}',
            },
          },
        ],
      },
    },
  ],
};
function transportFailure(events: StreamEvent[], protocol: string) {
  expect(
    events.filter(
      (event) => event.type === "tool_call" || event.type === "turn_complete",
    ),
  ).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: "error", code: "transport" });
  const failure = events.at(-1);
  if (failure?.type !== "error") throw new Error("Missing stream error");
  expect(failure.message).toContain(protocol);
  expect(failure.message).not.toContain("private-fixture-value");
  expect(failure.message).not.toMatch(/undefined is not|TypeError/);
}

test("OpenAI empty choices, heartbeat, nullable terminal delta and partial usage remain compatible", async () => {
  const events = await collect([
    { type: "ping" },
    { choices: [], usage: null, future_metadata: true },
    {
      usage: { prompt_tokens: 19, prompt_tokens_details: { cached_tokens: 3 } },
    },
    text,
    { choices: [{ delta: null, finish_reason: "stop" }] },
    { choices: null, usage: { completion_tokens: 7 } },
  ]);
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    type: "turn_complete",
    message: { content: [{ type: "text", text: "Привет ✓" }] },
    usage: {
      inputTokens: 19,
      contextInputTokens: 19,
      outputTokens: 7,
      cacheReadTokens: 3,
    },
  });
});

for (const [name, invalid] of [
  ["null event", null],
  ["primitive event", 42],
  ["array event", []],
  ["unknown event", {}],
  ["null choices without usage", { choices: null }],
  ["object choices", { choices: {} }],
  ["null choice", { choices: [null] }],
  ["missing delta", { choices: [{}] }],
  ["scalar delta", { choices: [{ delta: 3 }] }],
  [
    "non-string content",
    { choices: [{ delta: { content: { value: "private-fixture-value" } } }] },
  ],
  ["non-string refusal", { choices: [{ delta: { refusal: [] } }] }],
  ["wrong role", { choices: [{ delta: { role: "user" } }] }],
  ["non-array tool calls", { choices: [{ delta: { tool_calls: {} } }] }],
  ["null tool fragment", { choices: [{ delta: { tool_calls: [null] } }] }],
  [
    "string tool index",
    { choices: [{ delta: { tool_calls: [{ index: "0" }] } }] },
  ],
  [
    "object tool arguments",
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: { value: "private-fixture-value" } },
              },
            ],
          },
        },
      ],
    },
  ],
  ["string usage", { usage: { prompt_tokens: "19" } }],
  ["negative usage", { usage: { prompt_tokens: -1 } }],
  ["fractional usage", { usage: { completion_tokens: 1.5 } }],
  [
    "invalid cache usage",
    { usage: { prompt_tokens_details: { cached_tokens: "3" } } },
  ],
  [
    "Responses API event",
    { type: "response.output_text.delta", delta: "private-fixture-value" },
  ],
  [
    "heartbeat containing output",
    { type: "ping", delta: "private-fixture-value" },
  ],
] as const) {
  test(`OpenAI ${name} fails before tool execution without leaking payload`, async () => {
    transportFailure(
      await collect([text, tool, invalid, stop]),
      "OpenAI Chat Completions",
    );
  });
}

test("a malformed later usage event keeps the last valid accounting", async () => {
  const events = await collect([
    { usage: { prompt_tokens: 19, completion_tokens: 7 } },
    text,
    { usage: { prompt_tokens: "private-fixture-value" } },
    stop,
  ]);
  transportFailure(events, "OpenAI Chat Completions");
  expect(events.at(-1)).toMatchObject({
    usage: { inputTokens: 19, outputTokens: 7 },
  });
});

for (const delta of [
  { content: "late" },
  { refusal: "late" },
  { reasoning_content: "late" },
  { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
]) {
  test(`OpenAI rejects ${Object.keys(delta)[0]} after terminal for ordinary and extension requests`, async () => {
    for (const overrides of [{}, { purpose: "extension_request" as const }]) {
      const events = await collect(
        [tool, stop, { choices: [{ delta }] }],
        false,
        overrides,
      );
      expect(events.at(-1)).toMatchObject({ type: "error", code: "transport" });
      expect(
        events.some(
          (event) =>
            event.type === "tool_call" || event.type === "turn_complete",
        ),
      ).toBe(false);
    }
  });
}

const start = {
  type: "message_start",
  message: { role: "assistant", usage: { input_tokens: 19, output_tokens: 0 } },
};
const block = {
  type: "content_block_start",
  index: 0,
  content_block: { type: "text", text: "" },
};
const delta = {
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: "Привет ✓" },
};
const antStop = [
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 7 },
  },
  { type: "message_stop" },
];
const antTool = {
  type: "content_block_start",
  index: 1,
  content_block: { type: "tool_use", id: "call", name: "read_file", input: {} },
};

test("session counts the same full input across Anthropic and OpenAI cache formats", async () => {
  const anthropicRecords = [
    {
      ...start,
      message: {
        ...start.message,
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 200,
        },
      },
    },
    block,
    delta,
    { type: "content_block_stop", index: 0 },
    { ...antStop[0], usage: { output_tokens: 25 } },
    antStop[1],
  ];
  const openAiRecords = [
    text,
    stop,
    {
      usage: {
        prompt_tokens: 1100,
        completion_tokens: 25,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    },
  ];
  const session = createSession("/project", "anthropic", request.model);
  const events = new RuntimeEventBus(session.id);
  const totals: number[] = [];
  attachSessionRecorder(session, events, ({ totalTokens }) => {
    totals.push(totalTokens.inputTokens + totalTokens.outputTokens);
  });
  const anthropic = adapter(async () => response(anthropicRecords, true), true);
  const openAi = adapter(async () => response(openAiRecords));
  const first = await new TurnRunner(anthropic, events).run(request, 100);
  expect(session.totalTokens).toEqual({
    inputTokens: 1100,
    outputTokens: 25,
    cacheReadTokens: 800,
    cacheCreationTokens: 200,
  });
  expect(first.usage.contextInputTokens).toBe(1100);

  session.providerId = "openai";
  session.model = "next-model";
  const second = await new TurnRunner(openAi, events).run(
    { ...request, model: session.model },
    100,
  );
  expect(second.usage.inputTokens + second.usage.outputTokens).toBe(1125);
  expect(second.usage.cacheCreationTokens).toBeUndefined();
  expect(session.totalTokens).toEqual({
    inputTokens: 2200,
    outputTokens: 50,
    cacheReadTokens: 1600,
    cacheCreationTokens: 200,
  });
  expect(totals).toEqual([1125, 2250]);
});

test("a failure after a recorded provider completion does not charge it again", async () => {
  const provider = adapter(async () =>
    response([
      text,
      stop,
      { usage: { prompt_tokens: 19, completion_tokens: 7 } },
    ]),
  );
  const session = createSession("/project", "openai", request.model);
  const events = new RuntimeEventBus(session.id);
  attachSessionRecorder(session, events);
  events.subscribe((event) => {
    if (event.type === "provider_turn_completed") throw new Error("observer");
  });

  await expect(
    new TurnRunner(provider, events).run(request, 19),
  ).rejects.toThrow("observer");
  expect(session.totalTokens).toEqual({ inputTokens: 19, outputTokens: 7 });
});

test("Anthropic reports the start of a validated thinking block before its text", async () => {
  const events = await collect(
    [
      start,
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      { type: "content_block_stop", index: 1 },
      block,
      delta,
      ...antStop,
    ],
    true,
  );
  expect(events.map((event) => event.type)).toEqual([
    "thinking_start",
    "text_delta",
    "turn_complete",
  ]);
  expect(events[0]).toEqual({ type: "thinking_start" });
});

test("Anthropic rejects data after message_stop for ordinary and extension requests", async () => {
  for (const overrides of [{}, { purpose: "extension_request" as const }]) {
    const events = await collect(
      [start, antTool, ...antStop, delta],
      true,
      overrides,
    );
    expect(events.at(-1)).toMatchObject({ type: "error", code: "transport" });
    expect(
      events.some(
        (event) => event.type === "tool_call" || event.type === "turn_complete",
      ),
    ).toBe(false);
  }
});

test("Anthropic rejects data before start, unknown stops and deltas after an explicit block stop", async () => {
  for (const records of [
    [block, start, delta, ...antStop],
    [start, block, { type: "content_block_stop", index: 99 }, ...antStop],
    [
      start,
      antTool,
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"path":"late.txt"}',
        },
      },
      ...antStop,
    ],
  ]) {
    const events = await collect(records, true);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "transport" });
    expect(
      events.some(
        (event) => event.type === "tool_call" || event.type === "turn_complete",
      ),
    ).toBe(false);
  }
});

test("Anthropic missing delta usage preserves prior counters and future opaque blocks stay compatible", async () => {
  const events = await collect(
    [
      start,
      block,
      delta,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "future_metadata", value: true },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "future_block", value: true },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ],
    true,
  );
  expect(events.filter((event) => event.type === "error")).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    type: "turn_complete",
    message: { content: [{ type: "text", text: "Привет ✓" }] },
    usage: { inputTokens: 19, outputTokens: 0 },
  });
});

for (const [name, invalid] of [
  ["null event", null],
  ["missing message", { type: "message_start" }],
  [
    "missing message usage",
    { type: "message_start", message: { role: "assistant" } },
  ],
  [
    "invalid usage",
    {
      type: "message_delta",
      delta: {},
      usage: { output_tokens: "private-fixture-value" },
    },
  ],
  [
    "missing message delta",
    { type: "message_delta", usage: { output_tokens: 7 } },
  ],
  [
    "null block",
    { type: "content_block_start", index: 2, content_block: null },
  ],
  [
    "invalid initial text",
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "text", text: {} },
    },
  ],
  ["missing delta", { type: "content_block_delta", index: 0 }],
  ["null delta", { type: "content_block_delta", index: 0, delta: null }],
  [
    "object text delta",
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: { value: "private-fixture-value" } },
    },
  ],
  [
    "wrong block for thinking",
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "private-fixture-value" },
    },
  ],
  [
    "non-string arguments",
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: {} },
    },
  ],
  [
    "invalid initial tool input",
    {
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "tool_use",
        id: "x",
        name: "read_file",
        input: [],
      },
    },
  ],
  ["duplicate start", start],
] as const) {
  test(`Anthropic ${name} fails before tool execution`, async () => {
    const events = await collect(
      [start, block, delta, antTool, invalid, ...antStop],
      true,
    );
    expect(events.at(-1)).toMatchObject({ type: "error", code: "transport" });
    expect(
      events.some(
        (event) => event.type === "tool_call" || event.type === "turn_complete",
      ),
    ).toBe(false);
    const failure = events.at(-1);
    expect(failure?.type === "error" && failure.message).not.toMatch(
      /undefined is not|TypeError|private-fixture-value/,
    );
  });
}

for (const anthropic of [false, true]) {
  const protocol = anthropic ? "Anthropic" : "OpenAI";
  test(`${protocol} disconnect before terminal never commits a pending tool`, async () => {
    const events = await collect(
      anthropic ? [start, antTool] : [tool],
      anthropic,
    );
    expect(events.at(-1)).toMatchObject({ type: "error", code: "transport" });
    expect(
      events.some(
        (event) => event.type === "tool_call" || event.type === "turn_complete",
      ),
    ).toBe(false);
  });
  test(`${protocol} in-band upstream error preserves its cause and never completes a tool`, async () => {
    const events = await collect(
      [
        ...(anthropic ? [start, antTool] : [tool]),
        {
          type: "error",
          error: {
            type: "api_error",
            message: "Upstream temporarily unavailable",
          },
        },
      ],
      anthropic,
    );
    expect(events.at(-1)).toMatchObject({ type: "error" });
    const last = events.at(-1);
    expect(last?.type === "error" && last.message).toContain(
      "Upstream temporarily unavailable",
    );
    expect(
      events.some(
        (event) => event.type === "tool_call" || event.type === "turn_complete",
      ),
    ).toBe(false);
  });

  test(`${protocol} malformed SSE JSON is a transport error`, async () => {
    const provider = adapter(
      async () =>
        new Response(
          `${anthropic ? "event: message_start\n" : ""}data: {broken\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      anthropic,
    );
    const events = [];
    for await (const event of provider.streamChat(request)) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "transport",
      message: "Провайдер прислал некорректный JSON в потоке ответа.",
    });
  });

  test(`${protocol} abort at EOF remains cancellation instead of success or a protocol error`, async () => {
    const abort = new AbortController();
    const provider = adapter(
      async () =>
        response(anthropic ? [start, block, delta] : [text], anthropic),
      anthropic,
    );
    const events: StreamEvent[] = [];
    for await (const event of provider.streamChat({
      ...request,
      signal: abort.signal,
    })) {
      events.push(event);
      if (event.type === "text_delta") abort.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cancelled" });
    expect(events.some((event) => event.type === "turn_complete")).toBe(false);
  });
}

test("OpenAI terminal gateway event may omit delta", async () => {
  const events = await collect([
    text,
    { choices: [{ index: 0, finish_reason: "stop" }] },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "turn_complete" });
});

test("OpenAI sends a portable history without empty tool arrays, preserving errors and tool-result order", async () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "Начни" }] },
    { role: "assistant", content: [{ type: "text", text: "Проверю" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "read_file", input: { path: "a" } },
        { type: "tool_use", id: "b", name: "read_file", input: { path: "b" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Продолжи" },
        { type: "tool_result", toolUseId: "a", content: "file contents" },
        {
          type: "tool_result",
          toolUseId: "b",
          content: "WORKTREE_GIT_ERROR",
          isError: true,
        },
      ],
    },
  ];
  const original = structuredClone(messages);
  const bodies: Record<string, unknown>[] = [];
  const provider = new OpenAIProtocolAdapter({
    apiKey: "fixture",
    maxRetries: 0,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      // A strict Chat Completions gateway rejects these shapes before generation.
      const pending = new Set<string>();
      let valid = !Array.isArray(body.tools) || body.tools.length > 0;
      for (const message of body.messages) {
        if (message.tool_calls?.length === 0) valid = false;
        if (message.role === "tool")
          valid &&= pending.delete(message.tool_call_id);
        else {
          if (pending.size) valid = false;
          for (const call of message.tool_calls ?? []) pending.add(call.id);
        }
      }
      if (!valid || pending.size)
        return Response.json(
          { error: { message: "Invalid tool history" } },
          { status: 400 },
        );
      return response([text, stop]);
    },
  });
  const events = [];
  for await (const event of provider.streamChat({ ...request, messages }))
    events.push(event);
  expect(events.at(-1)).toMatchObject({ type: "turn_complete" });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]?.tools).toBeUndefined();
  const wire = bodies[0]?.messages as Record<string, unknown>[];
  expect(wire.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "assistant",
    "tool",
    "tool",
    "user",
  ]);
  expect(wire[5]).toMatchObject({
    role: "tool",
    tool_call_id: "b",
    content: "WORKTREE_GIT_ERROR",
  });
  expect(messages).toEqual(original);
});

test("OpenAI opaque HTTP 400 DONE is an actionable rejection with one attempt, never a successful stream", async () => {
  let attempts = 0;
  const provider = new OpenAIProtocolAdapter({
    apiKey: "fixture",
    maxRetries: 2,
    tokenLimitFallback: true,
    fetch: async () => {
      attempts++;
      return new Response("data: [DONE]\n\n", {
        status: 400,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const events = [];
  for await (const event of provider.streamChat(request)) events.push(event);
  expect(attempts).toBe(1);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "error",
    code: "bad_request",
    status: 400,
  });
  expect(events[0]?.type === "error" && events[0].message).toContain(
    "не сообщил причину",
  );
});

for (const anthropic of [false, true]) {
  const protocol = anthropic ? "Anthropic" : "OpenAI";
  const failures = [
    {
      status: 503,
      upstream: anthropic ? "overloaded_error" : "server_error",
      code: "unavailable",
      retryable: true,
    },
    {
      status: 429,
      upstream: anthropic ? "rate_limit_error" : "rate_limit_exceeded",
      code: "rate_limit",
      retryable: true,
    },
    {
      status: 429,
      upstream: "insufficient_quota",
      code: "quota_exhausted",
      retryable: false,
    },
    {
      status: 401,
      upstream: anthropic ? "authentication_error" : "invalid_api_key",
      code: "authentication",
      retryable: false,
    },
  ];
  for (const { status, upstream, code, retryable } of failures) {
    test(`${protocol} preserves ${upstream} over HTTP and SSE`, async () => {
      const error = anthropic ? { type: upstream } : { code: upstream };
      const headers = { "Retry-After": "4" };
      const http = adapter(
        async () => Response.json({ error }, { status, headers }),
        anthropic,
      );
      const sse = adapter(
        async () =>
          new Response(
            `${anthropic ? "event: error\n" : ""}data: ${JSON.stringify({ type: "error", error })}\n\n`,
            { headers: { ...headers, "Content-Type": "text/event-stream" } },
          ),
        anthropic,
      );
      for (const [provider, expectedStatus] of [
        [http, status],
        [sse, undefined],
      ] as const) {
        const events = await Array.fromAsync(provider.streamChat(request));
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "error",
          code,
          retryable,
          upstreamCode: upstream,
          status: expectedStatus,
          retryAfterMs: 4000,
        });
      }
    });
  }
}
