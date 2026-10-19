import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChildAgent } from "../../src/app/subagent-runtime.js";
import {
  DEFAULT_PROJECT_CONFIG,
  loadGlobalConfig,
} from "../../src/config/load.js";
import { emptySummary } from "../../src/context/summary.js";
import { createSubagentExtension } from "../../src/extensions/builtins/subagents.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { attachExtensionTools } from "../../src/extensions/tools.js";
import { builtinDefinitions } from "../../src/providers/definitions/index.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { SecretRedactor } from "../../src/security/redaction.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { SubagentService } from "../../src/subagents/service.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import { WorktreeService } from "../../src/worktrees/service.js";

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-child-context-")),
);
for (const name of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[name] = join(directory, "home");
process.env.OPENAI_API_KEY = "fixture-context-key";
const root = join(directory, "project");
await mkdir(root);
await writeFile(join(root, "evidence.txt"), "ACTUAL_FILE_EVIDENCE\n");
const systemRules =
  "Сохраняй проверенные результаты и ограничения пользователя. ".repeat(1200);
let summaryCalls = 0,
  generations = 0;
const observedInputs: number[] = [];
const textResponse = (text: string) =>
  Response.json({
    id: "fixture",
    choices: [
      { message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 90000, completion_tokens: 2500 },
  });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.url.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "fixture-model",
            context_window: 262144,
            max_output_tokens: 65536,
          },
        ],
      });
    const body = (await request.json()) as {
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown[];
      max_completion_tokens?: number;
      max_tokens?: number;
      stream?: boolean;
    };
    const system = String(body.messages[0]?.content);
    const text = (value: string) => {
      if (!body.stream) return textResponse(value);
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: value }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 90000, completion_tokens: 2500 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    if (system.includes("Create a compact, factual handoff")) {
      summaryCalls++;
      return text(
        JSON.stringify({
          ...emptySummary(),
          goal: "Проверь evidence.txt и сохрани TASK_SENTINEL",
          nextAction: "Прочитай evidence.txt",
          userConstraints: ["Не изменять файлы"],
        }),
      );
    }
    generations++;
    observedInputs.push(Buffer.byteLength(JSON.stringify(body)) / 3);
    assert.equal(body.max_completion_tokens ?? body.max_tokens, 65536);
    assert.ok(JSON.stringify(body.messages).includes("TASK_SENTINEL"));
    if (generations <= 26)
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: Array.from({ length: 4 }, (_, index) => ({ index, id: `read-evidence-${generations}-${index}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "evidence.txt" }) } })) }, finish_reason: "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 90000, completion_tokens: 2500 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    assert.ok(
      body.messages.some(
        (message) =>
          message.role === "tool" &&
          String(message.content).includes("ACTUAL_FILE_EVIDENCE"),
      ),
    );
    return text(
      "TASK_SENTINEL: ACTUAL_FILE_EVIDENCE проверен. " +
        "Большой результат с сохранёнными проверенными данными. ".repeat(1800),
    );
  },
});
const configPath = join(directory, "global.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    profiles: {},
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
    subagents: {
      childTokens: 1,
      ownerTokens: 1,
      inputTokens: 1,
      outputTokens: 1,
      maxActive: 1,
      deadlineMs: 1,
      iterations: 1,
      attempts: 1,
      tools: 1,
    },
  }),
);
await writeFile(
  join(root, ".chiselrc"),
  JSON.stringify({
    context: { autoCompact: false, keepRecentTokens: 1000 },
    subagents: { childTokens: 1, ownerTokens: 1 },
  }),
);
const service = new SubagentService(new WorktreeService(), runChildAgent);
const host = new ExtensionHost([createSubagentExtension(service)]);
try {
  const global = await loadGlobalConfig(configPath);
  assert.deepEqual(Object.keys(global.subagents!).sort(), ["enabled"]);
  const scope = await host.open(root);
  const store = await projectSessionStore(root);
  const session = store.create("openai", "fixture-model");
  session.messages.push({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Справочные данные прошлого исследования. ".repeat(20000),
      },
    ],
  });
  await store.save(session);
  const definition = builtinDefinitions.find((item) => item.id === "openai")!;
  const resolver = { requestApproval: async () => "unavailable" as const };
  const port = await service.bind({
    session,
    store,
    root,
    conversationId: session.id,
    generation: 0,
    signal: new AbortController().signal,
    assertAvailable: () => scope.assertUsable(),
    scope,
    instructions: systemRules,
    config: DEFAULT_PROJECT_CONFIG,
    global,
    options: { configPath },
    approvalMode: "default",
    resolver,
    redactor: new SecretRedactor(),
    capturedModel: {
      definition,
      profileId: "fixture",
      profile: {
        providerId: "openai",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "fixture-model",
      capabilities: {
        contextWindow: 262144,
        maxOutputTokens: 65536,
        tokenCounting: "local_estimate",
      },
    },
  });
  const tools = createLocalToolRuntime(
    root,
    [],
    new ApprovalGate(
      DEFAULT_PROJECT_CONFIG,
      { autoApprove: false, allowedTools: new Set(), nonInteractive: true },
      resolver,
    ),
    session,
    [],
    { subagentTools: port },
  );
  const detach = await attachExtensionTools(scope, tools.catalog);
  try {
    const accepted = await tools.executor.execute({
      id: "large-context",
      name: "ext:builtin.subagents:submit_readonly",
      input: {
        task:
          "Прочитай evidence.txt. Сохрани TASK_SENTINEL. Не изменяй файлы. " +
          "Подробное поручение. ".repeat(500),
        label: "Большой контекст",
      },
    });
    assert.ok(!accepted.isError, accepted.output);
    const id = JSON.parse(accepted.output).id as string;
    const control = service.controlFor(session.id, session.id, 0);
    const [child] = await control.wait([id], 30000);
    assert.equal(child!.status, "completed", JSON.stringify(child!.error));
    assert.ok(
      summaryCalls > 0,
      JSON.stringify({
        reason: "A real model summary was not requested",
        observedInputs,
        context: child!.context,
      }),
    );
    assert.equal(generations, 27);
    assert.equal(child!.consumption.tools, 104);
    assert.equal(child!.consumption.iterations, 27);
    assert.ok(child!.attempts.length > 24);
    assert.ok(
      observedInputs.every((count) => count > 16000),
      JSON.stringify(observedInputs),
    );
    assert.ok(
      child!.spend.usage.inputTokens > 200000,
      "Old owner/child quotas still affect accounting",
    );
    assert.ok(child!.textTruncated);
    assert.ok(child!.artifact);
    const artifact = await tools.context.artifacts.read(
      child!.artifact!.uri,
      0,
      2000,
    );
    assert.ok(
      Buffer.byteLength(artifact) > 65536,
      "Full large result was lost",
    );
    assert.equal(
      await readFile(join(root, "evidence.txt"), "utf8"),
      "ACTUAL_FILE_EVIDENCE\n",
    );
    const childSession = await store.load(child!.sessionId!);
    assert.ok(childSession.context?.compactions?.length);
    assert.ok(!("limits" in child!));
    console.log(
      `Subagent context: ${summaryCalls} model summaries, ${generations} generations above 16000 tokens, provider output 65536, observed spend ${child!.spend.usage.inputTokens}, full artifact verified`,
    );
  } finally {
    detach.dispose();
  }
} finally {
  await service.dispose();
  await host.dispose();
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
