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
import { type Renderable, ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { userSkillsDir } from "../../src/paths/home.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";
import { quoteShellArg } from "../helpers/shell.js";

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-tool-actions-")),
);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(directory, "home");
process.env.OPENAI_API_KEY = "fixture-tool-actions-key";
const root = join(directory, "Проект сводки");
await mkdir(root);
await writeFile(join(root, "a.ts"), "export const answer = 42;\n");
await writeFile(join(root, "b.ts"), "export const other = 7;\n");
for (const name of ["review-fixture", "checks-fixture"]) {
  const folder = join(userSkillsDir(), name);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    `---\nname: ${name}\ndescription: Проверка проекта и сохранение диагностики\n---\nPRIVATE SKILL INSTRUCTIONS ${name}\n`,
  );
}
const script = join(root, "check.cjs");
await writeFile(
  script,
  "require('node:fs').appendFileSync('launches.txt','one\\n');for(let i=0;i<450;i++)console.log('Строка результата '+i);console.error('AssertionError: ожидалось 42, получено 7');process.exitCode=1;",
);
await writeFile(
  join(root, ".chiselrc"),
  JSON.stringify({ context: { maxInlineToolResultTokens: 128 } }),
);
let releaseSkills = () => {};
const skillsBarrier = new Promise<void>((resolve) => {
  releaseSkills = resolve;
});
let releaseFinal = () => {};
const finalBarrier = new Promise<void>((resolve) => {
  releaseFinal = resolve;
});
let calls = 0;
const tool = (id: string, name: string, input: object) => ({
  index: 0,
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(input) },
});
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
    const body = (await request.json()) as {
      messages: { role: string; content?: string }[];
    };
    calls++;
    let delta: object;
    if (calls === 1)
      delta = {
        content: "Изучу файлы проекта.",
        tool_calls: [
          tool("read-one", "read_file", { path: "a.ts" }),
          tool("read-two", "read_file", { path: "b.ts" }),
          tool("find-one", "grep", { pattern: "export" }),
        ].map((value, index) => ({ ...value, index })),
      };
    else if (calls === 2)
      delta = {
        tool_calls: [
          tool("skill-one", "load_skill", { name: "review-fixture" }),
          tool("skill-two", "load_skill", { name: "checks-fixture" }),
        ].map((value, index) => ({ ...value, index })),
      };
    else if (calls === 3) {
      assert.ok(
        JSON.stringify(body.messages).includes("PRIVATE SKILL INSTRUCTIONS"),
        "Инструкции поступают модели, не в основную ленту",
      );
      delta = {
        content: "Запущу проверку.",
        tool_calls: [
          tool("check-one", "run_shell", {
            command: `${quoteShellArg(process.argv[2] ?? process.execPath)} ${quoteShellArg(script)}`,
          }),
        ],
      };
    } else {
      assert.equal(
        calls,
        4,
        "Сворачивание и чтение результата не вызывают модель",
      );
      await finalBarrier;
      delta = { content: "Готово. Диагностика сохранена." };
    }
    return new Response(
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: calls < 4 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
const configPath = join(directory, "config.json");
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
    ui: {
      theme: process.env.CHISEL_CAPTURE_THEME ?? "obsidian",
    },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let ui = await createTestRenderer({
  width: 120,
  height: 40,
  exitOnCtrlC: false,
});
let application: Promise<void> | undefined;
let applicationError: unknown;
async function frame() {
  await act(async () => {
    await ui.renderOnce();
    await ui.renderOnce();
  });
}
async function until(ready: () => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (applicationError) throw applicationError;
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
    if (ready()) return;
  }
  throw new Error(`${label}\n${ui.captureCharFrame()}`);
}
async function key(name: string) {
  await act(async () => {
    ui.mockInput.pressKey(name);
  });
  await frame();
}
async function send(text: string) {
  await act(async () => {
    await ui.mockInput.pasteBracketedText(text);
  });
  await frame();
  await key("RETURN");
}
function node(id: string): Renderable {
  const result = ui.renderer.root.findDescendantById(id);
  assert.ok(result, `Нет ${id}\n${ui.captureCharFrame()}`);
  return result;
}
async function click(id: string) {
  await reveal(id);
  const target = node(id);
  await act(async () => {
    ui.renderer.clearSelection();
    await ui.mockMouse.click(target.x + 1, target.y);
  });
  await frame();
}
async function reveal(id: string) {
  const target = node(id);
  let parent = target.parent;
  while (parent && !(parent instanceof ScrollBoxRenderable))
    parent = parent.parent;
  if (parent instanceof ScrollBoxRenderable) {
    const scroll = parent;
    await act(async () => {
      scroll.scrollTo(
        Math.max(0, scroll.scrollTop + target.y - scroll.viewport.y),
      );
    });
  }
  await frame();
  return parent instanceof ScrollBoxRenderable ? parent : undefined;
}
async function capture(name: string) {
  await frame();
  const folder = process.env.CHISEL_CAPTURE_DIR;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  const prefix = `${process.env.CHISEL_CAPTURE_THEME ?? "obsidian"}-graphics`;
  await writeFile(join(folder, `${prefix}-${name}.txt`), ui.captureCharFrame());
  const spans = ui.captureSpans();
  await writeFile(
    join(folder, `${prefix}-${name}.json`),
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
async function exit() {
  await act(async () => {
    process.emit("SIGTERM");
    await application;
  });
  application = undefined;
}
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath, allow: "run_shell" },
      undefined,
      false,
      false,
      [
        ...defaultExtensions(),
        {
          id: "fixture.actions",
          activate(context) {
            context.guards.beforeExecute(async (invocation) => {
              if (invocation.tool.name === "load_skill") await skillsBarrier;
              return { action: "continue" };
            });
          },
        },
      ],
      async () => ui.renderer,
    );
    void application.catch((error) => {
      applicationError = error;
    });
  });
  await until(
    () => !!ui.renderer.root.findDescendantById("welcome"),
    "Нет главной",
  );
  await send("Изучи проект и запусти проверку");
  await until(
    () =>
      calls === 2 &&
      ui.captureCharFrame().includes("Навыки") &&
      ui.captureCharFrame().includes("Загрузка"),
    "Нет загрузки навыков",
  );
  assert.match(ui.captureCharFrame(), /Чтение 2.*Поиск 1/);
  assert.doesNotMatch(ui.captureCharFrame(), /PRIVATE SKILL/);
  await capture("closed-and-skills-loading");
  const group = "action-group:actions:read-one";
  await click(`${group}-toggle`);
  assert.ok(ui.renderer.root.findDescendantById("action-item:read-one"));
  assert.ok(ui.renderer.root.findDescendantById("action-item:read-two"));
  assert.ok(ui.renderer.root.findDescendantById("action-item:find-one"));
  assert.equal(calls, 2);
  await capture("actions-open");
  await click(`${group}-toggle`);
  await key("TAB");
  await key("RETURN");
  assert.ok(
    ui.renderer.root.findDescendantById("action-item:read-one"),
    "Клавиатура раскрывает сводку",
  );
  await key("TAB");
  await key("RETURN");
  assert.match(ui.captureCharFrame(), /export const answer/);
  await key("ESCAPE");
  await until(
    () => !!ui.renderer.currentFocusedEditor,
    "Esc не вернул фокус вводу",
  );
  await click(`${group}-toggle`);
  assert.ok(
    ui.renderer.currentFocusedEditor,
    "Закрытие подробностей не перехватывает ввод",
  );
  await act(async () => {
    await ui.mockInput.pasteBracketedText("Черновик сохранён");
  });
  await frame();
  await click(`${group}-toggle`);
  const readingScroll = await reveal("action-item:read-one");
  assert.ok(readingScroll);
  const readingTop = readingScroll.scrollTop;
  releaseSkills();
  await until(() => calls === 4, "Проверка не завершилась");
  assert.equal(
    readingScroll.scrollTop,
    readingTop,
    "Обновление не двигает читаемую историю",
  );
  assert.ok(
    ui.renderer.root.findDescendantById("action-item:read-one"),
    "Обновление не сворачивает подробности",
  );
  await click(`${group}-toggle`);
  await reveal("action-group:actions:check-one-toggle");
  assert.match(ui.captureCharFrame(), /AssertionError/);
  assert.doesNotMatch(ui.captureCharFrame(), /PRIVATE SKILL/);
  assert.equal(
    ui.renderer.currentFocusedEditor?.plainText,
    "Черновик сохранён",
    "Обновления сохраняют фокус и черновик",
  );
  await capture("error-closed");
  await click("action-group:skills:skill-one-toggle");
  assert.match(ui.captureCharFrame(), /Библиотека пользователя/);
  await capture("skills-open");
  await click("action-group:skills:skill-one-toggle");
  await click("action-group:actions:check-one-toggle");
  await click("action-output:check-one");
  await reveal("action-content:check-one");
  await until(
    () => ui.captureCharFrame().includes("Строка результата 0"),
    "Полный artifact не прочитан",
  );
  await click("action-next:check-one");
  await reveal("action-content:check-one");
  await until(
    () => ui.captureCharFrame().includes("Строка результата 100"),
    "Нет следующей страницы artifact",
  );
  assert.equal(calls, 4);
  await capture("saved-output");
  await click("action-group:actions:check-one-toggle");
  for (const [width, height] of [
    [80, 24],
    [40, 20],
    [24, 18],
  ]) {
    await act(async () => {
      ui.renderer.resize(width ?? 80, height ?? 24);
    });
    await frame();
    await reveal("action-group:actions:check-one-toggle");
    await capture(`narrow-${width}x${height}`);
    assert.ok(
      ui.renderer.root.findDescendantById(
        "action-group:actions:check-one-toggle",
      ),
    );
  }
  await act(async () => {
    ui.renderer.resize(120, 40);
  });
  releaseFinal();
  await until(
    () => !ui.renderer.root.findDescendantById("request-status"),
    "Запрос не завершён",
  );
  assert.equal(await readFile(join(root, "launches.txt"), "utf8"), "one\n");
  const store = await projectSessionStore(root);
  const record = (await store.list()).find(
    (entry) => !entry.subagentOwnerId && !entry.backgroundOwnerId,
  );
  assert.ok(record);
  const saved = await store.load(record.id);
  const savedSkill = saved.runtime?.invocations["skill-one"]?.result?.details
    ?.skill as { source?: string } | undefined;
  assert.equal(savedSkill?.source, "user");
  await exit();
  ui = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath },
      saved,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
    void application.catch((error) => {
      applicationError = error;
    });
  });
  await until(
    () =>
      ui.captureCharFrame().includes("Действия агента") &&
      ui.captureCharFrame().includes("AssertionError"),
    "Восстановление изменило сводки",
  );
  assert.match(ui.captureCharFrame(), /Чтение 2.*Поиск 1/);
  assert.equal(calls, 4);
  assert.equal(await readFile(join(root, "launches.txt"), "utf8"), "one\n");
  assert.ok(
    !ui.renderer.root.findDescendantById("action-item:read-one"),
    "Восстановленные группы свёрнуты",
  );
  await capture("restored");
  await exit();
  console.log(
    "Tool actions OpenTUI: real executor, parallel reads, skills, failure, artifact pages, keyboard, narrow layouts and restored history",
  );
} finally {
  releaseSkills();
  releaseFinal();
  if (application)
    await act(async () => {
      process.emit("SIGTERM");
      await application?.catch(() => {});
    });
  server.stop(true);
  ui.renderer.destroy();
  await rm(directory, { recursive: true, force: true });
}
