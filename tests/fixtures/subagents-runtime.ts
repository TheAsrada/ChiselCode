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
import { testRender } from "@opentui/react/test-utils";
import { execa } from "execa";
import { act, createElement } from "react";
import { runExtensionCommand } from "../../src/app/run-command.js";
import { runPrompt } from "../../src/app/run-prompt.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiController } from "../../src/ui/tui-controller.js";

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-subagents-")),
);
const root = join(directory, "проект с пробелом");
await mkdir(root);
for (const name of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[name] = join(directory, "home");
process.env.OPENAI_API_KEY = "fixture-subagent-secret-key";
async function git(...args: string[]) {
  return (
    await execa(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: root },
    )
  ).stdout;
}
await git("init", "--initial-branch=main");
await writeFile(join(root, "same.txt"), "committed base\n");
await git("add", "same.txt");
await git("commit", "-m", "base");
const initialBranches = await git(
  "for-each-ref",
  "--format=%(refname)",
  "refs/heads",
);
await writeFile(join(root, "unrelated.txt"), "dirty origin remains\n");
type RequestBody = {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
  max_tokens?: number;
  max_completion_tokens?: number;
};
const requests: RequestBody[] = [];
const childRoots = new Map<string, { count: number; task: string }>();
let parentCalls = 0;
let releaseParent = () => {};
let parentHeld = false;
const parentBarrier = new Promise<void>((resolve) => {
  releaseParent = resolve;
});
const completed = new Set<string>();
const controller = new TuiController(root);
controller.setDraft("Родительский черновик во время делегирования");
const ui = await testRender(
  createElement(OpenTuiSpike, { controller, onExit: () => {} }),
  { width: 120, height: 40, exitOnCtrlC: false },
);
async function capture(name: string) {
  const folder = process.env.CHISEL_CAPTURE_DIR;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await act(async () => {
    await ui.renderOnce();
    await ui.renderOnce();
  });
  await writeFile(join(folder, name + ".txt"), ui.captureCharFrame());
  const spans = ui.captureSpans();
  await writeFile(
    join(folder, name + ".json"),
    JSON.stringify({
      ...spans,
      lines: spans.lines.map((line) => ({
        spans: line.spans.map((span) => ({
          ...span,
          fg: span.fg.toInts(),
          bg: span.bg.toInts(),
        })),
      })),
    }),
  );
}

const toolResponse = (
  calls: Array<{ name: string; input: unknown; id: string }>,
) =>
  new Response(
    `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) }, finish_reason: "tool_calls" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 150, completion_tokens: 25 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
const textResponse = (text: string) =>
  new Response(
    `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "fixture-model",
            context_window: 65536,
            max_output_tokens: 4096,
          },
        ],
      });
    const body = (await request.json()) as RequestBody;
    requests.push(body);
    const system = String(body.messages[0]?.content);
    if (system.includes("Поручение выполняется отдельным помощником.")) {
      assert.ok(
        (body.max_completion_tokens ?? body.max_tokens ?? Infinity) <= 2048,
      );
      assert.ok(
        !body.tools?.some((tool) =>
          /submit_|git_commit|worktree|create_skill/.test(tool.function.name),
        ),
      );
      const cwd = /Working directory: ([^\n]+)/.exec(system)?.[1];
      assert.ok(cwd);
      const task = String(
        body.messages.find((message) => message.role === "user")?.content,
      );
      const state = childRoots.get(cwd) ?? { count: 0, task };
      childRoots.set(cwd, state);
      state.count++;
      if (state.count === 1)
        return toolResponse([
          {
            id: `read-${childRoots.size}`,
            name: "read_file",
            input: { path: "same.txt" },
          },
        ]);
      if (state.count === 2)
        return toolResponse([
          {
            id: `edit-${childRoots.size}`,
            name: "edit_file",
            input: {
              path: "same.txt",
              old_str: "committed base",
              new_str: task.includes("первый")
                ? "first isolated result"
                : "second isolated result",
            },
          },
        ]);
      const last = body.messages
        .filter((message) => message.role === "tool")
        .at(-1);
      assert.ok(!String(last?.content).includes("isError"));
      return textResponse(
        "Работа помощника завершена. Файл изменён через core editing; тесты не запускались.",
      );
    }
    parentCalls++;
    if (parentCalls === 1) {
      const name = body.tools?.find((tool) =>
        tool.function.name.includes("submit_coding"),
      )?.function.name;
      assert.ok(name, "Production delegation schema missing");
      return toolResponse([
        {
          id: "delegate-one",
          name,
          input: {
            task: "Сделай первый независимый результат",
            label: "Первая задача",
            context: "none",
          },
        },
        {
          id: "delegate-two",
          name,
          input: {
            task: "Сделай второй независимый результат",
            label: "Вторая задача",
            context: "none",
          },
        },
      ]);
    }
    assert.equal(
      body.messages.filter((message) => message.role === "tool").length,
      2,
    );
    parentHeld = true;
    await parentBarrier;
    assert.equal(
      completed.size,
      2,
      "Children did not complete while foreground was held",
    );
    return textResponse(
      "Основной агент продолжил работу; ответы помощников не вставлены в его историю.",
    );
  },
});
const configPath = join(directory, "global.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    defaultProfileId: "fixture",
    profiles: {
      fixture: {
        providerId: "openai-compatible",
        defaultModel: "fixture-model",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
    },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);
try {
  const { result, exitCode } = await runPrompt(
    "Поручи двум помощникам независимые изменения",
    {
      cwd: root,
      configPath,
      allow:
        "ext:builtin.subagents:submit_coding,ext:builtin.subagents:prepare_worktree,edit_file",
      json: true,
    },
    { requestApproval: async () => "unavailable" },
    {
      onText: (text) => controller.appendToLast(text),
      onToolStart: () => {},
      onToolResult: () => {},
      onConversation: (source) => controller.setSessionId(source.sessionId),
      onSubagentControls: (controls) =>
        controller.setSubagentControls(controls),
      onSubagent: (event) => {
        controller.acceptSubagent(event);
        if (event.type === "terminal") {
          assert.ok(
            parentHeld,
            "Foreground must be running when child finishes",
          );
          completed.add(event.child.id);
          if (completed.size === 2) releaseParent();
        }
      },
    },
  );
  assert.equal(exitCode, 0, JSON.stringify(result));
  await act(async () => {
    controller.setSessionUsage(result.session);
    controller.setAgentSidebar("agents", true);
    ui.mockInput.pressKey("F7");
    ui.mockInput.pressKey("ARROW_DOWN");
  });
  await capture("production-120x40-tree");
  await act(async () => {
    ui.mockInput.pressKey("RETURN");
  });
  await capture("production-120x40-details");
  const records = Object.values(result.session.children ?? {}).map(
    (receipt) => receipt.child,
  );
  assert.equal(records.length, 2);
  assert.ok(
    records.every(
      (record) => record.status === "completed" && record.cleanup.quiescent,
    ),
    JSON.stringify(records),
  );
  assert.equal(childRoots.size, 2);
  assert.equal(
    await readFile(join(root, "same.txt"), "utf8"),
    "committed base\n",
  );
  assert.equal(
    await readFile(join(root, "unrelated.txt"), "utf8"),
    "dirty origin remains\n",
  );
  const contents = await Promise.all(
    records.map((record) => readFile(join(record.root!, "same.txt"), "utf8")),
  );
  assert.deepEqual(
    new Set(contents),
    new Set(["first isolated result\n", "second isolated result\n"]),
  );
  assert.equal(
    await git("for-each-ref", "--format=%(refname)", "refs/heads"),
    initialBranches,
  );
  const parentStore = await projectSessionStore(root);
  const persisted = await parentStore.load(result.session.id);
  assert.equal(Object.keys(persisted.children ?? {}).length, 2);
  assert.ok(
    !JSON.stringify(persisted.messages).includes("Работа помощника завершена"),
  );
  assert.equal(
    persisted.totalTokens.inputTokens,
    150 + 120 + 2 * (2 * 150 + 120),
  );
  for (const record of records) {
    const session = await (await projectSessionStore(record.root!)).load(
      record.sessionId!,
    );
    assert.equal(session.subagent?.ownerId, persisted.id);
    assert.ok(
      session.messages.some((message) =>
        message.content.some((block) => block.type === "tool_result"),
      ),
    );
    assert.ok(!JSON.stringify(session).includes("fixture-subagent-secret-key"));
    assert.equal(session.totalTokens.inputTokens, 420);
  }
  const originalHead = await git("rev-parse", "HEAD");
  const originalIndex = await git("ls-files", "--stage");
  const host = new ExtensionHost(defaultExtensions([], { configPath }));
  try {
    const scope = await host.open(root);
    const command = scope.commands.get("worktree");
    const action = (argumentsText: string) =>
      runExtensionCommand(
        { command, input: command.parse(argumentsText) },
        scope,
        {
          cwd: root,
          configPath,
          resume: result.session.id,
          allow: "ext:builtin.worktrees:apply",
          json: true,
        },
        { requestApproval: async () => "approved" },
      );
    const first = records.find((record) => record.label === "Первая задача")!;
    const second = records.find((record) => record.label === "Вторая задача")!;
    const diff = await action(`diff ${first.worktree!.id}`);
    assert.ok(diff.result.output.includes("same.txt"));
    const applied = await action(`apply ${first.worktree!.id}`);
    assert.ok(!applied.result.isError, applied.result.output);
    assert.equal(
      await readFile(join(root, "same.txt"), "utf8"),
      "first isolated result\n",
    );
    const conflict = await action(`apply ${second.worktree!.id}`);
    assert.ok(
      conflict.result.isError,
      "Второй результат не должен перезаписывать конфликт",
    );
    assert.equal(
      await readFile(join(root, "same.txt"), "utf8"),
      "first isolated result\n",
    );
    const repeated = await action(`apply ${first.worktree!.id}`);
    assert.ok(!repeated.result.isError, repeated.result.output);
    assert.equal(await git("rev-parse", "HEAD"), originalHead);
    assert.equal(await git("ls-files", "--stage"), originalIndex);
    assert.equal(
      await readFile(join(root, "unrelated.txt"), "utf8"),
      "dirty origin remains\n",
    );
    assert.equal(
      await readFile(join(second.root!, "same.txt"), "utf8"),
      "second isolated result\n",
    );
    const after = await parentStore.load(result.session.id);
    assert.equal(
      after.totalTokens.inputTokens,
      persisted.totalTokens.inputTokens,
    );
    assert.equal(Object.keys(after.children ?? {}).length, 2);
  } finally {
    await host.dispose();
  }
  console.log(
    "Subagents runtime: two production model/tool loops, isolated edits, durable records, independent accounting",
  );
} finally {
  releaseParent();
  server.stop(true);
  await act(async () => ui.renderer.destroy());
  controller.dispose();
  await rm(directory, { recursive: true, force: true });
}
