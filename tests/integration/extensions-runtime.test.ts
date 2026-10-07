import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPrompt } from "../../src/app/run-prompt.js";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { ContextManager } from "../../src/context/context-manager.js";
import { partitionTranscript } from "../../src/context/partition.js";
import { emptySummary } from "../../src/context/summary.js";
import { requestTokens } from "../../src/context/tokenizer.js";
import type { ContextSummaryRequest } from "../../src/context/types.js";
import { AgentLoop } from "../../src/core/agent-loop.js";
import {
  contextCollection,
  withExtensionWorkspace,
} from "../../src/extensions/composition.js";
import type { ContextCollectionPort } from "../../src/extensions/contracts.js";
import { canonicalWorkspaceRoot } from "../../src/extensions/host.js";
import {
  ExtensionHost,
  type WorkspaceExtensionScope,
} from "../../src/extensions/index.js";
import { AnthropicProtocolAdapter } from "../../src/providers/drivers/anthropic-messages.js";
import { OpenAIProtocolAdapter } from "../../src/providers/drivers/openai-chat.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { withSessionCompatibility } from "../../src/sessions/migrate.js";
import { SessionV3Schema } from "../../src/sessions/schema.js";
import { createSession } from "../../src/sessions/store.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type {
  ChatMessage,
  ProviderAdapter,
  ProviderRequest,
} from "../../src/types/domain.js";
import { extensionFixture } from "../fixtures/extension.js";

const roots: string[] = [];
const hosts: ExtensionHost[] = [];
afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const value = await canonicalWorkspaceRoot(
    await mkdtemp(join(tmpdir(), "chisel-extension-runtime-")),
  );
  roots.push(value);
  return value;
}
function host(definitions: ConstructorParameters<typeof ExtensionHost>[0]) {
  const value = new ExtensionHost(definitions);
  hosts.push(value);
  return value;
}
const text = (role: ChatMessage["role"], value: string): ChatMessage => ({
  role,
  content: [{ type: "text", text: value }],
});

function setup(
  scope: WorkspaceExtensionScope,
  fixture: ReturnType<typeof extensionFixture>,
  provider: ProviderAdapter,
  session = createSession(scope.workspaceRoot, "openai", "mock"),
  manager?: ContextManager,
) {
  const bus = new RuntimeEventBus(session.id);
  const service = scope.services.get(fixture.token);
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    { autoApprove: false, allowedTools: new Set(), nonInteractive: false },
    { requestApproval: async () => "approved" },
  );
  const persisted = join(scope.workspaceRoot, `${session.id}.json`);
  const checkpoint = async () => {
    await writeFile(persisted, JSON.stringify(SessionV3Schema.parse(session)));
  };
  const tools = createLocalToolRuntime(
    scope.workspaceRoot,
    [],
    gate,
    session,
    [],
    {
      events: bus,
      toolGuards: scope.toolGuards,
      checkpoint,
      artifactDirectory: join(scope.workspaceRoot, "artifacts", session.id),
    },
  );
  tools.catalog.register({
    spec: {
      name: "fixture_update",
      description: "Increment fixture state",
      inputSchema: {},
      permission: "edit",
      effect: "workspace_write",
      parallelSafe: false,
      guidance: "Trusted native fixture guidance.",
    },
    parse: (input) => input,
    prepare: async () => ({
      data: undefined,
      preview: "Update fixture state",
      resources: ["fixture-state"],
    }),
    execute: async () => {
      service.value++;
      return { output: "Fixture updated" };
    },
  });
  const runtime = new AgentRuntime(
    provider,
    manager ?? new ContextManager({}, bus),
    {
      selectForTurn: () => tools.catalog.selectForTurn(),
      instructionsForTurn: (selected) =>
        tools.catalog.instructionsForTurn(selected),
      execute: (calls, signal) => tools.scheduler.execute(calls, signal),
    },
    "Core",
    bus,
  );
  return {
    session,
    runtime,
    tools,
    persisted,
    run: (
      prompt: string,
      signal?: AbortSignal,
      contextProviders: ContextCollectionPort = contextCollection(
        scope,
        (text) => text,
      ),
    ) =>
      runtime.run(session, prompt, {
        signal,
        contextProviders,
        onCheckpoint: checkpoint,
      }),
  };
}

test("real runtime seams refresh context after a tool, persist no contribution and reuse borrowed service across prompts/resume", async () => {
  const fixture = extensionFixture();
  const h = host([fixture.extension]);
  const path = await root();
  const requests: ProviderRequest[] = [];
  const counted: ProviderRequest[] = [];
  let calls = 0;
  const provider: ProviderAdapter = {
    providerId: "openai",
    getCapabilities: async () => ({ tokenCounting: "provider" }),
    countTokens: async (request) => {
      counted.push(structuredClone({ ...request, signal: undefined }));
      return requestTokens(request.system, request.messages, request.tools);
    },
    async *streamChat(request) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      calls++;
      yield {
        type: "turn_complete",
        message:
          calls === 1
            ? {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "update",
                    name: "fixture_update",
                    input: {},
                  },
                ],
              }
            : text("assistant", "Done"),
        stopReason: calls === 1 ? "tool_use" : "end_turn",
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    },
  };
  let first!: ReturnType<typeof setup>;
  await withExtensionWorkspace(
    path,
    { host: h },
    undefined,
    async (scope, signal) => {
      first = setup(scope, fixture, provider);
      expect((await first.run("Inspect state", signal)).status).toBe(
        "completed",
      );
    },
  );
  const service = fixture.services.get(path);
  if (!service) throw new Error("Missing workspace service");
  expect(service?.value).toBe(1);
  expect(service?.disposed).toBe(0);
  expect(requests).toHaveLength(2);
  expect(fixture.snapshots).toHaveLength(2);
  expect(fixture.snapshots.map((snapshot) => snapshot.attempt)).toEqual([1, 2]);
  expect(JSON.stringify(requests[0]?.messages[0])).toContain("state=0");
  expect(JSON.stringify(requests[1]?.messages[0])).toContain("state=1");
  expect(
    JSON.stringify(requests[1]?.messages).match(/EPHEMERAL_FIXTURE/g),
  ).toHaveLength(1);
  expect(requests[0]?.system).toContain("Trusted native fixture guidance");
  expect(requests[0]?.system).not.toContain("EPHEMERAL_FIXTURE");
  expect(counted[0]?.messages).toEqual(requests[0]?.messages);
  expect(
    partitionTranscript(requests[1]?.messages ?? []).every(
      (unit) => !unit.pending,
    ),
  ).toBe(true);
  const stored = await readFile(first.persisted, "utf8");
  expect(stored).not.toContain("EPHEMERAL_FIXTURE");
  const resumed = withSessionCompatibility(
    SessionV3Schema.parse(JSON.parse(stored)),
  );
  await withExtensionWorkspace(
    path,
    { host: h },
    undefined,
    async (scope, signal) => {
      expect(scope.services.get(fixture.token)).toBe(service);
      expect(
        (
          await setup(scope, fixture, provider, resumed).run(
            "Follow up",
            signal,
          )
        ).status,
      ).toBe("completed");
    },
  );
  expect(fixture.activations()).toBe(1);
  expect(fixture.snapshots).toHaveLength(3);
  expect(JSON.stringify(requests[2]?.messages[0])).toContain("state=1");
  await h.dispose();
  await h.dispose();
  expect(service?.disposed).toBe(1);
});

test("fixture guard veto travels through the normal tool failure/recording path", async () => {
  const fixture = extensionFixture();
  const scope = await host([fixture.extension]).open(await root());
  const provider: ProviderAdapter = {
    providerId: "openai",
    async *streamChat() {},
  };
  const f = setup(scope, fixture, provider);
  const result = await f.tools.executor.execute({
    id: "deny",
    name: "fixture_update",
    input: { deny: true },
  });
  expect(result.errorCode).toBe("EXTENSION_HOOK_DENIED");
  expect(f.session.runtime?.invocations.deny?.state).toBe("denied");
  expect(scope.services.get(fixture.token).value).toBe(0);
  expect(
    JSON.parse(await readFile(f.persisted, "utf8")).runtime.invocations.deny
      .state,
  ).toBe("denied");
});

test("parallel runs share only workspace service; abort A leaves B, its session and another workspace alive", async () => {
  const fixture = extensionFixture();
  const h = host([fixture.extension]);
  const scope = await h.open(await root());
  const other = await h.open(await root());
  const requests: ProviderRequest[] = [];
  const waiting = new Map<string, () => void>();
  const starts = new Map<string, Promise<void>>();
  for (const label of ["A", "B"])
    starts.set(
      label,
      new Promise<void>((resolve) => {
        waiting.set(label, resolve);
      }),
    );
  let complete!: () => void;
  const releaseB = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const provider: ProviderAdapter = {
    providerId: "openai",
    async *streamChat(request) {
      requests.push(request);
      const label = JSON.stringify(request.messages).includes("request=A")
        ? "A"
        : "B";
      waiting.get(label)?.();
      if (label === "A") {
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        yield { type: "error", code: "cancelled", message: "Cancelled A" };
      } else {
        await releaseB;
        yield {
          type: "turn_complete",
          message: text("assistant", "B completed"),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
    },
  };
  const a = setup(scope, fixture, provider);
  const b = setup(scope, fixture, provider);
  const abort = new AbortController();
  const runA = a.run("A", abort.signal);
  const runB = b.run("B");
  await Promise.all(starts.values());
  abort.abort();
  expect((await runA).status).toBe("cancelled");
  expect(scope.signal.aborted).toBe(false);
  expect(scope.services.get(fixture.token).disposed).toBe(0);
  expect(scope.services.get(fixture.token)).not.toBe(
    other.services.get(fixture.token),
  );
  complete();
  expect((await runB).status).toBe("completed");
  expect(a.session.id).not.toBe(b.session.id);
  expect(fixture.snapshots[0]?.signal).not.toBe(fixture.snapshots[1]?.signal);
  expect(
    fixture.snapshots.find((snapshot) => snapshot.userPrompt === "B")?.signal
      .aborted,
  ).toBe(false);
  expect(requests).toHaveLength(2);
});

test("context provider failure prevents provider request and does not enter durable checkpoints", async () => {
  const fixture = extensionFixture();
  const scope = await host([fixture.extension]).open(await root());
  let modelCalls = 0;
  const provider: ProviderAdapter = {
    providerId: "openai",
    async *streamChat() {
      modelCalls++;
      yield {
        type: "error",
        code: "unknown",
        message: "Unexpected model request",
      };
    },
  };
  const f = setup(scope, fixture, provider);
  const brokenHost = host([
    {
      id: "broken",
      activate(ctx) {
        ctx.contextProviders.register({
          id: "bad",
          collect: () => {
            throw new Error("raw body secret=credential");
          },
        });
      },
    },
  ]);
  const broken = await brokenHost.open(scope.workspaceRoot);
  const result = await f.run(
    "Request",
    undefined,
    contextCollection(broken, (text) => text),
  );
  expect(result).toMatchObject({
    status: "failed",
    errorCode: "EXTENSION_CONTEXT_FAILED",
  });
  expect(result.error).not.toContain("credential");
  expect(modelCalls).toBe(0);
  expect(await readFile(f.persisted, "utf8")).not.toContain("credential");
});

test("abort during runtime context collection stops the attempt before streamChat and keeps borrowed services alive", async () => {
  const fixture = extensionFixture();
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (value: undefined) => void;
  const callback = new Promise<undefined>((resolve) => {
    finish = resolve;
  });
  let later = false;
  const h = host([
    fixture.extension,
    {
      id: "slow",
      activate(ctx) {
        ctx.contextProviders.register({
          id: "waiting",
          collect: () => {
            started();
            return callback;
          },
        });
        ctx.contextProviders.register({
          id: "later",
          collect: () => {
            later = true;
            return undefined;
          },
        });
      },
    },
  ]);
  const scope = await h.open(await root());
  let modelCalls = 0;
  const provider: ProviderAdapter = {
    providerId: "openai",
    async *streamChat() {
      modelCalls++;
      yield { type: "error", code: "unknown", message: "Unexpected" };
    },
  };
  const abort = new AbortController();
  const f = setup(scope, fixture, provider);
  const run = f.run("Cancel context", abort.signal);
  await waiting;
  abort.abort();
  expect(await run).toMatchObject({
    status: "cancelled",
    errorCode: "CANCELLED",
  });
  expect(modelCalls).toBe(0);
  expect(later).toBe(false);
  expect(scope.signal.aborted).toBe(false);
  expect(scope.services.get(fixture.token).disposed).toBe(0);
  finish(undefined);
  expect(await readFile(f.persisted, "utf8")).not.toContain(
    "EPHEMERAL_FIXTURE",
  );
});

test("legacy adapters forward the same context and executor guard ports without a second execution system", async () => {
  const fixture = extensionFixture();
  const scope = await host([fixture.extension]).open(await root());
  const session = createSession(scope.workspaceRoot, "openai", "mock");
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    { autoApprove: false, allowedTools: new Set(), nonInteractive: false },
    { requestApproval: async () => "approved" },
  );
  const tools = new ToolRegistry(scope.workspaceRoot, [], gate, session, [], {
    toolGuards: scope.toolGuards,
  });
  tools.runtime.catalog.register({
    spec: {
      name: "fixture_update",
      description: "Fixture",
      inputSchema: {},
      permission: "edit",
      effect: "workspace_write",
      parallelSafe: false,
    },
    parse: (input) => input,
    prepare: async () => ({
      data: undefined,
      preview: "fixture",
      resources: ["fixture-state"],
    }),
    execute: async () => {
      throw new Error("Denied handler must not execute");
    },
  });
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    providerId: "openai",
    async *streamChat(request) {
      requests.push(request);
      yield {
        type: "turn_complete",
        message:
          requests.length === 1
            ? {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "fixture",
                    name: "fixture_update",
                    input: { deny: true },
                  },
                ],
              }
            : text("assistant", "Denied as intended"),
        stopReason: requests.length === 1 ? "tool_use" : "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const result = await new AgentLoop(provider, tools, "Core", {
    onText: () => {},
  }).run(session, "Fixture", {
    contextProviders: contextCollection(scope, (text) => text),
  });
  expect(result.status).toBe("completed");
  expect(session.runtime?.invocations.fixture?.state).toBe("denied");
  expect(JSON.stringify(requests[1]?.messages[0])).toContain(
    "EPHEMERAL_FIXTURE",
  );
  expect(fixture.snapshots).toHaveLength(2);
});

test("rejected provider response retries recollect fresh context without accumulating previous data", async () => {
  const fixture = extensionFixture();
  const scope = await host([fixture.extension]).open(await root());
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    providerId: "openai",
    async *streamChat(request) {
      requests.push(request);
      if (requests.length === 1) {
        scope.services.get(fixture.token).value = 2;
        yield {
          type: "error",
          code: "invalid_tool_arguments",
          message: "Malformed",
        };
      } else
        yield {
          type: "turn_complete",
          message: text("assistant", "Recovered"),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
    },
  };
  expect(
    (await setup(scope, fixture, provider).run("Repair response")).status,
  ).toBe("completed");
  expect(
    fixture.snapshots.map((snapshot) => ({
      iteration: snapshot.iteration,
      attempt: snapshot.attempt,
    })),
  ).toEqual([
    { iteration: 0, attempt: 1 },
    { iteration: 0, attempt: 2 },
  ]);
  expect(JSON.stringify(requests[1]?.messages[0])).toContain("state=2");
  expect(JSON.stringify(requests[1]?.messages)).not.toContain("state=0");
});

test("auto/projected compaction and emergency retry use one attempt snapshot; summarizer never sees contributions", async () => {
  const fixture = extensionFixture();
  const scope = await host([fixture.extension]).open(await root());
  const session = createSession(scope.workspaceRoot, "openai", "mock");
  session.messages = [
    text("user", "Keep API stable"),
    text("assistant", "history ".repeat(9000)),
    text("user", "Old follow-up"),
    text("assistant", "old answer"),
  ];
  const summaryRequests: ContextSummaryRequest[] = [];
  const counts: string[] = [];
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    providerId: "openai",
    getCapabilities: async () => ({
      tokenCounting: "provider",
      contextWindow: 5000,
    }),
    countTokens: async (request) => {
      counts.push(JSON.stringify(request.messages));
      return requestTokens(request.system, request.messages, request.tools);
    },
    async *streamChat(request) {
      requests.push(request);
      if (requests.length === 1) {
        scope.services.get(fixture.token).value = 1;
        yield { type: "error", code: "context_overflow", message: "Overflow" };
      } else
        yield {
          type: "turn_complete",
          message: text("assistant", "Done"),
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
    },
  };
  const manager = new ContextManager(
    { keepRecentTokens: 400 },
    undefined,
    undefined,
    async (input) => {
      summaryRequests.push(input);
      return {
        ...emptySummary(),
        goal: "Repair",
        userConstraints: ["Keep API stable"],
      };
    },
  );
  const result = await setup(scope, fixture, provider, session, manager).run(
    "Keep current constraints",
  );
  expect(result.status).toBe("completed");
  expect(summaryRequests.length).toBeGreaterThan(0);
  expect(JSON.stringify(summaryRequests)).not.toContain("EPHEMERAL_FIXTURE");
  expect(JSON.stringify(session.context?.activeCheckpoint)).not.toContain(
    "EPHEMERAL_FIXTURE",
  );
  expect(counts.every((value) => value.includes("EPHEMERAL_FIXTURE"))).toBe(
    true,
  );
  expect(counts.some((value) => value.includes("state=0"))).toBe(true);
  expect(fixture.snapshots).toHaveLength(2);
  expect(JSON.stringify(requests[1]?.messages[0])).toContain("state=1");
  expect(JSON.stringify(requests[1]?.messages)).toContain(
    "Keep current constraints",
  );
});

test("owned runPrompt closes extensions even when configuration fails before runtime", async () => {
  const fixture = extensionFixture();
  const path = await root();
  await writeFile(join(path, "config.json"), "{}");
  await expect(
    runPrompt(
      "No live LLM",
      {
        cwd: path,
        configPath: join(path, "config.json"),
        profile: "missing-profile",
      },
      { requestApproval: async () => "unavailable" },
      {},
      undefined,
      { extensions: [fixture.extension] },
    ),
  ).rejects.toThrow();
  expect(fixture.activations()).toBe(1);
  expect(fixture.services.get(path)?.disposed).toBe(1);
});

test("empty extensions preserve the baseline model request and transcript", async () => {
  const fixture = extensionFixture();
  const scope = await host([]).open(await root());
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    providerId: "openai",
    async *streamChat(request) {
      requests.push(request);
      yield {
        type: "turn_complete",
        message: text("assistant", "Done"),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const bus = new RuntimeEventBus("session");
  const session = createSession(scope.workspaceRoot, "openai", "mock");
  const runtime = new AgentRuntime(
    provider,
    new ContextManager(),
    { selectForTurn: () => [], execute: async () => [] },
    "Core",
    bus,
  );
  expect(
    (
      await runtime.run(session, "Original request", {
        contextProviders: contextCollection(scope, (text) => text),
      })
    ).status,
  ).toBe("completed");
  expect(requests[0]?.messages).toEqual([text("user", "Original request")]);
  expect(requests[0]?.system).not.toContain("Extension context");
  expect(fixture.activations()).toBe(0);
});

test("workspace shutdown during tool selection cancels before using the closed context port", async () => {
  const fixture = extensionFixture();
  const scope = await host([fixture.extension]).open(await root());
  const port = contextCollection(scope, (text) => text);
  const session = createSession(scope.workspaceRoot, "openai", "mock");
  let requests = 0;
  const provider: ProviderAdapter = {
    providerId: "openai",
    async *streamChat() {
      requests++;
      yield { type: "error", code: "unknown", message: "Unexpected" };
    },
  };
  const runtime = new AgentRuntime(
    provider,
    new ContextManager(),
    {
      selectForTurn: async () => {
        await scope.dispose();
        return [];
      },
      execute: async () => [],
    },
    "Core",
    new RuntimeEventBus(session.id),
  );
  expect(
    await runtime.run(session, "Request", {
      contextProviders: port,
      signal: scope.signal,
    }),
  ).toMatchObject({ status: "cancelled", errorCode: "CANCELLED" });
  expect(requests).toBe(0);
  expect(fixture.snapshots).toHaveLength(0);
});

for (const anthropic of [false, true])
  test(`${anthropic ? "Anthropic" : "OpenAI"} wire normalization preserves the leading context and all tool pairs`, async () => {
    let body: Record<string, unknown> | undefined;
    const options = {
      apiKey: "fixture",
      baseUrl: "https://offline.test",
      maxRetries: 0,
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          anthropic
            ? 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","role":"assistant","type":"message","model":"mock","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
            : 'data: {"id":"m","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    };
    const provider = anthropic
      ? new AnthropicProtocolAdapter(options)
      : new OpenAIProtocolAdapter(options);
    for await (const event of provider.streamChat({
      model: "mock",
      system: "Core",
      tools: [],
      maxTokens: 1024,
      messages: [
        text("user", "EPHEMERAL_FIXTURE reference data"),
        text("user", "Real request"),
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "read_file",
              input: { path: "a" },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "tool-1", content: "Read a" },
          ],
        },
      ],
    })) {
      expect(event.type).not.toBe("error");
    }
    const wire = JSON.stringify(body);
    if (!body) throw new Error("Provider request was not sent");
    expect(wire).toContain("EPHEMERAL_FIXTURE");
    expect(wire).toContain("Real request");
    expect(wire).toContain("Read a");
    expect(wire.match(/tool-1/g)).toHaveLength(2);
    expect(
      JSON.stringify(
        anthropic
          ? body.system
          : (body.messages as { role: string }[]).filter(
              (message) => message.role === "system",
            ),
      ),
    ).not.toContain("EPHEMERAL_FIXTURE");
  });
