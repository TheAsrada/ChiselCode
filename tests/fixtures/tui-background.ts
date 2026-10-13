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
import type { Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";
import { quoteShellArg } from "../helpers/shell.js";

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-background-tui-")),
);
const root = join(directory, "Проект интерфейса");
await mkdir(root);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(directory, "home");
process.env.OPENAI_API_KEY = "fixture-background-key";
const file = join(root, "server.cjs");
await writeFile(
  file,
  "require('node:fs').appendFileSync('launches.txt','one\\n');console.log('READY');for(let i=0;i<100;i++)console.log('Сохранённая строка '+i);setInterval(()=>console.log('Новая строка '+Date.now()),60);",
);
let release = () => {};
const barrier = new Promise<void>((resolve) => {
  release = resolve;
});
let calls = 0;
const sse = (delta: unknown, reason: string) =>
  new Response(
    `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
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
    await request.json();
    calls++;
    if (calls === 1)
      return sse(
        {
          tool_calls: [
            {
              index: 0,
              id: "server-once",
              type: "function",
              function: {
                name: "run_shell",
                arguments: JSON.stringify({
                  command: `${quoteShellArg(process.argv[2] ?? process.execPath)} ${quoteShellArg(file)}`,
                  background: process.env.CHISEL_CAPTURE_PROMOTION !== "1",
                  taskKind: "service",
                  label: "Сервер интерфейса · 日本語",
                  readySignal: "READY",
                }),
              },
            },
          ],
        },
        "tool_calls",
      );
    await barrier;
    return sse({ content: "Основной агент продолжает работу." }, "stop");
  },
});
const configPath = join(directory, "global.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    ui: {
      theme: process.env.CHISEL_CAPTURE_THEME ?? "obsidian",
      unicodeDecorations: process.env.CHISEL_CAPTURE_UNICODE === "1",
    },
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
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ui = await createTestRenderer({
  width: 120,
  height: 40,
  exitOnCtrlC: false,
});
async function frame() {
  await act(async () => {
    await ui.renderOnce();
    await ui.renderOnce();
  });
}
async function send(text: string) {
  await act(async () => {
    await ui.mockInput.pasteBracketedText(text);
  });
  await frame();
  await act(async () => {
    ui.mockInput.pressEnter();
  });
  await frame();
}
async function key(name: string, ctrl = false) {
  await act(async () => {
    ui.mockInput.pressKey(
      (
        {
          return: "RETURN",
          up: "ARROW_UP",
          down: "ARROW_DOWN",
          escape: "ESCAPE",
        } as Record<string, string>
      )[name] ?? name,
      { ctrl },
    );
    if (name === "escape") await Bun.sleep(120);
  });
  await frame();
}
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 800; i++) {
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
    if (check()) return;
  }
  throw new Error(`${label}\n${ui.captureCharFrame()}`);
}
async function capture(name: string) {
  const folder = process.env.CHISEL_CAPTURE_DIR;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await frame();
  await writeFile(
    join(
      folder,
      `${process.env.CHISEL_CAPTURE_THEME ?? "obsidian"}-${process.env.CHISEL_CAPTURE_UNICODE === "1" ? "unicode" : "ascii"}-${name}.txt`,
    ),
    ui.captureCharFrame(),
  );
  const spans = ui.captureSpans();
  await writeFile(
    join(
      folder,
      `${process.env.CHISEL_CAPTURE_THEME ?? "obsidian"}-${process.env.CHISEL_CAPTURE_UNICODE === "1" ? "unicode" : "ascii"}-${name}.json`,
    ),
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
let application: Promise<void> | undefined;
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath, allow: "run_shell" },
      undefined,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
  });
  await until(
    () => !!ui.renderer.root.findDescendantById("welcome"),
    "Нет домашнего экрана",
  );
  await send("Запусти сервер в фоне и продолжи ответ");
  if (process.env.CHISEL_CAPTURE_PROMOTION === "1") {
    const findPromotion = (node: Renderable): Renderable | undefined =>
      node.id.startsWith("chat-card-promote-")
        ? node
        : node.getChildren().map(findPromotion).find(Boolean);
    await until(
      () => !!findPromotion(ui.renderer.root),
      "Нет действия «В фон» у живой foreground команды",
    );
    await frame();
    await capture("ordinary-tui-120x40-foreground-promotion");
    const promotion = findPromotion(ui.renderer.root)!;
    const identity = promotion.id.slice("chat-card-promote-".length);
    await act(async () =>
      ui.mockMouse.drag(
        promotion.x + 1,
        promotion.y,
        promotion.x + 3,
        promotion.y,
      ),
    );
    await frame();
    assert.equal(calls, 1, "Drag не выполняет promotion");
    await act(async () => ui.mockMouse.click(promotion.x + 1, promotion.y));
    await until(() => calls >= 2, "Promotion не вернул terminal tool result");
    assert.ok(
      ui.renderer.root.findDescendantById(`chat-card-${identity}`),
      "Promotion сохраняет ту же карточку",
    );
    assert.match(ui.captureCharFrame(), /Продолжает в фоне/);
    await capture("ordinary-tui-120x40-promoted-card");
  }
  await until(
    () => calls >= 2,
    "Основной запрос не достиг продолжения после shell",
  );
  await until(
    () => ui.captureCharFrame().includes("Фон 1"),
    "Нет индикатора фоновой команды",
  );
  await key("t", true);
  await until(
    () => !!ui.renderer.root.findDescendantById("settings-popup"),
    "Настройки темы недоступны при running task",
  );
  await key("down");
  await key("return");
  await until(
    () => ui.captureCharFrame().includes("Тема сохранена"),
    "Тема не сохранилась при running task",
  );
  await key("escape");
  await until(
    () => !ui.renderer.root.findDescendantById("settings-popup"),
    "Esc не закрыл настройки темы",
  );
  assert.equal(calls, 2, "Смена темы не делает model request");
  assert.equal(await readFile(join(root, "launches.txt"), "utf8"), "one\n");
  await send("/tasks");
  await until(
    () => !!ui.renderer.root.findDescendantById("background-tasks-popup"),
    "/tasks не открыл popup во время запроса",
  );
  assert.equal(calls, 2);
  assert.ok(!ui.renderer.root.findDescendantById("sidebar-tab-background"));
  for (const [width, height] of [
    [160, 50],
    [120, 40],
    [80, 24],
    [40, 12],
    [24, 8],
  ]) {
    await act(async () => {
      ui.renderer.resize(width!, height!);
    });
    await capture(`ordinary-tui-${width}x${height}-background-popup`);
    assert.ok(ui.renderer.root.findDescendantById("background-action-0"));
    assert.ok(ui.renderer.root.findDescendantById("background-action-1"));
  }
  await act(async () => {
    ui.renderer.resize(120, 40);
  });
  await frame();
  await key("return");
  await until(
    () => !!ui.renderer.root.findDescendantById("background-details-popup"),
    "Enter не открыл вывод",
  );
  await until(
    () => /Сохранённая строка|Новая строка/.test(ui.captureCharFrame()),
    "Нет настоящего сохранённого вывода",
  );
  await capture("ordinary-tui-120x40-background-output");
  await key("up");
  const frozenRows = () =>
    ui
      .captureCharFrame()
      .split("\n")
      .map((line) => line.match(/(?:Сохранённая|Новая) строка \d+/)?.[0])
      .filter(Boolean)
      .join("\n");
  const oldRows = frozenRows();
  await until(
    () => /Новые строки: [1-9]/.test(ui.captureCharFrame()),
    "Пауза follow не показывает счётчик новых строк",
  );
  assert.equal(
    frozenRows(),
    oldRows,
    "Новые строки не сбрасывают просмотр старого вывода",
  );
  await capture("ordinary-tui-120x40-background-follow-paused");
  await key("/");
  await act(async () => {
    await ui.mockInput.typeText("Сохранённая строка 12");
  });
  await key("return");
  await until(
    () => ui.captureCharFrame().includes("Поиск в сохранённом выводе"),
    "Поиск не прочитал retained output",
  );
  assert.equal(calls, 2, "Поиск не запускает модель");
  await key("up");
  await key("c", true);
  assert.equal(calls, 2);
  await key("escape");
  await until(
    () => !!ui.renderer.root.findDescendantById("background-tasks-popup"),
    "Esc не вернул список задач",
  );
  await key("s");
  await until(
    () => ui.captureCharFrame().includes("Остановлено"),
    "Выбранная задача не остановилась",
  );
  await capture("ordinary-tui-120x40-background-stopped");
  await key("escape");
  release();
  await until(
    () => ui.captureCharFrame().includes("Основной агент продолжает"),
    "Popup потерял основной запрос",
  );
  await capture("ordinary-tui-120x40-background-main");
  assert.equal(await readFile(join(root, "launches.txt"), "utf8"), "one\n");
  await send("/exit");
  await application;
  console.log(
    "Background Tasks TUI: production runOpenTuiAgent, popup, live retained logs, resize, focus and selected stop",
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  release();
  if (application) {
    process.emit("SIGTERM");
    await application.catch(() => {});
  }
  server.stop(true);
  ui.renderer.destroy();
  await rm(directory, { recursive: true, force: true });
}
