import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { ContextManager } from "../../src/context/context-manager.js";
import { partitionTranscript } from "../../src/context/partition.js";
import { OpenAIProtocolAdapter } from "../../src/providers/drivers/openai-chat.js";
import {
  AgentRuntime,
  type RuntimeOptions,
} from "../../src/runtime/agent-runtime.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { createSession } from "../../src/sessions/store.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "../../src/types/domain.js";
import { quoteShellArg } from "../helpers/shell.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chisel-provider-recovery-"));
  roots.push(root);
  const session = createSession(root, "openai-compatible", "mock");
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
  const tools = createLocalToolRuntime(root, [], gate, session, [], {
    events,
    artifactDirectory: join(root, ".artifacts"),
  });
  return {
    root,
    session,
    events,
    tools,
    run(
      provider: ProviderAdapter,
      signal?: AbortSignal,
      options: RuntimeOptions = {},
    ) {
      return new AgentRuntime(
        provider,
        new ContextManager({ maxOutputTokens: 4096 }, events),
        {
          selectForTurn: () => tools.catalog.selectForTurn(),
          execute: (calls, abort) => tools.scheduler.execute(calls, abort),
        },
        "system",
        events,
      ).run(session, "Create a landing page", { ...options, signal });
    },
  };
}
function completed(text = "Готово"): StreamEvent {
  return {
    type: "turn_complete",
    message: { role: "assistant", content: [{ type: "text", text }] },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}
for (const failure of ["invalid_tool_arguments", "output_truncated"] as const)
  test(`${failure}: regenerate without executing the rejected call or saving its prose`, async () => {
    const setup = await fixture();
    const requests: ProviderRequest[] = [];
    let recoveries = 0;
    setup.events.subscribe((event) => {
      if (event.type === "provider_response_recovery") recoveries++;
    });
    const content =
      '<h1>Привет!</h1>\n<script>const x = "C:\\\\tmp";</script>\n';
    const provider: ProviderAdapter = {
      providerId: "openai-compatible",
      async *streamChat(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "text_delta", text: "Rejected partial prose" };
          if (failure === "invalid_tool_arguments")
            yield { type: "error", code: failure, message: "Malformed JSON" };
          else
            yield {
              type: "turn_complete",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "rejected",
                    name: "write_file",
                    input: { path: "must-not-exist", content: "partial" },
                  },
                ],
              },
              stopReason: "length",
              usage: { inputTokens: 1, outputTokens: 4096 },
            };
        } else if (requests.length === 2) {
          yield {
            type: "turn_complete",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "valid",
                  name: "write_file",
                  input: { path: "landing.html", content },
                },
              ],
            },
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else yield completed();
      },
    };
    const result = await setup.run(provider);
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Готово");
    expect(await readFile(join(setup.root, "landing.html"), "utf8")).toBe(
      content,
    );
    expect(await readdir(setup.root)).not.toContain("must-not-exist");
    expect(requests).toHaveLength(3);
    expect(requests[1]?.system).toContain("valid JSON objects");
    expect(requests[1]?.system).toContain("small complete tool calls");
    expect(requests.every((request) => request.maxTokens === 4096)).toBe(true);
    expect(recoveries).toBe(1);
    expect(JSON.stringify(setup.session.messages)).not.toContain(
      "Rejected partial prose",
    );
    expect(setup.session.runtime?.invocations.rejected).toBeUndefined();
    expect(setup.session.runtime?.invocations.valid?.state).toBe("succeeded");
  });

test("recovery has a fixed limit and never executes malformed tool arguments", async () => {
  const setup = await fixture();
  let attempts = 0;
  const provider: ProviderAdapter = {
    providerId: "mock",
    async *streamChat() {
      attempts++;
      yield {
        type: "error",
        code: "invalid_tool_arguments",
        message: "Malformed JSON",
      };
    },
  };
  const result = await setup.run(provider);
  expect(attempts).toBe(3);
  expect(result).toMatchObject({
    status: "failed",
    errorCode: "invalid_tool_arguments",
  });
  expect(Object.keys(setup.session.runtime?.invocations ?? {})).toHaveLength(0);
  expect(await readdir(setup.root)).toEqual([]);
});

test("cancellation during recovery prevents a second provider call", async () => {
  const setup = await fixture();
  const abort = new AbortController();
  let attempts = 0;
  setup.events.subscribe((event) => {
    if (event.type === "provider_response_recovery") abort.abort();
  });
  const provider: ProviderAdapter = {
    providerId: "mock",
    async *streamChat() {
      attempts++;
      yield {
        type: "error",
        code: "output_truncated",
        message: "Limit reached",
      };
    },
  };
  const result = await setup.run(provider, abort.signal);
  expect(attempts).toBe(1);
  expect(result.status).toBe("cancelled");
  expect(await readdir(setup.root)).toEqual([]);
});

test("every registered tool rejects non-object input before preparing or executing", async () => {
  const setup = await fixture();
  const specs = setup.tools.catalog.selectForTurn();
  expect(specs.length).toBeGreaterThan(14);
  const events: string[] = [];
  setup.events.subscribe((event) => {
    events.push(event.type);
  });
  for (const [index, spec] of specs.entries()) {
    const result = await setup.tools.scheduler.execute([
      {
        id: `invalid-${index}`,
        name: spec.name,
        input: null as unknown as Record<string, unknown>,
      },
    ]);
    expect(result[0]).toMatchObject({
      isError: true,
      errorCode: "INVALID_TOOL_INPUT",
    });
  }
  expect(events).not.toContain("tool_prepared");
  expect(events).not.toContain("tool_started");
  expect(await readdir(setup.root)).toEqual([]);
});

test("real OpenAI SDK resumes after opaque HTTP 400 without replaying a completed file write", async () => {
  const setup = await fixture();
  setup.session.messages.push(
    { role: "user", content: [{ type: "text", text: "Начни" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "Подготовлю страницу" }],
    },
  );
  let calls = 0;
  let writes = 0;
  setup.events.subscribe((event) => {
    if (event.type === "tool_started") writes++;
  });
  const provider = new OpenAIProtocolAdapter({
    apiKey: "fixture",
    maxRetries: 0,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      for (const message of body.messages)
        if (message.role === "assistant" && message.tool_calls?.length === 0)
          return Response.json(
            { error: { message: "Empty tool_calls" } },
            { status: 400 },
          );
      calls++;
      if (calls === 2) return new Response("data: [DONE]\n\n", { status: 400 });
      const first = calls === 1;
      if (!first) {
        expect(
          body.messages.some(
            (message: { role: string; tool_call_id?: string }) =>
              message.role === "tool" && message.tool_call_id === "saved",
          ),
        ).toBe(true);
        expect(body.messages.at(-1).role).toBe("user");
      }
      const chunk = {
        choices: [
          {
            delta: first
              ? {
                  content: "Создам файл",
                  tool_calls: [
                    {
                      index: 0,
                      id: "saved",
                      type: "function",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({
                          path: "landing.html",
                          content: "<h1>Сохранено</h1>\n",
                        }),
                      },
                    },
                  ],
                }
              : { content: "Продолжил с сохранённого результата" },
            finish_reason: first ? "tool_calls" : "stop",
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  expect(await setup.run(provider)).toMatchObject({
    status: "failed",
    errorCode: "bad_request",
  });
  expect(calls).toBe(2);
  expect(await readFile(join(setup.root, "landing.html"), "utf8")).toBe(
    "<h1>Сохранено</h1>\n",
  );
  expect(setup.session.runtime?.invocations.saved?.state).toBe("succeeded");
  expect(await setup.run(provider)).toMatchObject({
    status: "completed",
    text: "Продолжил с сохранённого результата",
  });
  expect(calls).toBe(3);
  expect(writes).toBe(1);
});

test("SDK tool calls tolerate optional nulls and scalar strings without changing the command or replaying it", async () => {
  const setup = await fixture();
  const command = `${quoteShellArg(process.execPath)} -e ${quoteShellArg("console.log('Проверка инструмента')")}`;
  const input = {
    command,
    cwd: null,
    timeout: "10000",
    background: "false",
    taskKind: null,
    label: null,
    deadlineMs: null,
    outputBytes: null,
    readySignal: null,
    targetWorktreeId: null,
    retryOf: null,
  };
  let attempts = 0;
  let starts = 0;
  setup.events.subscribe((event) => {
    if (event.type === "tool_started") starts++;
  });
  const provider = new OpenAIProtocolAdapter({
    apiKey: "fixture",
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const first = attempts++ === 0;
      if (!first) {
        const result = body.messages.find(
          (message: { role: string }) => message.role === "tool",
        );
        expect(result.content).toContain("Проверка инструмента");
        expect(result.content).not.toContain("INVALID_TOOL_INPUT");
      }
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: first ? { tool_calls: [{ index: 0, id: "shell", type: "function", function: { name: "run_shell", arguments: JSON.stringify(input) } }] } : { content: "Готово" }, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  expect(await setup.run(provider)).toMatchObject({
    status: "completed",
    text: "Готово",
  });
  const record = setup.session.runtime?.invocations.shell;
  expect(record?.state).toBe("succeeded");
  expect(record?.input).toEqual(input);
  expect(record?.result?.details?.inputCorrections).toContain("timeout");
  const replay = await setup.tools.executor.execute({
    id: "shell",
    name: "run_shell",
    input,
  });
  expect(record?.result).toEqual(replay);
  expect(starts).toBe(1);
  expect(attempts).toBe(2);
}, 15000);

test("the model can correct a blocked call and continue with durable changes", async () => {
  const setup = await fixture();
  let attempts = 0;
  const provider: ProviderAdapter = {
    providerId: "fixture",
    async *streamChat() {
      attempts++;
      if (attempts === 6) {
        yield completed();
        return;
      }
      yield {
        type: "turn_complete",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `repair-${attempts}`,
              name: attempts === 5 ? "write_file" : "run_shell",
              input:
                attempts === 5 ? { path: "recovered.txt", content: "ok" } : {},
            },
          ],
        },
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  expect((await setup.run(provider)).status).toBe("completed");
  expect(attempts).toBe(6);
  expect(await readFile(join(setup.root, "recovered.txt"), "utf8")).toBe("ok");
});

for (const call of [
  { name: "run_shell", input: {} },
  { name: "search_files", input: { pattern: "TODO" } },
  {
    name: "run_shell",
    input: {
      command: "echo check",
      targetWorktreeId: "00000000-0000-0000-0000-000000000000",
    },
  },
])
  test(`runtime bounds repeated invalid ${call.name} calls and settles their protocol`, async () => {
    const setup = await fixture();
    let attempts = 0;
    const provider: ProviderAdapter = {
      providerId: "fixture",
      async *streamChat() {
        attempts++;
        yield {
          type: "turn_complete",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: `bad-${attempts}`, ...call }],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    expect(await setup.run(provider)).toMatchObject({
      status: "failed",
      errorCode: "REPEATED_CALL_DETECTED",
    });
    expect(attempts).toBe(5);
    expect(
      partitionTranscript(setup.session.messages).every(
        (unit) => !unit.pending,
      ),
    ).toBe(true);
    expect(await readdir(setup.root)).toEqual([]);
  });

test("an empty final response after tool commentary is retried rather than reported as completed", async () => {
  const setup = await fixture();
  let attempts = 0;
  const provider: ProviderAdapter = {
    providerId: "fixture",
    async *streamChat() {
      attempts++;
      if (attempts === 1) {
        yield { type: "text_delta", text: "Сейчас создам файл" };
        yield {
          type: "turn_complete",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Сейчас создам файл" },
              {
                type: "tool_use",
                id: "write-once",
                name: "write_file",
                input: { path: "ok.txt", content: "сохранено" },
              },
            ],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      } else yield completed(attempts === 2 ? "" : "Файл сохранён и проверен");
    },
  };
  const result = await setup.run(provider);
  expect(result.status).toBe("completed");
  expect(attempts).toBe(3);
  expect(result.text).toContain("Файл сохранён и проверен");
  expect(await readFile(join(setup.root, "ok.txt"), "utf8")).toBe("сохранено");
});

for (const recovery of [undefined, "new_child"] as const)
  test(`different tool failures are bounded without losing completed effects (${recovery ?? "foreground"})`, async () => {
    const setup = await fixture();
    let attempts = 0;
    const provider: ProviderAdapter = {
      providerId: "fixture",
      async *streamChat() {
        attempts++;
        const call =
          attempts === 1
            ? {
                name: "write_file",
                input: { path: "saved.txt", content: "saved" },
              }
            : attempts % 2
              ? { name: `github_missing_${attempts}`, input: {} }
              : { name: "run_shell", input: { cwd: `invalid-${attempts}` } };
        yield {
          type: "turn_complete",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: `varied-${attempts}`, ...call }],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const result = await setup.run(provider, undefined, { recovery });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("TOOL_FAILURE_LIMIT");
    expect(attempts).toBe(9);
    expect(await readFile(join(setup.root, "saved.txt"), "utf8")).toBe("saved");
    expect(setup.session.runtime?.invocations["varied-1"]?.state).toBe(
      "succeeded",
    );
    expect(
      partitionTranscript(setup.session.messages).every(
        (unit) => !unit.pending,
      ),
    ).toBe(true);
  });

test("a successful tool resets the failure streak so corrected work can finish", async () => {
  const setup = await fixture();
  await Bun.write(join(setup.root, "evidence.txt"), "verified");
  let attempts = 0;
  const provider: ProviderAdapter = {
    providerId: "fixture",
    async *streamChat() {
      attempts++;
      if (attempts === 16) {
        yield completed();
        return;
      }
      yield {
        type: "turn_complete",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `progress-${attempts}`,
              name: attempts === 8 ? "read_file" : `unknown_${attempts}`,
              input: { path: "evidence.txt" },
            },
          ],
        },
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  expect((await setup.run(provider)).status).toBe("completed");
  expect(attempts).toBe(16);
});
