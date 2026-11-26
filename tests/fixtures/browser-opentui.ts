import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { browserInstallState } from "../../src/browser/install.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
assert.equal(
  await browserInstallState(),
  "ready",
  "Prepare Chromium in the fixture's XDG_DATA_HOME.",
);
const directory = await mkdtemp("/tmp/chisel-browser-ui-");
const root = join(directory, "frontend"),
  configPath = join(directory, "config.json");
await mkdir(root);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    return new Response(
      `<!doctype html><title>Заказ · QA</title>
      <style>body{margin:0;background:#edf3ff;color:#162344;font:22px sans-serif}main{max-width:320px;margin:24px auto}button{color:white;background:#2445ba;padding:8px 24px;border:0;border-radius:5px}</style>
      <main><h1>Заказ</h1><form><label>Контакт <input autocomplete="off" aria-label="Контакт"></label> <button>Сохранить</button></form>
      <p>Черновик заказа</p></main>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    profiles: {},
    browser: { origins: [server.url.origin] },
    ui: { theme: "obsidian", motion: "reduced" },
    lsp: { mode: "off", servers: {} },
  }),
);
const session = createSession(root, "openai", "fixture");
session.mode = "build";
session.title = "Проверка формы заказа";
session.messages = [
  {
    role: "user",
    content: [
      { type: "text", text: "Проверь форму заказа на телефонном viewport." },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Проверю состояние формы и горизонтальное переполнение.",
      },
    ],
  },
];
await (await projectSessionStore(root)).save(session);
const ui = await createTestRenderer({
  width: 146,
  height: 42,
  exitOnCtrlC: false,
});
let app: ReturnType<typeof runOpenTuiAgent> | undefined;
const frame = () =>
  act(async () => {
    await ui.renderOnce();
  });
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `${label}\n${ui.captureCharFrame()}`);
    await act(async () => {
      await Bun.sleep(15);
      await ui.renderOnce();
    });
  }
  await frame();
}
const node = (id: string) => ui.renderer.root.findDescendantById(id);
const address = () =>
  node(
    "extension-builtin.browser/browser-address/pane:builtin.browser/browser",
  );
const prompt = () => node("prompt-editor");
function present<T>(item: T | undefined): T {
  assert.ok(item);
  return item;
}
async function command(value: string) {
  await act(async () => {
    const editor = prompt();
    if (editor) await ui.mockMouse.click(editor.x + 1, editor.y);
    ui.mockInput.pasteBracketedText(value);
    ui.mockInput.pressEnter();
  });
  await frame();
}
async function key(name: string, ctrl = false, meta = false) {
  await act(async () => ui.mockInput.pressKey(name, { ctrl, meta }));
  await frame();
}
type RenderNode = NonNullable<ReturnType<typeof node>>;
function label(value: string, within: RenderNode = ui.renderer.root) {
  type Node = RenderNode;
  function find(item: Node): Node | undefined {
    if (
      "plainText" in item &&
      typeof item.plainText === "string" &&
      item.plainText.trim() === value
    )
      return item;
    for (const child of item.getChildren()) {
      const matching = find(child as Node);
      if (matching) return matching;
    }
  }
  return find(within);
}
async function choose(value: string) {
  await key("u", false, true);
  const popup = () => node("ui-composition-controls-popup");
  const target = () =>
    popup() ? label(`Браузер · ${value}`, present(popup())) : undefined;
  await until(() => {
    const row = target();
    const bounds = popup();
    return (
      !!row &&
      !!bounds &&
      row.height > 0 &&
      row.y >= bounds.y &&
      row.y < bounds.y + bounds.height
    );
  }, `Нет доступного действия ${value}`);
  const row = present(target());
  await act(async () => {
    await ui.mockMouse.click(row.x + 2, row.y);
  });
  await until(() => !popup(), `Действие ${value} не выбрано`);
}
async function capture(name: string) {
  const dir = process.env.CHISEL_BROWSER_CAPTURES;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  const spans = ui.captureSpans();
  await writeFile(
    join(dir, `${name}.json`),
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

try {
  await act(async () => {
    app = runOpenTuiAgent(
      { cwd: root, configPath, mode: "build" },
      session,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
  });
  await until(
    () => !!prompt() && ui.captureCharFrame().includes("Проверь форму заказа"),
    "Чат не готов",
  );
  await key("b", true);
  await until(
    () => !ui.captureCharFrame().includes("ПАНЕЛЬ СЕАНСА"),
    "Штатная панель не закрылась",
  );
  await command("/browser");
  await until(() => !!address(), "Панель не открылась");
  assert.ok(
    present(address()).x > present(prompt()).x + 55,
    "Панель должна располагаться справа от чата",
  );
  const input = present(address());
  await act(async () => {
    await ui.mockMouse.click(input.x + 1, input.y);
  });
  await until(
    () => ui.renderer.currentFocusedEditor?.id === input.id,
    "Поле адреса не получило фокус",
  );
  await act(async () => ui.mockInput.typeText(server.url.href));
  await until(
    () => ui.captureCharFrame().includes(server.url.origin),
    "Адрес не введён",
  );
  await choose("Открыть");
  await until(
    () => !!node("approval-popup"),
    "Кнопка не запросила подтверждение",
  );
  await key("y");
  await until(
    () => ui.captureCharFrame().includes("Заказ · QA"),
    "Страница не открылась",
  );
  await choose("Телефон");
  await until(() => !!node("approval-popup"), "Нет подтверждения viewport");
  await key("y");
  await until(
    () => ui.captureCharFrame().includes("390 × 844"),
    "Размер не изменился",
  );
  await until(
    () => (ui.captureCharFrame().match(/Завершено за/g)?.length ?? 0) >= 2,
    "Установка viewport не завершилась",
  );
  await choose("Снимок");
  await until(() => !!node("approval-popup"), "Нет подтверждения снимка");
  await key("y");
  await until(
    () => ui.captureCharFrame().includes("capture.png"),
    "Нет снимка",
  );
  await capture("wide");
  await act(async () => ui.renderer.resize(72, 34));
  await until(
    () =>
      !!address() &&
      present(address()).y < present(prompt()).y &&
      present(address()).x < 10,
    "Панель не перенеслась над вводом",
  );
  assert.ok(ui.captureCharFrame().includes(server.url.origin));
  await capture("narrow");
  await act(async () => ui.renderer.resize(146, 42));
  await until(
    () => !!address() && present(address()).x > 55,
    "Панель не вернулась вправо",
  );
  await act(async () => {
    await ui.mockMouse.click(present(address()).x + 1, present(address()).y);
  });
  await until(
    () => ui.renderer.currentFocusedEditor?.id === present(address()).id,
    "Поле не получило фокус",
  );
  await key("ESCAPE");
  await until(
    () => ui.renderer.currentFocusedEditor?.id === "prompt-editor",
    "Фокус не вернулся в чат",
  );
  await command("/browser");
  await until(() => !address(), "Панель не скрылась");
  await command("/exit");
  await act(async () => {
    await app;
  });
  console.log(
    "Browser OpenTUI: confirmation, input, PNG, right pane, resize and focus.",
  );
} finally {
  if (app)
    await act(async () => {
      process.emit("SIGTERM");
      await app?.catch(() => {});
    });
  await act(async () => ui.renderer.destroy());
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
