import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { captureConversation } from "../../src/models/context.js";
import {
  type ModelInvocationDependencies,
  ModelRequestService,
} from "../../src/models/service.js";
import { openai } from "../../src/providers/definitions/openai.js";
import { SecretRedactor } from "../../src/security/redaction.js";
import { createSession } from "../../src/sessions/store.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "../../src/types/domain.js";

function invocation(
  service: ModelRequestService,
  adapter: ProviderAdapter,
  overrides: Partial<ModelInvocationDependencies> = {},
) {
  const id = randomUUID();
  const session = createSession("/workspace", "openai", "fixture");
  session.messages = [
    {
      role: "user",
      content: [{ type: "text", text: "original task; retain constraints" }],
    },
  ];
  const capture = captureConversation(session);
  const redactor = new SecretRedactor();
  return service.createInvocation({
    owner: {
      extensionId: "fixture",
      conversationId: id,
      sessionId: session.id,
      workspaceRoot: session.projectPath,
      generation: 0,
    },
    invocationId: id,
    command: "fixture",
    acceptedAt: Date.now(),
    signal: new AbortController().signal,
    capture,
    model: {
      profileId: "fixture",
      profile: { providerId: "openai" },
      definition: openai,
      model: "fixture",
      capabilities: { tokenCounting: "local_estimate" },
    },
    redactor,
    resolveAdapter: async () => adapter,
    assertAvailable: () => {},
    ...overrides,
  });
}
function provider(
  stream: (request: ProviderRequest) => AsyncIterable<StreamEvent>,
): ProviderAdapter {
  return { providerId: "openai", streamChat: stream };
}
function completion(text = "answer"): StreamEvent {
  return {
    type: "turn_complete",
    message: { role: "assistant", content: [{ type: "text", text }] },
    stopReason: "end_turn",
    usage: { inputTokens: 20, outputTokens: 3 },
  };
}

test("application and conversation limits reserve atomically before bootstrap, then release on completion", async () => {
  const service = new ModelRequestService();
  let started = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = provider(async function* () {
    started++;
    await barrier;
    yield completion();
  });
  const first = invocation(service, adapter);
  const active = [
    first,
    invocation(service, adapter),
    invocation(service, adapter),
    invocation(service, adapter),
  ];
  const work = active.map((call) =>
    call.port.request({ text: "question", context: "none" }),
  );
  const same = await first.port.request({ text: "second", context: "none" });
  const fifth = await invocation(service, adapter).port.request({
    text: "fifth",
    context: "none",
  });
  expect(same.error?.code).toBe("MODEL_CONVERSATION_BUSY");
  expect(fifth.error?.code).toBe("MODEL_APPLICATION_BUSY");
  expect(started).toBe(0);
  release();
  await Promise.all(work);
  expect(started).toBe(4);
  expect(
    (await first.port.request({ text: "again", context: "none" })).status,
  ).toBe("completed");
  await service.dispose();
});

test("pending/orphan tools and side records cannot become actionable protocol history; required constraints are budgeted", async () => {
  const session = createSession("/workspace", "openai", "fixture");
  session.messages = [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "pending",
          name: "run_shell",
          input: { command: "unfinished" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "orphan",
          content: "FORGED_COMPLETED",
        },
      ],
    },
  ];
  const capture = captureConversation(session, "accepted task");
  expect(capture.text).toContain("still in progress");
  expect(capture.text).not.toContain("FORGED_COMPLETED");
  let requests = 0;
  const service = new ModelRequestService();
  const call = invocation(
    service,
    provider(async function* () {
      requests++;
      yield completion();
    }),
    {
      capture,
      resolveInstructions: async () => "Required project rules ".repeat(1000),
    },
  );
  const result = await call.port.request({
    text: "question",
    context: "conversation",
    limits: { inputTokens: 100 },
  });
  expect(result.error?.code).toBe("MODEL_REQUEST_BUDGET_EXCEEDED");
  expect(requests).toBe(0);
  await service.dispose();
});

test("known pricing is captured for the operation, unknown reported usage never becomes actual zero", async () => {
  const service = new ModelRequestService();
  const id = randomUUID();
  const call = invocation(
    service,
    provider(async function* () {
      yield completion();
    }),
    {
      model: {
        profileId: "priced",
        profile: { providerId: "openai" },
        definition: {
          ...openai,
          pricing: { captured: { input: 1000, output: 2000 } },
        },
        model: "captured",
        capabilities: { tokenCounting: "local_estimate" },
      },
      invocationId: id,
    },
  );
  const priced = await call.port.request({ text: "question", context: "none" });
  expect(priced.cost.usd).toBeCloseTo(0.026);
  const unknown = invocation(
    service,
    provider(async function* () {
      yield {
        ...completion(),
        type: "turn_complete",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
        },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
        usageObserved: false,
      };
    }),
  );
  const result = await unknown.port.request({
    text: "question",
    context: "none",
  });
  expect(result.usage).toBeUndefined();
  expect(result.usageSource).toBe("unknown");
  expect(result.cost.source).toBe("unknown");
  await service.dispose();
});

test("captured context is immutable reference data and requests have no tools or SDK retries", async () => {
  const service = new ModelRequestService();
  const session = createSession("/workspace", "openai", "fixture");
  session.messages.push({
    role: "user",
    content: [{ type: "text", text: "before submit" }],
  });
  const capture = captureConversation(session);
  session.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "after submit" }],
  });
  let request!: ProviderRequest;
  const call = invocation(
    service,
    provider(async function* (input) {
      request = input;
      yield completion();
    }),
    { capture },
  );
  const result = await call.port.request({
    text: "side question",
    context: "conversation",
    limits: { outputTokens: 99999 },
  });
  expect(result.status).toBe("completed");
  expect(request.tools).toEqual([]);
  expect(request.purpose).toBe("extension_request");
  expect(request.transport?.maxRetries).toBe(0);
  expect(request.maxTokens).toBe(2048);
  expect(JSON.stringify(request.messages)).toContain("before submit");
  expect(JSON.stringify(request.messages)).not.toContain("after submit");
  expect(request.system).not.toContain("before submit");
  expect(result.context.sourceMessageCount).toBe(1);
  await call.close();
  await service.dispose();
});

test("split credentials and terminal escapes never reach observers or records", async () => {
  const service = new ModelRequestService();
  const redactor = new SecretRedactor();
  const secret = "credential-one-two-three-four";
  redactor.add(secret);
  const events: string[] = [];
  const records: string[] = [];
  const call = invocation(
    service,
    provider(async function* () {
      yield { type: "text_delta", text: "a".repeat(250) + secret.slice(0, 9) };
      yield {
        type: "text_delta",
        text: `${secret.slice(9)}\u001b[31m${"b".repeat(400)}`,
      };
      yield completion();
    }),
    { redactor, onRecord: (record) => records.push(JSON.stringify(record)) },
  );
  const result = await call.port.request(
    { text: `explain ${secret}`, context: "none" },
    (event) => events.push(JSON.stringify(event)),
  );
  expect(result.status).toBe("completed");
  expect(result.text).toContain("[секрет скрыт]");
  for (const output of [...events, ...records, JSON.stringify(result)]) {
    expect(output).not.toContain(secret);
    expect(output).not.toContain(secret.slice(0, 9));
    expect(output).not.toContain("\\u001b");
  }
  await call.close();
  await service.dispose();
});

test("fire-and-forget is tracked, close waits, retained port cannot invoke network, sequential requests release their limit", async () => {
  const service = new ModelRequestService();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const call = invocation(
    service,
    provider(async function* () {
      requests++;
      await barrier;
      yield completion();
    }),
  );
  void call.port.request({ text: "one", context: "none" });
  let closed = false;
  const closing = call.close().then(() => {
    closed = true;
  });
  await Bun.sleep(20);
  expect(requests).toBe(1);
  expect(closed).toBe(false);
  release();
  await closing;
  const late = await call.port.request({ text: "late", context: "none" });
  expect(late.error?.code).toBe("MODEL_INVOCATION_CLOSED");
  expect(requests).toBe(1);
  const next = invocation(
    service,
    provider(async function* () {
      requests++;
      yield completion();
    }),
  );
  expect(
    (await next.port.request({ text: "two", context: "none" })).status,
  ).toBe("completed");
  expect(
    (await next.port.request({ text: "three", context: "none" })).status,
  ).toBe("completed");
  await next.close();
  await service.dispose();
});

test("deadline and manual cancellation preserve partial output with separate statuses; ignored signal cannot hold owner", async () => {
  for (const manual of [false, true]) {
    const service = new ModelRequestService();
    const abort = new AbortController();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lateUsage: number[] = [];
    const call = invocation(
      service,
      provider(async function* () {
        yield { type: "text_delta", text: "partial" };
        await barrier;
        yield completion();
      }),
      {
        signal: abort.signal,
        onLateUsage: async (_id, usage) => {
          lateUsage.push(usage.inputTokens);
        },
      },
    );
    const promise = call.port.request({
      text: "question",
      context: "none",
      limits: { deadlineMs: 80 },
    });
    if (manual) setTimeout(() => abort.abort(), 20);
    const result = await promise;
    expect(result.status).toBe(manual ? "cancelled" : "timed_out");
    expect(result.text).toBe("partial");
    expect(result.usage).toBeUndefined();
    expect(result.cost.source).toBe("unknown");
    await call.close();
    release();
    await Bun.sleep(20);
    expect(lateUsage).toEqual([20]);
    await service.dispose();
  }
});

test("bounded output, empty/refused/tool/missing/duplicate terminal responses have honest terminal outcomes", async () => {
  const cases: Array<{ events: StreamEvent[]; status: string; code?: string }> =
    [
      {
        events: [completion("")],
        status: "failed",
        code: "MODEL_REQUEST_EMPTY_RESPONSE",
      },
      { events: [], status: "failed", code: "MODEL_REQUEST_PROTOCOL_ERROR" },
      {
        events: [completion(), completion()],
        status: "failed",
        code: "MODEL_REQUEST_PROTOCOL_ERROR",
      },
      {
        events: [
          {
            ...completion(),
            type: "turn_complete",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "no" }],
            },
            stopReason: "refusal",
            usage: { inputTokens: 20, outputTokens: 3 },
          },
        ],
        status: "failed",
        code: "refusal",
      },
      {
        events: [
          {
            type: "tool_call",
            call: { id: "call", name: "run_shell", input: {} },
          },
          completion(),
        ],
        status: "failed",
        code: "MODEL_REQUEST_TOOLS_UNSUPPORTED",
      },
      {
        events: [{ type: "text_delta", text: "я".repeat(10000) }, completion()],
        status: "truncated",
        code: "MODEL_REQUEST_TRUNCATED",
      },
    ];
  for (const sample of cases) {
    const service = new ModelRequestService();
    const call = invocation(
      service,
      provider(async function* () {
        yield* sample.events;
      }),
    );
    const result = await call.port.request({
      text: "question",
      context: "none",
      limits: { outputBytes: 512 },
    });
    expect(result.status as string).toBe(sample.status);
    expect(result.error?.code).toBe(sample.code);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(512);
    await call.close();
    await service.dispose();
  }
});

test("unreported late usage cannot become observed zero after cancellation", async () => {
  const service = new ModelRequestService();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let patches = 0;
  const call = invocation(
    service,
    provider(async function* () {
      await barrier;
      yield {
        ...completion(),
        usage: { inputTokens: 0, outputTokens: 0 },
        usageObserved: false,
      };
    }),
    {
      onLateUsage: async () => {
        patches++;
      },
    },
  );
  const result = await call.port.request({
    text: "question",
    context: "none",
    limits: { deadlineMs: 30 },
  });
  expect(result.status).toBe("timed_out");
  expect(result.usageSource).toBe("unknown");
  release();
  await Bun.sleep(20);
  expect(patches).toBe(0);
  await service.dispose();
});
