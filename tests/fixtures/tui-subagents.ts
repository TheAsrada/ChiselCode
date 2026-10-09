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
import { createTestRenderer } from "@opentui/core/testing";
import { execa } from "execa";
import { act } from "react";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

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
let partialSent = false;
let releasePartial = () => {};
const partialBarrier = new Promise<void>((resolve) => {
  releasePartial = resolve;
});
const parentBarrier = new Promise<void>((resolve) => {
  releaseParent = resolve;
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ui = await createTestRenderer({
  width: 120,
  height: 40,
  exitOnCtrlC: false,
});
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
  idleTimeout: 0,
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
      const key = task.includes("только чтение") ? cwd + ":readonly" : cwd;
      const state = childRoots.get(key) ?? { count: 0, task };
      childRoots.set(key, state);
      state.count++;
      if (state.count === 1)
        return toolResponse([
          {
            id: `read-${childRoots.size}`,
            name: "read_file",
            input: { path: "same.txt" },
          },
        ]);
      if (task.includes("только чтение")) {
        assert.ok(
          !body.tools?.some((tool) =>
            /^(edit_file|run_shell|write_file)$/.test(tool.function.name),
          ),
        );
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(stream) {
              stream.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Чтение выполнено. Частичный ответ сохранится после остановки. " + "Наблюдение без изменений. ".repeat(30) }, finish_reason: null }] })}\n\n`,
                ),
              );
              partialSent = true;
              await partialBarrier;
              try {
                stream.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
                  ),
                );
                stream.close();
              } catch {}
            },
            cancel() {
              releasePartial();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
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
      const readonly = body.tools?.find((tool) =>
        tool.function.name.includes("submit_readonly"),
      )?.function.name;
      assert.ok(readonly);
      return toolResponse([
        {
          id: "delegate-reader",
          name: readonly,
          input: {
            task: "Выполни только чтение и дождись остановки",
            label: "Обзор без изменений",
            context: "none",
          },
        },
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
        {
          id: "delegate-stop-approval",
          name,
          input: {
            task: "Подготовь изменение, но дождись отдельного разрешения",
            label: "Остановка при разрешении",
            context: "none",
          },
        },
      ]);
    }
    assert.equal(
      body.messages.filter((message) => message.role === "tool").length,
      4,
    );
    parentHeld = true;
    await parentBarrier;
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

async function frame() {
  await act(async () => {
    await ui.renderOnce();
  });
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  label: string,
) {
  for (let i = 0; i < 1500; i++) {
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
    if (await predicate()) return;
  }
  throw new Error(label + "\n" + ui.captureCharFrame());
}
async function key(name: string, ctrl = false) {
  await act(async () => {
    ui.mockInput.pressKey(name, { ctrl });
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame();
}
async function send(text: string) {
  await act(async () => {
    await ui.mockInput.pasteBracketedText(text);
    ui.mockInput.pressEnter();
  });
  await frame();
}
let application: Promise<void> | undefined;
try {
  await act(async () => {
    application = runOpenTuiAgent(
      {
        cwd: root,
        configPath,
        allow:
          "ext:builtin.subagents:submit_coding,ext:builtin.subagents:prepare_worktree",
      },
      undefined,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
    await Bun.sleep(20);
  });
  await until(
    () => !!ui.renderer.root.findDescendantById("welcome"),
    "Нет домашнего экрана",
  );
  await send("Поручи двум помощникам независимые изменения");
  await until(() => parentHeld, "Основной агент не продолжил запрос");
  const store = await projectSessionStore(root);
  const approved = new Set<string>();
  for (let index = 0; index < 2; index++) {
    await until(() => {
      if (!ui.renderer.root.findDescendantById("approval-popup")) return false;
      const label = /Помощник: ([^·]+)/
        .exec(ui.captureCharFrame())?.[1]
        ?.trim();
      return !!label && !approved.has(label);
    }, "Нет отдельного адресованного разрешения помощника");
    const label = /Помощник: ([^·]+)/.exec(ui.captureCharFrame())?.[1]?.trim();
    assert.ok(label && ["Первая задача", "Вторая задача"].includes(label));
    await capture(`ordinary-tui-120x40-approval-${index + 1}`);
    approved.add(label);
    await key("y");
  }
  await until(
    () =>
      !!ui.renderer.root.findDescendantById("approval-stop-child") &&
      ui.captureCharFrame().includes("Остановка при разрешении"),
    "Нет адресованного разрешения для отдельной остановки",
  );
  await capture("ordinary-tui-120x40-approval-stop");
  await key("s");
  let parent!: Awaited<ReturnType<typeof store.load>>;
  await until(async () => {
    const summary = (await store.list()).find((item) => !item.subagentOwnerId);
    if (!summary) return false;
    parent = await store.load(summary.id);
    const children = Object.values(parent.children ?? {});
    return (
      children.length === 4 &&
      children
        .filter((item) => item.child.mode === "coding")
        .every(
          (item) =>
            item.child.status ===
              (item.child.label === "Остановка при разрешении"
                ? "cancelled"
                : "completed") && item.child.cleanup.quiescent,
        )
    );
  }, "Помощники не завершились параллельно основному запросу");
  assert.equal(parentCalls, 2);
  assert.equal(
    await readFile(join(root, "same.txt"), "utf8"),
    "committed base\n",
  );
  assert.equal(Object.keys(parent.children ?? {}).length, 4);
  const stoppedAtApproval = Object.values(parent.children ?? {}).find(
    (item) => item.child.label === "Остановка при разрешении",
  )?.child;
  assert.ok(stoppedAtApproval?.root);
  assert.equal(
    await readFile(join(stoppedAtApproval.root, "same.txt"), "utf8"),
    "committed base\n",
    "Stop на approval не выполняет подготовленную запись",
  );
  await until(() => partialSent, "Readonly помощник не начал частичный ответ");
  await key("F7");
  await key("ARROW_DOWN");
  await key("RETURN");
  await until(
    () => ui.captureCharFrame().includes("Частичный ответ"),
    "Не виден partial ответ",
  );
  await capture("ordinary-tui-120x40-readonly-partial");
  await key("s");
  await until(async () => {
    parent = await store.load(parent.id);
    const reader = Object.values(parent.children ?? {}).find(
      (item) => item.child.mode === "readonly",
    )?.child;
    return reader?.status === "cancelled" && reader.cleanup.quiescent;
  }, "Локальная остановка не завершила readonly помощника");
  assert.equal(
    parentCalls,
    2,
    "Остановка помощника не отменяет и не перезапускает основной запрос",
  );
  assert.ok(
    Object.values(parent.children ?? {})
      .filter(
        (item) =>
          item.child.mode === "coding" &&
          item.child.label !== "Остановка при разрешении",
      )
      .every((item) => item.child.status === "completed"),
  );
  await capture("ordinary-tui-120x40-cancelled-partial");
  await key("ESCAPE");
  await key("ARROW_DOWN");
  await capture("ordinary-tui-120x40-tree");
  assert.ok(ui.captureCharFrame().includes("Первая задача"));
  await key("RETURN");
  await until(
    () => !!ui.renderer.root.findDescendantById("agent-details-popup"),
    "Не открылась история помощника",
  );
  await capture("ordinary-tui-120x40-details");
  await key("ARROW_RIGHT");
  await until(
    () => !ui.captureCharFrame().includes("Загрузка сохранённой"),
    "Diff не загружен",
  );
  await capture("ordinary-tui-120x40-diff");
  await key("ARROW_RIGHT");
  await capture("ordinary-tui-120x40-result");
  for (const [width, height] of [
    [160, 50],
    [80, 24],
    [40, 12],
    [24, 8],
  ]) {
    await act(async () => ui.renderer.resize(width!, height!));
    await frame();
    await capture(`ordinary-tui-${width}x${height}-result`);
  }
  await key("ESCAPE");
  await key("ESCAPE");
  await act(async () => {
    ui.renderer.resize(120, 40);
    releaseParent();
  });
  await until(
    () => ui.captureCharFrame().includes("Основной агент продолжил"),
    "Основной агент не продолжил",
  );
  await until(
    () => ui.captureCharFrame().includes("Enter отправить"),
    "Основной запрос не завершил cleanup",
  );
  const beforeResume = requests.length;
  await key("w", true);
  await until(
    () => !!ui.renderer.root.findDescendantById("welcome"),
    "Разговор не закрылся после остановки всех children",
  );
  await send(`/resume ${parent.id}`);
  await until(
    () =>
      !!ui.renderer.root.findDescendantById("prompt-editor") &&
      ui.captureCharFrame().includes("Обзор без изменений") &&
      ui.captureCharFrame().includes("Первая задача"),
    "Saved owner не восстановлен",
  );
  await key("F7");
  await key("ARROW_DOWN");
  await key("RETURN");
  await until(
    () =>
      !!ui.renderer.root.findDescendantById("agent-details-popup") &&
      !ui.captureCharFrame().includes("Загрузка сохранённой истории"),
    "Не восстановился просмотр child Session",
  );
  await key("HOME");
  await capture("ordinary-tui-120x40-resumed-history");
  assert.ok(
    ui.captureCharFrame().includes("Инструмент read_file"),
    "Resume не восстановил штатную child Session\n" + ui.captureCharFrame(),
  );
  assert.equal(
    requests.length,
    beforeResume,
    "Просмотр saved owner не вызывает модель и не replay инструменты",
  );
  await key("ESCAPE");
  await key("ESCAPE");
  await send("/exit");
  await application;
  process.stdout.write(
    "Subagents TUI: production delegation, parallel child tool loops, tree, history/diff/result, resize and durable isolation passed\n",
  );
} finally {
  releaseParent();
  releasePartial();
  server.stop(true);
  ui.renderer.destroy();
  await rm(directory, { recursive: true, force: true });
}
