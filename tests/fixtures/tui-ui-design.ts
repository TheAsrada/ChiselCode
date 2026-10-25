import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-ui-design-"));
const project = join(storage, "Проект");
await mkdir(project);
for (const name of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[name] = join(storage, "home");
process.env.OPENAI_API_KEY = "fixture-ui-design";
const theme = process.env.CHISEL_DESIGN_THEME ?? "obsidian";
let release = () => {};
const responseGate = new Promise<void>((resolve) => {
  release = resolve;
});
let generations = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "fixture-design",
            context_window: 65536,
            max_output_tokens: 4096,
          },
        ],
      });
    generations++;
    await request.json();
    await responseGate;
    const content =
      "## Интерфейс готов к работе\n\nЯ изучил структуру проекта. Начнём с понятной навигации и проверим изменения в настоящем терминале.\n\n- Сохраним черновик и положение курсора.\n- Покажем состояние текущей задачи.\n- Проверим клавиатуру, мышь и узкое окно.\n\n```ts\nconst interfaceState = { focused: true, draft: 'сохранён' };\n```";
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.hostname === "127.0.0.1"
      ? nativeFetch(input, init)
      : Promise.resolve(new Response("Offline fixture", { status: 503 }));
  }) as typeof fetch,
  { preconnect: nativeFetch.preconnect },
);
const configPath = join(storage, "config.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    defaultProfileId: "fixture",
    profiles: {
      fixture: {
        providerId: "openai-compatible",
        defaultModel: "fixture-design",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
    },
    ui: { theme, motion: "full", future: "preserve" },
    web: { enabled: false },
    lsp: { mode: "off" },
  }),
);
const t = await createTestRenderer({
  width: 120,
  height: 36,
  exitOnCtrlC: false,
});
const frame = () =>
  act(async () => {
    await t.renderOnce();
    await t.renderOnce();
  });
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20000;
  do {
    await act(async () => {
      await Bun.sleep(15);
      await t.renderOnce();
    });
    if (await check()) {
      await frame();
      return;
    }
  } while (Date.now() < deadline);
  throw Error(`${label}\n${t.captureCharFrame()}`);
}
async function key(name: string, ctrl = false) {
  await act(async () => {
    t.mockInput.pressKey(name, { ctrl });
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame();
}
async function click(id: string) {
  const area = t.renderer.root.findDescendantById(id);
  assert.ok(area, `Missing ${id}\n${t.captureCharFrame()}`);
  await act(async () => {
    await t.mockMouse.click(area.x + Math.min(1, area.width - 1), area.y);
  });
  await frame();
}
async function paste(value: string) {
  await act(async () => {
    await t.mockInput.pasteBracketedText(value);
  });
  await frame();
}
async function capture(name: string) {
  const directory = process.env.CHISEL_DESIGN_CAPTURES;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${theme}-${name}.txt`),
    t.captureCharFrame(),
  );
  const spans = t.captureSpans();
  await writeFile(
    join(directory, `${theme}-${name}.json`),
    JSON.stringify({
      ...spans,
      capturedAtMs: performance.now(),
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
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: project, configPath },
      undefined,
      false,
      false,
      undefined,
      async () => t.renderer,
    );
  });
  await until(
    () =>
      !!t.renderer.currentFocusedEditor &&
      !!t.renderer.root.findDescendantById("home-settings"),
    "Home not ready",
  );
  await capture("home-120x36");
  const originalEditor = t.renderer.currentFocusedEditor;
  // Every rejected command stays outside the welcome transcript, including worktree parsing.
  for (const command of [
    "/status",
    "/doctor",
    "/unknown-home-command",
    "/worktree invalid-action",
    `/cwd ${join(project, "missing-project")}`,
  ]) {
    await paste(command);
    await key("RETURN");
    await until(
      () => !!t.renderer.root.findDescendantById("command-feedback-popup"),
      `Missing feedback for ${command}`,
    );
    assert.equal(t.renderer.root.findDescendantById("session-tabs"), undefined);
    assert.equal(generations, 0);
    assert.equal(
      t.renderer.root.findDescendantById("prompt-editor"),
      originalEditor,
    );
    await paste("Вставка в закрытый редактор");
    assert.equal(
      originalEditor?.plainText,
      "",
      "Feedback leaked paste to the composer",
    );
    if (command === "/status") {
      await capture("command-error-120x36");
      await act(async () => t.resize(24, 8));
      await frame();
      const close = t.renderer.root.findDescendantById(
        "command-feedback-close",
      );
      assert.ok(close && close.y + close.height <= 8);
      await capture("command-error-24x8");
    }
    await key("RETURN");
    await until(
      () => t.renderer.currentFocusedEditor === originalEditor,
      "Feedback did not restore editor focus",
    );
    assert.equal(
      t.renderer.root.findDescendantById("command-feedback-popup"),
      undefined,
    );
    assert.ok(!t.captureCharFrame().includes("Неизвестная команда"));
    await act(async () => t.resize(120, 36));
    await frame();
  }
  await paste("/cwd");
  await key("RETURN");
  assert.equal(originalEditor?.plainText, "/cwd ");
  await key("u", true);
  await paste("/worktree");
  await key("RETURN");
  await until(
    () => !!t.renderer.root.findDescendantById("worktrees-popup"),
    "Worktree manager did not open on home",
  );
  assert.equal(
    t.renderer.root.findDescendantById("command-feedback-popup"),
    undefined,
  );
  await until(
    () => t.captureCharFrame().includes("Действие не выполнено"),
    "Worktree diagnostic was not shown inside its manager",
  );
  await capture("worktree-error-120x36");
  await key("ESCAPE");
  await until(
    () => !t.captureCharFrame().includes("Действие не выполнено"),
    "Worktree diagnostic did not return to list",
  );
  await key("ESCAPE");
  await until(
    () => t.renderer.currentFocusedEditor === originalEditor,
    "Worktree manager did not restore home",
  );
  await capture("home-after-commands-120x36");
  assert.equal(generations, 0);
  const draft = "Изучи интерфейс 👩‍💻 汉字 e\u0301";
  await paste(draft);
  const originalCursor = originalEditor?.cursorOffset;
  await click("home-settings");
  await until(
    () => !!t.renderer.root.findDescendantById("settings-popup"),
    "Settings did not open",
  );
  await key("t", true);
  await until(
    () => !!t.renderer.root.findDescendantById("settings-motion"),
    "Appearance not ready",
  );
  await capture("appearance-120x36");
  for (const [width, height] of [
    [80, 24],
    [40, 18],
    [24, 8],
    [120, 36],
  ] as const) {
    await act(async () => {
      t.resize(width, height);
    });
    await frame();
    const popup = t.renderer.root.findDescendantById("settings-popup");
    assert.ok(popup);
    assert.ok(
      popup.x >= 0 &&
        popup.y >= 0 &&
        popup.x + popup.width <= width &&
        popup.y + popup.height <= height,
    );
    assert.equal(
      t.renderer.root.findDescendantById("prompt-editor"),
      originalEditor,
    );
    assert.equal(originalEditor?.plainText, draft);
    assert.equal(originalEditor?.cursorOffset, originalCursor);
    await capture(`appearance-${width}x${height}`);
  }
  await click("settings-motion");
  await until(
    async () =>
      JSON.parse(await readFile(configPath, "utf8")).ui.motion === "reduced",
    "Motion preference not persisted",
  );
  assert.ok(t.captureCharFrame().includes("минимум"));
  let config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.ui.theme, theme);
  assert.equal(config.ui.future, "preserve");
  await key("m");
  await until(
    async () =>
      JSON.parse(await readFile(configPath, "utf8")).ui.motion === "full",
    "Motion not re-enabled",
  );
  await key("ESCAPE");
  await until(
    () => t.renderer.currentFocusedEditor === originalEditor,
    "Home editor remounted",
  );
  assert.equal(originalEditor?.plainText, draft);
  assert.equal(originalEditor?.cursorOffset, originalCursor);
  assert.equal(generations, 0, "Menus must not call a model");
  for (const [width, height] of [
    [80, 24],
    [40, 18],
    [24, 8],
    [120, 36],
  ] as const) {
    await act(async () => {
      t.resize(width, height);
    });
    await frame();
    assert.equal(t.renderer.currentFocusedEditor, originalEditor);
    assert.equal(originalEditor?.plainText, draft);
    assert.equal(originalEditor?.cursorOffset, originalCursor);
    await capture(`home-draft-${width}x${height}`);
  }
  await key("RETURN");
  await until(
    () =>
      generations > 0 && !!t.renderer.root.findDescendantById("request-status"),
    "Request not running",
  );
  const chatEditor = t.renderer.currentFocusedEditor;
  await paste("Следующий шаг — проверить результат");
  const frames = new Set<string>();
  const activityColors = new Set<string>();
  for (let i = 0; i < 16; i++) {
    await act(async () => {
      await Bun.sleep(85);
      await t.renderOnce();
    });
    frames.add(t.captureCharFrame());
    const activity = t
      .captureSpans()
      .lines.find((line) =>
        line.spans.some((span) => span.text.includes("Думаю")),
      );
    activityColors.add(
      JSON.stringify(activity?.spans.map((span) => span.fg.toInts())),
    );
    assert.equal(t.renderer.currentFocusedEditor, chatEditor);
    assert.equal(chatEditor?.plainText, "Следующий шаг — проверить результат");
    await capture(`motion-${String(i).padStart(2, "0")}`);
  }
  assert.ok(frames.size >= 3, "Real running indicator did not animate");
  assert.ok(
    activityColors.size >= 3,
    "The activity band did not repaint its colors",
  );
  release();
  await until(
    () =>
      !t.renderer.root.findDescendantById("request-status") &&
      t.captureCharFrame().includes("Интерфейс готов к работе"),
    "SDK response not rendered",
  );
  await capture("chat-120x36");
  const completedRequests = generations;
  if (!t.renderer.root.findDescendantById("sidebar-tab-menu"))
    await key("b", true);
  await click("sidebar-tab-menu");
  await key("/");
  await until(
    () => t.renderer.currentFocusedRenderable?.id === "sidebar-menu-search",
    "Search did not focus",
  );
  await paste("Внешний вид");
  assert.ok(t.captureCharFrame().includes("Внешний вид"));
  assert.equal(
    t.renderer.root.findDescendantById("sidebar-menu-services"),
    undefined,
  );
  await capture("menu-search-120x36");
  await key("RETURN");
  await until(
    () => !!t.renderer.root.findDescendantById("settings-motion"),
    "Enter did not open the selected screen",
  );
  await key("ESCAPE");
  assert.equal(generations, completedRequests);
  assert.equal(chatEditor?.plainText, "Следующий шаг — проверить результат");
  config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.ui.motion, "full");
  console.log(
    `UI design: ${theme}, production app/SDK, saved motion preference, real animated frames, stable Unicode editor/cursor, resize, search/Enter and no model calls from menus passed.`,
  );
} finally {
  release();
  if (application)
    await act(async () => {
      process.emit("SIGTERM");
      await application?.catch(() => {});
    });
  server.stop(true);
  globalThis.fetch = nativeFetch;
  await rm(storage, { recursive: true, force: true });
}
