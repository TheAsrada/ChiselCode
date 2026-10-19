import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { defaultExtensions } from "../../src/extensions/index.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";
import { uiExtension } from "./ui-extension.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-ui-production-"));
const root = join(storage, "Проект интерфейса");
await mkdir(root);
for (const key of [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(storage, "home");
const configPath = join(storage, "global.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    ui: {
      theme: process.env.CHISEL_CAPTURE_THEME ?? "obsidian",
    },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
    profiles: {},
  }),
);
const fixture = uiExtension();
const ui = await createTestRenderer({
  width: 160,
  height: 50,
  exitOnCtrlC: false,
});
const nativeFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = Object.assign(
  async () => {
    ++networkCalls;
    return new Response("Offline fixture", { status: 503 });
  },
  { preconnect: nativeFetch.preconnect },
);
async function frame() {
  await act(async () => {
    await ui.renderOnce();
    await ui.renderOnce();
  });
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  message: string,
) {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error(`${message}\n${ui.captureCharFrame()}`);
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
  }
}
async function key(name: string, ctrl = false) {
  await act(async () => {
    ui.mockInput.pressKey(
      (
        {
          escape: "ESCAPE",
          return: "RETURN",
          up: "ARROW_UP",
          down: "ARROW_DOWN",
        } as Record<string, string>
      )[name] ?? name,
      { ctrl },
    );
    if (name.toLowerCase() === "escape") await Bun.sleep(120);
  });
  await frame();
}
async function click(id: string) {
  const target = ui.renderer.root.findDescendantById(id);
  assert.ok(target, `Нет ${id}`);
  await act(async () => ui.mockMouse.click(target.x + 1, target.y));
  await frame();
}
async function capture(name: string) {
  const folder = process.env.CHISEL_UI_CAPTURES;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.txt`), ui.captureCharFrame());
  const spans = ui.captureSpans();
  await writeFile(
    join(folder, `${name}.json`),
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
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath },
      undefined,
      false,
      false,
      defaultExtensions([fixture.extension], { configPath }),
      async () => ui.renderer,
    );
    await Bun.sleep(20);
  });
  await until(() => fixture.reads() >= 3, "Нет UI binding");
  await until(
    () => !!ui.renderer.root.findDescendantById("prompt-editor"),
    "Нет готового ввода главной",
  );
  for (const key of [
    "builtin.background/status",
    "builtin.lsp/status",
    "builtin.subagents/status",
  ])
    assert.ok(!ui.renderer.root.findDescendantById(`ui-status-${key}`));
  assert.ok(!ui.renderer.root.findDescendantById("ui-status-more"));
  await capture("production-clean-home-160x50");
  await key("F9");
  await until(
    () => !!ui.renderer.root.findDescendantById("ui-status-overflow-popup"),
    "F9 не открыл состояния сервисов на главной",
  );
  assert.match(ui.captureCharFrame(), /Фон 0/);
  await capture("production-services-160x50");
  await key("escape");
  const beforeNetwork = networkCalls;
  await key("b", true);
  await until(
    () => !!ui.renderer.root.findDescendantById("sidebar-panel"),
    "Нет панели",
  );
  await click("sidebar-tab-context");
  await capture("production-context-160x50");
  assert.ok(ui.captureCharFrame().includes("Анализ кода"));
  assert.ok(ui.captureCharFrame().includes("Файлы ещё не проверены"));
  await click("sidebar-tab-menu");
  await key("END");
  await key("RETURN");
  assert.ok(!ui.renderer.root.findDescendantById("extension-details-popup"));
  await capture("production-menu-160x50");
  await key(" ");
  await until(
    () => !!ui.renderer.root.findDescendantById("extension-details-popup"),
    "Space не открыл generic view",
  );
  assert.ok(ui.captureCharFrame().includes("Обзор расширения"));
  assert.equal(fixture.writes(), 0);
  for (const [width, height] of [
    [160, 50],
    [120, 40],
    [80, 24],
    [40, 12],
    [24, 8],
  ]) {
    await act(async () => ui.renderer.resize(width!, height!));
    await frame();
    const back = ui.renderer.root.findDescendantById("extension-close");
    assert.ok(back);
    assert.ok(
      back.y < height! && back.x < width!,
      "Назад недоступен на маленьком экране",
    );
    await capture(`production-details-${width}x${height}`);
  }
  await act(async () => ui.renderer.resize(120, 40));
  await frame();
  await key("c", true);
  assert.equal(fixture.writes(), 0);
  // Native click captures the selected row, then passes through the ordinary permission arbiter.
  await click("extension-row-row-0");
  await act(async () => {
    ui.mockInput.pressEnter();
    ui.mockInput.pressEnter();
  });
  await frame();
  await until(
    () => !!ui.renderer.root.findDescendantById("approval-popup"),
    "Нет обычного разрешения для UI tool",
  );
  assert.equal(fixture.writes(), 0);
  await capture("production-approval-120x40");
  await key("y");
  await until(() => fixture.writes() === 1, "UI tool не записал файл");
  assert.equal(
    await readFile(join(root, "ui-result.txt"), "utf8"),
    "Проверка 1",
  );
  const store = await projectSessionStore(root);
  await until(async () => (await store.list()).length > 0, "Нет checkpoint");
  await until(async () => {
    const summary = (await store.list())[0];
    if (!summary) return false;
    const checkpoint = await store.load(summary.id);
    return Object.values(checkpoint.runtime?.invocations ?? {}).some(
      (item) =>
        item.name === "ext:fixture.interface:save" &&
        item.result?.output === "Выбор сохранён",
    );
  }, "Terminal tool result не сохранён в checkpoint");
  const saved = await store.load((await store.list())[0]!.id);
  assert.ok(
    Object.values(saved.runtime?.invocations ?? {}).some(
      (item) =>
        item.name === "ext:fixture.interface:save" &&
        item.result?.output === "Выбор сохранён",
    ),
  );
  assert.equal(saved.messages.length, 0, "UI action создал model messages");
  await key("escape");
  await key("b", true); // owner rebind after session creation; reach menu through the same navigation
  if (!ui.renderer.root.findDescendantById("sidebar-panel"))
    await key("b", true);
  await click("sidebar-tab-menu");
  await key("END");
  await key(" ");
  await until(
    () => !!ui.renderer.root.findDescendantById("extension-details-popup"),
    "Повторное открытие не работает",
  );
  await click("extension-refresh");
  await until(
    () => !!ui.renderer.root.findDescendantById("extension-row-row-64"),
    "Нет следующей страницы",
  );
  assert.ok(!ui.renderer.root.findDescendantById("extension-row-row-0"));
  assert.equal(
    networkCalls,
    beforeNetwork,
    "Просмотр или действие запустило сеть/модель",
  );
  await key("escape");
  await act(async () => fixture.update(true));
  await until(
    () => ui.captureCharFrame().includes("Данные недоступны"),
    "Ошибка contribution не изолирована",
  );
  await capture("production-unavailable-120x40");
  await act(async () => fixture.update(false));
  await key("escape");
  assert.ok(!ui.renderer.root.findDescendantById("ui-status-more"));
  await key("F9");
  await until(
    () => !!ui.renderer.root.findDescendantById("ui-status-overflow-popup"),
    "F9 не открыл состояния сервисов",
  );
  await capture("production-overflow-120x40");
  await key("escape");
  await click("prompt-editor");
  await key("a", true);
  await key("k", true);
  await act(async () => {
    await ui.mockInput.pasteBracketedText("/exit");
    ui.mockInput.pressEnter();
  });
  await frame();
  await application;
  assert.equal(fixture.subscribers(), 0);
  console.log(
    "UI contributions: production slots, Space, generic pages, normal approval, real file, checkpoint and dispose verified",
  );
} finally {
  if (application) {
    process.emit("SIGTERM");
    await application.catch(() => {});
  }
  globalThis.fetch = nativeFetch;
  ui.renderer.destroy();
  await rm(storage, { recursive: true, force: true });
}
