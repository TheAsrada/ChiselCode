import { expect, test } from "bun:test";
import { assembleMessages } from "../../src/context/assembler.js";
import {
  type ContextBuildRequest,
  ContextManager,
} from "../../src/context/context-manager.js";
import {
  modelSummarizer,
  summaryConversation,
} from "../../src/context/model-summary.js";
import { partitionTranscript } from "../../src/context/partition.js";
import { emptySummary } from "../../src/context/summary.js";
import { requestTokens } from "../../src/context/tokenizer.js";
import type {
  ContextCompactionRecord,
  ContextSummarizer,
} from "../../src/context/types.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import {
  type RuntimeEvent,
  RuntimeEventBus,
} from "../../src/runtime/events.js";
import { attachSessionRecorder } from "../../src/sessions/checkpoints.js";
import { withSessionCompatibility } from "../../src/sessions/migrate.js";
import { SessionV3Schema } from "../../src/sessions/schema.js";
import { createSession } from "../../src/sessions/store.js";
import type {
  ChatMessage,
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "../../src/types/domain.js";
import { compactionNotice } from "../../src/ui/context-compaction.js";
import { replaySessionIntoTranscript } from "../../src/ui/tool-transcript.js";
import { TuiController } from "../../src/ui/tui-controller.js";

const capabilities = {
  contextWindow: 8000,
  maxOutputTokens: 2000,
  tokenCounting: "local_estimate" as const,
};
const handoff = {
  ...emptySummary(),
  goal: "Finish the landing page",
  userConstraints: ["Keep the API stable", "Do not publish"],
  importantReferences: ["index.html", "tool-result://log-a"],
  nextAction: "Read index.html and finish the animation",
};
const text = (role: ChatMessage["role"], value: string): ChatMessage => ({
  role,
  content: [{ type: "text", text: value }],
});
function history() {
  const session = createSession("/project", "openai-compatible", "custom");
  session.messages = [
    text(
      "user",
      "Finish the landing page. Keep the API stable. Do not publish.",
    ),
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read-a",
          name: "read_file",
          input: { path: "index.html" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "read-a",
          content: `${"log ".repeat(6000)}\ntool-result://log-a`,
        },
      ],
    },
    text("assistant", "Continue with the animation"),
  ];
  return session;
}
function turn(value: string, stopReason = "end_turn"): StreamEvent {
  return {
    type: "turn_complete",
    message: text("assistant", value),
    stopReason,
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}
function fixture(
  provider?: ProviderAdapter,
  summarizer: ContextSummarizer = modelSummarizer,
) {
  const session = history();
  const events: RuntimeEvent[] = [];
  const bus = new RuntimeEventBus(session.id);
  bus.subscribe((event) => {
    events.push(event);
  });
  const requests: ProviderRequest[] = [];
  const adapter: ProviderAdapter = provider ?? {
    providerId: session.providerId,
    getCapabilities: async () => capabilities,
    async *streamChat(input) {
      requests.push(input);
      yield turn(JSON.stringify(handoff));
    },
  };
  const manager = new ContextManager(
    { keepRecentTokens: 100 },
    bus,
    undefined,
    summarizer,
  );
  const input: ContextBuildRequest = {
    session,
    provider: adapter,
    capabilities,
    system: "Project rules",
    tools: [],
  };
  return { session, events, bus, requests, manager, input };
}

test("model compaction preserves the current request, real tool boundaries and the durable transcript", async () => {
  const f = fixture();
  const original = JSON.stringify(f.session.messages);
  const before = requestTokens(
    f.input.system,
    f.session.messages,
    f.input.tools,
  );
  const frame = await f.manager.build(f.input);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.tools).toEqual([]);
  expect(f.requests[0]?.maxTokens).toBe(512);
  expect(f.session.context?.activeCheckpoint).toMatchObject({
    source: "model",
    preservedUserMessageIndex: 0,
    summary: handoff,
  });
  expect(
    frame.messages.filter((message) => message === f.session.messages[0]),
  ).toHaveLength(1);
  expect(
    partitionTranscript(frame.messages).every((unit) => !unit.pending),
  ).toBe(true);
  expect(JSON.stringify(f.session.messages)).toBe(original);
  const record = f.session.context?.compactions?.[0];
  expect(record).toMatchObject({
    reason: "auto",
    source: "model",
    beforeTokens: before,
    afterTokens: frame.estimatedInputTokens,
    estimated: true,
    afterMessage: 4,
  });
  expect(record?.afterTokens).toBeLessThan(before);
  expect(f.session.contextSnapshot?.occupiedTokens).toBe(
    frame.estimatedInputTokens,
  );
  expect(
    f.events.filter((event) => event.type === "context_compaction_completed"),
  ).toHaveLength(1);
  expect(f.events.some((event) => event.type === "provider_text_delta")).toBe(
    false,
  );
});

test("the runtime continues the original task after a summary and counts auxiliary usage once", async () => {
  const requests: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    providerId: "openai-compatible",
    getCapabilities: async () => capabilities,
    async *streamChat(input) {
      requests.push(input);
      yield turn(
        input.system.includes("compact, factual handoff")
          ? JSON.stringify(handoff)
          : "Animation completed",
      );
    },
  };
  const f = fixture(adapter);
  let toolExecutions = 0;
  const result = await new AgentRuntime(
    adapter,
    f.manager,
    {
      selectForTurn: async () => [],
      execute: async () => {
        toolExecutions++;
        return [];
      },
    },
    "Project rules",
    f.bus,
  ).run(f.session, "Finish the animation now");
  expect(result.status).toBe("completed");
  expect(result.text).toBe("Animation completed");
  expect(requests).toHaveLength(2);
  const summaryInput = requests[0]?.messages[0]?.content[0];
  if (summaryInput?.type !== "text") throw new Error("Missing summary input");
  expect(JSON.parse(summaryInput.text).currentRequest).toContain(
    "Finish the animation now",
  );
  expect(requests[1]?.messages.at(-1)).toEqual(
    text("user", "Finish the animation now"),
  );
  expect(f.session.totalTokens).toMatchObject({
    inputTokens: 200,
    outputTokens: 40,
  });
  expect(
    f.session.messages.filter((message) =>
      message.content.some(
        (item) => item.type === "text" && item.text === JSON.stringify(handoff),
      ),
    ),
  ).toHaveLength(0);
  expect(toolExecutions).toBe(0);
});

test("repeat compaction sends the prior handoff and preserves the newest correction exactly once", async () => {
  const f = fixture();
  await f.manager.build(f.input);
  f.session.messages.push(
    text("user", "Correction: use SVG instead of canvas"),
    text("assistant", "Older reasoning ".repeat(2000)),
    text("assistant", "Next action"),
  );
  await f.manager.build(f.input);
  const payload = JSON.parse(
    f.requests[1]?.messages[0]?.content[0]?.type === "text"
      ? f.requests[1].messages[0].content[0].text
      : "{}",
  );
  expect(payload.priorSummary).toEqual(handoff);
  expect(payload.conversation).toContain(
    "Correction: use SVG instead of canvas",
  );
  expect(f.session.context?.compactions).toHaveLength(2);
  expect(
    assembleMessages(f.session).filter((message) =>
      message.content.some(
        (item) =>
          item.type === "text" &&
          item.text === "Correction: use SVG instead of canvas",
      ),
    ),
  ).toHaveLength(1);
});

test("a new user request replaces the raw pinned request while preserving the previous handoff", async () => {
  const f = fixture();
  await f.manager.build(f.input);
  const previous = f.session.messages[0];
  if (!previous) throw new Error("Missing original user request");
  const current = text(
    "user",
    "Now fix the contact form; keep previous constraints",
  );
  f.session.messages.push(current);
  const projected = assembleMessages(f.session);
  expect(projected.includes(previous)).toBe(false);
  expect(projected.at(-1)).toEqual(current);
  expect(projected[0]?.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("Do not publish"),
  });
});

test("unresolved parallel tool calls and recent results remain an atomic tail", async () => {
  const f = fixture();
  f.session.messages.push(
    text("user", "Read both files"),
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "b", name: "read_file", input: { path: "b" } },
        { type: "tool_use", id: "c", name: "read_file", input: { path: "c" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "b", content: "first result" },
      ],
    },
  );
  const frame = await f.manager.build(f.input);
  const last = partitionTranscript(frame.messages).at(-1);
  expect(last?.pending).toBe(true);
  expect(last?.messages).toEqual(f.session.messages.slice(5));
  expect(
    frame.messages.some((message) =>
      message.content.some(
        (item) => item.type === "tool_result" && item.toolUseId === "read-a",
      ),
    ),
  ).toBe(false);
});

for (const invalid of [
  '{"goal":',
  "{}",
  "```json\n{}\n```",
  JSON.stringify({ ...handoff, nextAction: "" }),
]) {
  test(`invalid model summary safely falls back to observed evidence: ${invalid.slice(0, 25)}`, async () => {
    const f = fixture({
      providerId: "openai-compatible",
      async *streamChat() {
        yield turn(invalid);
      },
    });
    const stop = attachSessionRecorder(f.session, f.bus);
    await f.manager.build(f.input);
    stop();
    expect(f.session.context?.activeCheckpoint?.source).toBe("evidence");
    expect(
      f.session.context?.activeCheckpoint?.summary.userConstraints,
    ).toContain(
      "Finish the landing page. Keep the API stable. Do not publish.",
    );
    expect(f.session.totalTokens.inputTokens).toBe(100);
  });
}

test("truncated summaries and proposed tools are never committed or executed", async () => {
  for (const tool of [false, true]) {
    const f = fixture({
      providerId: "openai-compatible",
      async *streamChat() {
        if (tool)
          yield {
            type: "tool_call",
            call: {
              id: "unsafe",
              name: "run_shell",
              input: { command: "git push" },
            },
          };
        yield turn(JSON.stringify(handoff), tool ? "tool_use" : "max_tokens");
      },
    });
    await f.manager.build(f.input);
    expect(f.session.context?.activeCheckpoint?.source).toBe("evidence");
    expect(
      f.session.messages.some((message) =>
        message.content.some(
          (item) => item.type === "tool_use" && item.id === "unsafe",
        ),
      ),
    ).toBe(false);
  }
});

test("reading a test file cannot become a successful verification claim in the model handoff", async () => {
  const f = fixture({
    providerId: "openai-compatible",
    async *streamChat() {
      yield turn(
        JSON.stringify({ ...handoff, verification: ["All tests passed"] }),
      );
    },
  });
  f.session.undoStack.push({
    path: "index.html",
    before: null,
    after: "<html>",
    createdAt: new Date().toISOString(),
  });
  await f.manager.build(f.input);
  expect(f.session.context?.activeCheckpoint?.summary.verification).toEqual([]);
  expect(f.session.context?.activeCheckpoint?.summary.changedFiles).toEqual({
    "index.html": "created",
  });
});

test("a cancelled summary leaves the existing projection and transcript untouched", async () => {
  const abort = new AbortController();
  const f = fixture(undefined, async () => {
    abort.abort();
    return handoff;
  });
  const original = JSON.stringify(f.session.messages);
  await expect(
    f.manager.build({ ...f.input, signal: abort.signal }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  expect(f.session.context?.activeCheckpoint).toBeUndefined();
  expect(f.session.context?.compactions).toBeUndefined();
  expect(JSON.stringify(f.session.messages)).toBe(original);
  expect(
    f.events.filter((event) => event.type === "context_compaction_completed"),
  ).toHaveLength(0);
  expect(f.events.at(-1)).toMatchObject({
    type: "context_compaction_failed",
    errorCode: "CANCELLED",
  });
});

test("cancellation of a later compaction preserves the previous checkpoint and its cards", async () => {
  const abort = new AbortController();
  let calls = 0;
  const f = fixture(undefined, async () => {
    if (++calls === 2) abort.abort();
    return structuredClone(handoff);
  });
  await f.manager.build(f.input);
  const oldContext = JSON.stringify(f.session.context);
  f.session.messages.push(
    text("assistant", "Older reasoning ".repeat(2000)),
    text("user", "Continue"),
  );
  const original = JSON.stringify(f.session.messages);
  await expect(
    f.manager.build({ ...f.input, signal: abort.signal }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  expect(JSON.stringify(f.session.context)).toBe(oldContext);
  expect(JSON.stringify(f.session.messages)).toBe(original);
  expect(f.session.context?.compactions).toHaveLength(1);
});

test("a summary that does not reduce the request cannot replace a checkpoint or show success", async () => {
  const f = fixture(undefined, async () => ({
    ...handoff,
    decisions: ["too large ".repeat(10_000)],
  }));
  await expect(f.manager.build(f.input)).rejects.toMatchObject({
    code: "CONTEXT_BUDGET_EXCEEDED",
  });
  expect(f.session.context?.activeCheckpoint).toBeUndefined();
  expect(f.session.context?.compactions).toBeUndefined();
  expect(
    f.events.some((event) => event.type === "context_compaction_completed"),
  ).toBe(false);
  expect(
    f.events.some(
      (event) =>
        event.type === "context_compaction_failed" &&
        event.errorCode === "NO_REDUCTION",
    ),
  ).toBe(true);
});

test("provider token counting gives exact before/after metrics including system and tools", async () => {
  const f = fixture();
  const counted: ProviderRequest[] = [];
  f.input.tools = [
    {
      name: "read_file",
      description: "Read",
      inputSchema: { type: "object" },
      requiresApproval: false,
    },
  ];
  f.input.capabilities = { ...capabilities, tokenCounting: "provider" };
  f.input.provider.countTokens = async (request) => {
    counted.push(request);
    return requestTokens(request.system, request.messages, request.tools) + 17;
  };
  const frame = await f.manager.build(f.input);
  const record = f.session.context?.compactions?.[0];
  expect(record?.estimated).toBe(false);
  expect(record?.beforeTokens).toBe(
    requestTokens(f.input.system, f.session.messages, f.input.tools) + 17,
  );
  expect(record?.afterTokens).toBe(frame.localInputTokens + 17);
  expect(
    counted.every(
      (request) =>
        request.system === "Project rules" && request.tools.length === 1,
    ),
  ).toBe(true);
});

test("disabling auto compaction also disables overflow recovery and auxiliary calls", async () => {
  const f = fixture();
  const manager = new ContextManager(
    { autoCompact: false },
    f.bus,
    undefined,
    modelSummarizer,
  );
  expect(await manager.emergencyCompact(f.session, f.input)).toBe(false);
  await manager.build({
    ...f.input,
    capabilities: { ...capabilities, contextWindow: 20_000 },
  });
  expect(f.requests).toHaveLength(0);
  expect(
    f.events.some((event) => event.type.startsWith("context_compaction")),
  ).toBe(false);
});

test("uncompressible overflow fails once without retrying an identical provider request", async () => {
  const session = createSession("/project", "openai-compatible", "unknown");
  const bus = new RuntimeEventBus(session.id);
  let requests = 0;
  const provider: ProviderAdapter = {
    providerId: "openai-compatible",
    async *streamChat() {
      requests++;
      yield { type: "error", code: "context_overflow", message: "Too long" };
    },
  };
  const result = await new AgentRuntime(
    provider,
    new ContextManager({}, bus, undefined, modelSummarizer),
    { selectForTurn: async () => [], execute: async () => [] },
    "Rules",
    bus,
  ).run(session, "Hello");
  expect(requests).toBe(1);
  expect(result.errorCode).toBe("PROVIDER_CONTEXT_OVERFLOW");
  expect(session.context?.compactions).toBeUndefined();
});

test("serialized tool payloads are bounded and preserve artifact references for reloading", () => {
  const conversation = summaryConversation([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "a",
          name: "apply_patch",
          input: {
            edits: Array.from({ length: 1000 }, () => ({
              content: "code ".repeat(1000),
            })),
          },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "a",
          content: `${"log ".repeat(10_000)}\ntool-result://output-a`,
        },
      ],
    },
  ]);
  expect(conversation.length).toBeLessThan(8000);
  expect(conversation).toContain("tool-result://output-a");
});

test("checkpoints and compaction cards survive persistence without entering provider history", async () => {
  const f = fixture();
  await f.manager.build(f.input);
  const saved = withSessionCompatibility(
    SessionV3Schema.parse(
      JSON.parse(JSON.stringify({ ...f.session, schemaVersion: 3 })),
    ),
  );
  expect(saved.context).toEqual(f.session.context);
  expect(assembleMessages(saved)).toEqual(assembleMessages(f.session));
  const controller = new TuiController("/project");
  replaySessionIntoTranscript(controller, saved);
  expect(
    controller.snapshot.transcript.filter((entry) => entry.tone === "context"),
  ).toHaveLength(1);
  const noticeIndex = controller.snapshot.transcript.findIndex(
    (entry) => entry.tone === "context",
  );
  expect(controller.snapshot.transcript[noticeIndex - 1]?.text).toBe(
    "Continue with the animation",
  );
  expect(
    saved.messages.some((message) =>
      message.content.some(
        (item) =>
          item.type === "text" &&
          item.text.includes("Контекст сжат автоматически"),
      ),
    ),
  ).toBe(false);
  if (!saved.context?.activeCheckpoint)
    throw new Error("Missing persisted checkpoint");
  saved.context.activeCheckpoint.preservedUserMessageIndex = 2;
  expect(() => assembleMessages(saved)).toThrow(
    "Invalid preserved user request",
  );
  controller.dispose();
});

test("pending cards clear on failure, completion and session switch; completed cards do not duplicate", () => {
  const controller = new TuiController("/project");
  const record: ContextCompactionRecord = {
    id: "one",
    afterMessage: 1,
    beforeTokens: 80_000,
    afterTokens: 12_000,
    estimated: true,
    durationMs: 2300,
    reason: "auto",
    source: "model",
    createdAt: new Date().toISOString(),
  };
  controller.beginCompaction(record.id);
  expect(controller.snapshot.compaction?.id).toBe(record.id);
  expect(controller.snapshot.transcript).toHaveLength(0);
  controller.abortCompaction("unrelated");
  expect(controller.snapshot.compaction).toBeDefined();
  controller.finishCompaction(record);
  controller.finishCompaction(record);
  expect(controller.snapshot.compaction).toBeUndefined();
  expect(controller.snapshot.transcript).toHaveLength(1);
  expect(compactionNotice(record)).toContain("освобождено 85%");
  controller.beginCompaction("two");
  controller.abortCompaction("two");
  expect(controller.snapshot.compaction).toBeUndefined();
  controller.beginCompaction("three");
  controller.switchSession({ id: "new", projectPath: "/project" });
  expect(controller.snapshot.compaction).toBeUndefined();
  expect(controller.snapshot.transcript).toHaveLength(0);
  controller.dispose();
});
