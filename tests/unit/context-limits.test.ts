import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { contextBudget } from "../../src/context/budget.js";
import { ContextManager } from "../../src/context/context-manager.js";
import { requestTokens } from "../../src/context/tokenizer.js";
import { DEFAULT_CONTEXT_OPTIONS } from "../../src/context/types.js";
import { contextProgress } from "../../src/core/context-usage.js";
import { AnthropicProtocolAdapter } from "../../src/providers/drivers/anthropic-messages.js";
import { OpenAIProtocolAdapter } from "../../src/providers/drivers/openai-chat.js";
import {
  catalogModelLimits,
  modelInfo,
} from "../../src/providers/model-metadata.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { SessionV3Schema } from "../../src/sessions/schema.js";
import { createSession } from "../../src/sessions/store.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
  ToolDefinition,
} from "../../src/types/domain.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const metadata = {
  contextWindow: 1_000_000,
  maxOutputTokens: 384_000,
  tokenCounting: "local_estimate" as const,
  limitsSource: "provider" as const,
};
const emptyProvider: ProviderAdapter = {
  providerId: "openai-compatible",
  async *streamChat() {},
};
const schema: ToolDefinition = {
  name: "read_file",
  description: "Read the project file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  requiresApproval: false,
};
function completion(text = "Готово", input = 500, output = 100): Response {
  return sse([
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: input, completion_tokens: output } },
  ]);
}
function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function collect(provider: ProviderAdapter, maxTokens?: number) {
  const events: StreamEvent[] = [];
  for await (const event of provider.streamChat({
    model: "custom",
    system: "system",
    messages: [],
    tools: [],
    maxTokens,
  }))
    events.push(event);
  return events;
}

test("exact gateway alias has documented Fireworks limits; unknown families stay unknown", () => {
  expect(
    catalogModelLimits("openai-compatible", "deepseek-v4p1-flash"),
  ).toMatchObject({
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    limitsSource: "catalog",
  });
  expect(catalogModelLimits("openai", "gpt-5")).toMatchObject({
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
  });
  expect(
    catalogModelLimits("openai-compatible", "deepseek-v4p1-flash-special"),
  ).toEqual({});
  expect(catalogModelLimits("openai-compatible", "my-gpt-5")).toEqual({});
});

test("API deployment limits take priority over catalog; compatible metadata names are recognized", () => {
  expect(
    modelInfo(
      { id: "deepseek-v4p1-flash", context: 128_000, max_output: 32_000 },
      "openai-compatible",
    ),
  ).toMatchObject({
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    limitsSource: "provider",
  });
  expect(
    modelInfo({ id: "local", max_model_len: 16_384 }, "openai-compatible")
      ?.contextWindow,
  ).toBe(16_384);
  expect(
    modelInfo(
      {
        id: "remote",
        context_length: 200_000,
        top_provider: {
          context_length: 128_000,
          max_completion_tokens: 64_000,
        },
      },
      "openai-compatible",
    ),
  ).toMatchObject({ contextWindow: 128_000, maxOutputTokens: 64_000 });
  expect(
    modelInfo(
      { id: "claude", max_input_tokens: 200_000, max_tokens: 64_000 },
      "anthropic",
    ),
  ).toMatchObject({
    contextWindow: 200_000,
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
  });
  expect(
    modelInfo(
      { id: "unknown", context: -1, max_output: "8192" },
      "openai-compatible",
    )?.contextWindow,
  ).toBeUndefined();
});

test("full model output replaces 4096 and window/4 ceilings, and shrinks with available space", () => {
  expect(
    contextBudget(metadata, DEFAULT_CONTEXT_OPTIONS, undefined, 50_000)
      .maxOutputTokens,
  ).toBe(384_000);
  expect(
    contextBudget(metadata, DEFAULT_CONTEXT_OPTIONS, undefined, 800_000)
      .maxOutputTokens,
  ).toBe(100_000);
  expect(
    contextBudget(metadata, {
      ...DEFAULT_CONTEXT_OPTIONS,
      maxOutputTokens: 600_000,
    }).maxOutputTokens,
  ).toBe(384_000);
  expect(
    contextBudget(metadata, {
      ...DEFAULT_CONTEXT_OPTIONS,
      maxOutputTokens: 20_000,
    }).maxOutputTokens,
  ).toBe(20_000);
  expect(
    contextBudget(metadata, {
      ...DEFAULT_CONTEXT_OPTIONS,
      contextWindow: 2_000_000,
    }).contextWindow,
  ).toBe(1_000_000);
  expect(
    contextBudget(
      { ...metadata, maxInputTokens: 272_000 },
      DEFAULT_CONTEXT_OPTIONS,
    ).maxInputTokens,
  ).toBe(272_000);
  expect(
    contextBudget({ tokenCounting: "local_estimate" }, DEFAULT_CONTEXT_OPTIONS)
      .maxOutputTokens,
  ).toBeUndefined();
});

test("model metadata uses the configured API once and falls back without a generation call", async () => {
  const calls: string[] = [];
  const provider = new OpenAIProtocolAdapter({
    apiKey: "mock",
    baseUrl: "http://fixture/v1",
    fetch: async (url) => {
      calls.push(String(url));
      return Response.json({
        data: [
          {
            id: "deepseek-v4p1-flash",
            context_length: 128_000,
            max_output_tokens: 32_000,
          },
        ],
      });
    },
  });
  expect(await provider.getCapabilities("deepseek-v4p1-flash")).toMatchObject({
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
    limitsSource: "provider",
  });
  await provider.getCapabilities("unknown");
  expect(calls).toEqual(["http://fixture/v1/models"]);
  const denied = new OpenAIProtocolAdapter({
    apiKey: "mock",
    baseUrl: "http://fixture/v1",
    fetch: async () =>
      Response.json({ error: { message: "denied" } }, { status: 401 }),
  });
  expect(await denied.getCapabilities("deepseek-v4p1-flash")).toMatchObject({
    contextWindow: 1_000_000,
    limitsSource: "catalog",
  });
});

test("Anthropic-compatible metadata is available independently of native token counting", async () => {
  let calls = 0;
  const provider = new AnthropicProtocolAdapter({
    apiKey: "mock",
    baseUrl: "http://fixture",
    providerId: "anthropic-compatible",
    nativeTokenCounting: false,
    fetch: async () => {
      calls++;
      return Response.json({
        id: "custom",
        type: "model",
        display_name: "Custom",
        max_input_tokens: 100_000,
        max_tokens: 16_000,
      });
    },
  });
  expect(await provider.getCapabilities("custom")).toMatchObject({
    contextWindow: 100_000,
    maxOutputTokens: 16_000,
    tokenCounting: "local_estimate",
  });
  await provider.getCapabilities("custom");
  expect(calls).toBe(1);
});

test("unknown OpenAI model leaves output limit to provider instead of imposing 4096", async () => {
  let body: Record<string, unknown> = {};
  const provider = new OpenAIProtocolAdapter({
    apiKey: "mock",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return completion();
    },
  });
  expect((await collect(provider)).at(-1)?.type).toBe("turn_complete");
  expect(body.max_completion_tokens).toBeUndefined();
  expect(body.max_tokens).toBeUndefined();
  expect(body.stream_options).toEqual({ include_usage: true });
});

test("compatible usage and token parameter fallbacks preserve output budget without replaying accepted requests", async () => {
  const bodies: Record<string, unknown>[] = [];
  const provider = new OpenAIProtocolAdapter({
    apiKey: "mock",
    tokenLimitFallback: true,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.stream_options)
        return Response.json(
          { error: { message: "Unsupported parameter: stream_options" } },
          { status: 400 },
        );
      if (body.max_completion_tokens)
        return Response.json(
          {
            error: { message: "Unsupported parameter: max_completion_tokens" },
          },
          { status: 400 },
        );
      return completion();
    },
  });
  const events = await collect(provider, 32_000);
  expect(events.at(-1)).toMatchObject({
    type: "turn_complete",
    usage: { inputTokens: 500 },
  });
  expect(bodies).toHaveLength(3);
  expect(bodies.at(-1)?.max_tokens).toBe(32_000);
  await collect(provider, 32_000);
  expect(
    bodies.slice(3).every((body) => body.stream_options === undefined),
  ).toBe(true);
});

test("prepared context counts instructions and schemas; native failure visibly falls back to estimate", async () => {
  const session = createSession("/project", "openai-compatible", "custom");
  session.messages = [
    { role: "user", content: [{ type: "text", text: "Привет" }] },
  ];
  const manager = new ContextManager();
  const frame = await manager.build({
    session,
    system: "Rules ".repeat(100),
    tools: [schema],
    provider: {
      ...emptyProvider,
      countTokens: async () => {
        throw new Error("Counter unavailable");
      },
    },
    capabilities: { ...metadata, tokenCounting: "provider" },
  });
  expect(frame.estimatedInputTokens).toBe(
    requestTokens(frame.system, frame.messages, frame.tools),
  );
  expect(session.contextSnapshot).toMatchObject({
    occupiedTokens: frame.estimatedInputTokens,
    contextWindow: 1_000_000,
    status: "estimated",
  });
  expect(contextProgress(session.contextSnapshot).label).toContain("~");
  const exact = await manager.build({
    session,
    system: "Rules",
    tools: [schema],
    provider: { ...emptyProvider, countTokens: async () => 1234 },
    capabilities: { ...metadata, tokenCounting: "provider" },
  });
  expect(exact.estimatedInputTokens).toBe(1234);
  expect(session.contextSnapshot).toMatchObject({
    occupiedTokens: 1234,
    source: "count_tokens",
    status: "observed",
  });
});

test("final context uses measured prompt plus retained reply, not cumulative spend or hidden output tokens", async () => {
  const session = createSession("/project", "openai-compatible", "custom");
  session.totalTokens.inputTokens = 1_000_000;
  const events = new RuntimeEventBus(session.id);
  const snapshots: number[] = [];
  events.subscribe((event) => {
    if (event.contextSnapshot?.occupiedTokens !== undefined)
      snapshots.push(event.contextSnapshot.occupiedTokens);
  });
  let request: ProviderRequest | undefined;
  const provider: ProviderAdapter = {
    ...emptyProvider,
    getCapabilities: async () => metadata,
    async *streamChat(input) {
      request = input;
      yield {
        type: "turn_complete",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Привет!" }],
        },
        stopReason: "end_turn",
        usage: { inputTokens: 500, outputTokens: 100_000 },
      };
    },
  };
  const result = await new AgentRuntime(
    provider,
    new ContextManager({}, events),
    { selectForTurn: async () => [schema], execute: async () => [] },
    "Rules",
    events,
  ).run(session, "Привет");
  expect(result.status).toBe("completed");
  if (!request) throw new Error("No request");
  const delta =
    requestTokens(request.system, session.messages, request.tools) -
    requestTokens(request.system, request.messages, request.tools);
  expect(session.contextSnapshot).toMatchObject({
    occupiedTokens: 500 + delta,
    observedInputTokens: 500,
    contextWindow: 1_000_000,
    status: "estimated",
  });
  expect(snapshots).toHaveLength(2);
  expect(session.totalTokens.inputTokens).toBe(1_000_500);
  expect(session.contextSnapshot?.occupiedTokens).toBeLessThan(1000);
});

test("compaction resets calibration and lowers current context without lowering session spend", async () => {
  const session = createSession("/project", "openai-compatible", "custom");
  session.messages = [
    { role: "user", content: [{ type: "text", text: "Keep the API stable" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "a",
          name: "read_file",
          input: { path: "log.txt" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "a",
          content: "Large log\n".repeat(4000),
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Continue" }] },
  ];
  session.totalTokens.inputTokens = 1_000_000;
  session.contextSnapshot = {
    model: "custom",
    observedInputTokens: 20_000,
    occupiedTokens: 20_000,
    localTokens: requestTokens("Rules", session.messages, []),
    source: "provider_usage",
    status: "observed",
    observedAt: new Date().toISOString(),
  };
  const original = JSON.stringify(session.messages);
  const manager = new ContextManager({ keepRecentTokens: 100 });
  await manager.emergencyCompact(session);
  const frame = await manager.build({
    session,
    system: "Rules",
    tools: [],
    provider: emptyProvider,
    capabilities: metadata,
  });
  expect(session.contextSnapshot?.occupiedTokens).toBe(frame.localInputTokens);
  expect(session.contextSnapshot?.occupiedTokens).toBeLessThan(2000);
  expect(JSON.stringify(session.messages)).toBe(original);
  expect(session.totalTokens.inputTokens).toBe(1_000_000);
});

test("cancelled native counting never falls through to a generation request", async () => {
  const abort = new AbortController();
  const session = createSession("/project", "anthropic", "custom");
  await expect(
    new ContextManager().build({
      session,
      system: "Rules",
      tools: [],
      signal: abort.signal,
      capabilities: { ...metadata, tokenCounting: "provider" },
      provider: {
        ...emptyProvider,
        countTokens: async () => {
          abort.abort();
          throw new Error("Cancelled");
        },
      },
    }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
});

test("current snapshot persists in v3 sessions and occupancy wins over last prompt", () => {
  const session = createSession("/project", "openai-compatible", "custom");
  session.contextSnapshot = {
    model: "custom",
    observedInputTokens: 100,
    occupiedTokens: 2000,
    localTokens: 1800,
    contextWindow: 10_000,
    windowSource: "provider",
    source: "local_estimate",
    status: "estimated",
    observedAt: new Date().toISOString(),
  };
  const persisted = SessionV3Schema.parse({ ...session, schemaVersion: 3 });
  expect(persisted.contextSnapshot).toEqual(session.contextSnapshot);
  expect(contextProgress(persisted.contextSnapshot)).toMatchObject({
    barPercent: 20,
  });
  expect(contextProgress(persisted.contextSnapshot).label).toContain("~20%");
  expect(
    contextProgress({ ...session.contextSnapshot, contextWindow: undefined })
      .barPercent,
  ).toBeUndefined();
});

test("old history is compacted for output headroom before output is reduced to a tiny response", async () => {
  const session = createSession("/project", "openai-compatible", "custom");
  session.messages = [
    { role: "user", content: [{ type: "text", text: "Keep API stable" }] },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "a",
          name: "read_file",
          input: { path: "log" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "a", content: "log ".repeat(6000) },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Continue" }] },
    { role: "user", content: [{ type: "text", text: "Now finish" }] },
  ];
  const manager = new ContextManager({ keepRecentTokens: 100 });
  const frame = await manager.build({
    session,
    system: "Rules",
    tools: [],
    provider: emptyProvider,
    capabilities: { ...metadata, contextWindow: 10_000, maxOutputTokens: 4000 },
  });
  expect(frame.checkpoint).toBeDefined();
  expect(frame.budget.maxOutputTokens).toBe(4000);
  expect(frame.estimatedInputTokens).toBeLessThan(2000);
});

test("late metadata, context events and request completion cannot overwrite the next connection", () => {
  const controller = new TuiController("/project");
  const old = {
    provider: "openai-compatible",
    model: "deepseek-v4p1-flash",
    profileId: "work",
    baseUrl: "https://old/v1",
  };
  controller.setActiveModel(
    old.provider,
    old.model,
    old.profileId,
    old.baseUrl,
  );
  expect(controller.snapshot.modelCapabilities?.contextWindow).toBe(1_000_000);
  controller.setActiveModel(
    old.provider,
    old.model,
    old.profileId,
    "https://new/v1",
  );
  controller.setModelCapabilities(old, { ...metadata, contextWindow: 1000 });
  const session = createSession("/project", old.provider, old.model);
  session.profileId = old.profileId;
  session.contextSnapshot = {
    model: old.model,
    observedInputTokens: 500,
    contextWindow: 1000,
    source: "provider_usage",
    status: "observed",
    observedAt: new Date().toISOString(),
  };
  controller.setContextSnapshot(old, session.contextSnapshot);
  controller.setSessionUsage(session, old);
  expect(controller.snapshot.contextSnapshot).toBeUndefined();
  expect(controller.snapshot.usage?.contextSnapshot).toBeUndefined();
  expect(controller.snapshot.modelCapabilities?.contextWindow).toBe(1_000_000);
  controller.setActiveModel("openai-compatible", "unknown");
  expect(controller.snapshot.modelCapabilities?.contextWindow).toBeUndefined();
  controller.dispose();
});

test("new conversation keeps API model limits while clearing prior occupancy", () => {
  const workspace = new TuiWorkspace("/project");
  const tab = workspace.newTab();
  tab.setActiveModel("openai-compatible", "custom", "work");
  const selection = tab.snapshot.modelSelection;
  if (!selection) throw new Error("No selection");
  tab.setModelCapabilities(selection, { ...metadata, contextWindow: 128_000 });
  tab.setContextSnapshot(selection, {
    model: "custom",
    observedInputTokens: 8000,
    occupiedTokens: 9000,
    contextWindow: 128_000,
    source: "local_estimate",
    status: "estimated",
    observedAt: new Date().toISOString(),
  });
  const home = workspace.newDraft();
  expect(home.snapshot.modelCapabilities?.contextWindow).toBe(128_000);
  expect(home.snapshot.contextSnapshot).toBeUndefined();
  workspace.dispose();
});

test("provider token calibration is discarded when the endpoint changes for the same model", async () => {
  const session = createSession("/project", "openai-compatible", "custom");
  session.messages = [
    { role: "user", content: [{ type: "text", text: "Hi" }] },
  ];
  const input = {
    session,
    system: "Rules",
    tools: [schema],
    provider: emptyProvider,
    capabilities: metadata,
  };
  await new ContextManager({}, undefined, "old-endpoint").build(input);
  if (!session.contextSnapshot) throw new Error("No snapshot");
  session.contextSnapshot.occupiedTokens = 50_000;
  const same = await new ContextManager({}, undefined, "old-endpoint").build(
    input,
  );
  expect(same.estimatedInputTokens).toBe(50_000);
  const next = await new ContextManager({}, undefined, "new-endpoint").build(
    input,
  );
  expect(next.estimatedInputTokens).toBe(next.localInputTokens);
  expect(session.contextSnapshot.connectionId).toBe("new-endpoint");
});

test("large HTML tool response exceeding the old cap is written completely using API model limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-large-output-"));
  roots.push(root);
  const session = createSession(root, "openai-compatible", "custom");
  const events = new RuntimeEventBus(session.id);
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    {
      approvalMode: "bypassPermissions",
      allowBypassPermissions: true,
      autoApprove: false,
      allowedTools: new Set(),
      nonInteractive: true,
    },
    { requestApproval: async () => "unavailable" },
  );
  const local = createLocalToolRuntime(root, [], gate, session, [], {
    events,
    artifactDirectory: join(root, ".artifacts"),
  });
  const content = `<!doctype html>\n<html lang="ru"><body>\n${'<section class="card">Привет &quot;HTML&quot;</section>\n'.repeat(800)}</body></html>\n`;
  const bodies: Record<string, unknown>[] = [];
  const provider = new OpenAIProtocolAdapter({
    apiKey: "mock",
    baseUrl: "http://fixture/v1",
    providerId: "openai-compatible",
    fetch: async (url, init) => {
      if (String(url).endsWith("/models"))
        return Response.json({
          data: [
            {
              id: "custom",
              context_length: 128_000,
              max_output_tokens: 32_000,
            },
          ],
        });
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length > 1) return completion("Файл готов", 22_000);
      const args = JSON.stringify({ path: "landing.html", content });
      const chunks: unknown[] = [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "write-html",
                    type: "function",
                    function: { name: "write_file", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
      ];
      for (let offset = 0; offset < args.length; offset += 257)
        chunks.push({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: args.slice(offset, offset + 257) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      chunks.push(
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        {
          choices: [],
          usage: { prompt_tokens: 1200, completion_tokens: 20_000 },
        },
      );
      return sse(chunks);
    },
  });
  const result = await new AgentRuntime(
    provider,
    new ContextManager({}, events),
    {
      selectForTurn: () => local.catalog.selectForTurn(),
      execute: (calls, signal) => local.scheduler.execute(calls, signal),
    },
    "Write the complete file",
    events,
  ).run(session, "Создай HTML");
  expect(result.status).toBe("completed");
  expect(await readFile(join(root, "landing.html"), "utf8")).toBe(content);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]?.max_completion_tokens).toBe(32_000);
  expect(result.session.contextSnapshot).toMatchObject({
    contextWindow: 128_000,
    windowSource: "provider",
    status: "estimated",
  });
  expect(result.session.contextSnapshot?.occupiedTokens).toBeGreaterThan(
    22_000,
  );
});
