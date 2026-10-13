import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { execa } from "execa";
import { act } from "react";
import {
  extensionsDirectory,
  inspectPackage,
} from "../../src/extensions/external/package.js";
import { approvePackage } from "../../src/extensions/external/registry.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-theme-tui-"));
const root = join(storage, "Проект тем"),
  author = join(storage, "Автор тем");
for (const key of [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(storage, "Home");
await mkdir(root);
await mkdir(author);
const configPath = join(storage, "config.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    profiles: {},
    ui: {
      theme: "obsidian",
      unicodeDecorations: process.env.CHISEL_CAPTURE_UNICODE === "1",
      accent: "#a286f6",
    },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);
const example = resolve("tests/fixtures/extensions/themes");
await copyFile(join(example, "index.ts"), join(author, "index.ts"));
const bun = Bun.which("bun");
assert.ok(bun);
await execa(
  bun,
  [
    "build",
    join(author, "index.ts"),
    "--target",
    "bun",
    "--outfile",
    join(author, "index.mjs"),
  ],
  { cwd: author },
);
const packageDir = join(await extensionsDirectory(), "Темы интерфейса");
await mkdir(packageDir);
await copyFile(join(author, "index.mjs"), join(packageDir, "index.mjs"));
await copyFile(
  join(example, "chisel-extension.json"),
  join(packageDir, "chisel-extension.json"),
);
const candidate = await inspectPackage(packageDir);
await approvePackage(packageDir, candidate.manifest.id, candidate.digest, true);
const originalFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = Object.assign(
  async () => {
    fetches++;
    return new Response("Offline", { status: 503 });
  },
  { preconnect: originalFetch.preconnect },
);
let ui!: Awaited<ReturnType<typeof createTestRenderer>>;
let application: Promise<void> | undefined;
async function frame() {
  await act(async () => {
    await ui.renderOnce();
    await ui.renderOnce();
  });
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() > deadline)
      throw Error(message + "\n" + ui.captureCharFrame());
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
  }
}
async function key(name: string, ctrl = false) {
  await act(async () => {
    ui.mockInput.pressKey(name as Parameters<typeof ui.mockInput.pressKey>[0], {
      ctrl,
    });
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame();
}
async function click(id: string) {
  const item = ui.renderer.root.findDescendantById(id);
  assert.ok(item, `Нет ${id}`);
  await act(async () => {
    await ui.mockMouse.click(item.x + 1, item.y);
  });
  await frame();
}
async function capture(name: string) {
  const folder = process.env.CHISEL_THEME_CAPTURES;
  if (!folder) return;
  await frame();
  await mkdir(folder, { recursive: true });
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
async function start() {
  ui = await createTestRenderer({ width: 160, height: 50, exitOnCtrlC: false });
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath },
      undefined,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
  });
  await until(
    () => !!ui.renderer.root.findDescendantById("welcome"),
    "Нет ordinary TUI",
  );
  await click("prompt-editor");
  await act(async () =>
    ui.mockInput.pasteBracketedText("Сохранённый черновик темы"),
  );
  await frame();
}
async function stop() {
  if (application) {
    process.emit("SIGTERM");
    await application;
    application = undefined;
  }
  ui.renderer.destroy();
}
async function openThemes() {
  await key("t", true);
  await until(
    () =>
      !!ui.renderer.root.findDescendantById(
        "settings-theme-extension:fixture.themes:north",
      ),
    "Нет тем ordinary loader",
  );
}
try {
  await start();
  const requests = fetches;
  const editor = ui.renderer.currentFocusedEditor;
  await openThemes();
  assert.match(ui.captureCharFrame(), /Север и лён/);
  for (const [id, name] of [
    ["north", "Север"],
    ["linen", "Лён"],
  ] as const) {
    await click(`settings-theme-extension:fixture.themes:${id}`);
    const expected = id === "north" ? [25, 34, 51] : [239, 233, 221];
    const popup = ui.renderer.root.findDescendantById(
      "settings-popup",
    ) as BoxRenderable;
    assert.deepEqual(
      popup.backgroundColor.toInts().slice(0, 3),
      expected,
      "Предпросмотр не применил настоящую палитру окна",
    );
    for (const [width, height] of [
      [160, 50],
      [80, 24],
      [40, 12],
      [24, 8],
    ]) {
      await act(async () => ui.renderer.resize(width!, height!));
      await frame();
      assert.ok(ui.renderer.root.findDescendantById("settings-apply-theme"));
      assert.ok(ui.renderer.root.findDescendantById("settings-cancel-theme"));
      assert.ok(
        ui.captureCharFrame().includes(`> ${name}`),
        "Resize скрыл выбранную тему\n" + ui.captureCharFrame(),
      );
      await capture(`${id}-catalog-${width}x${height}`);
    }
    await act(async () => ui.renderer.resize(160, 50));
    await frame();
    await click("settings-apply-theme");
    await until(
      () => ui.captureCharFrame().includes("Тема сохранена"),
      "Выбор не сохранён",
    );
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.ui.theme, `extension:fixture.themes:${id}`);
    assert.equal(saved.ui.accent, "#a286f6");
    await key("ESCAPE");
    await frame();
    assert.equal(ui.renderer.currentFocusedEditor, editor);
    assert.equal(editor?.plainText, "Сохранённый черновик темы");
    for (const [width, height] of [
      [160, 50],
      [40, 12],
      [24, 8],
    ]) {
      await act(async () => ui.renderer.resize(width!, height!));
      await capture(`${id}-interface-${width}x${height}`);
    }
    await act(async () => ui.renderer.resize(160, 50));
    await openThemes();
    assert.match(ui.captureCharFrame(), new RegExp(name));
  }
  await click("settings-theme-extension:fixture.themes:north");
  await click("settings-cancel-theme");
  assert.equal(
    JSON.parse(await readFile(configPath, "utf8")).ui.theme,
    "extension:fixture.themes:linen",
  );
  await key("/");
  await act(async () => ui.mockInput.typeText("Спокойная"));
  await key("RETURN");
  assert.ok(
    ui.renderer.root.findDescendantById(
      "settings-theme-extension:fixture.themes:north",
    ),
  );
  assert.ok(
    !ui.renderer.root.findDescendantById(
      "settings-theme-extension:fixture.themes:linen",
    ),
    ui.captureCharFrame(),
  );
  await click("settings-cancel-theme");
  await key("ESCAPE");
  assert.equal(
    fetches,
    requests,
    "Просмотр/выбор тем не запрашивает модель или сеть",
  );
  await stop();
  await start();
  assert.deepEqual(
    ui.captureSpans().lines[0]!.spans[0]!.bg.toInts().slice(0, 3),
    [247, 244, 238],
    "Запуск не восстановил реальную светлую палитру",
  );
  await capture("linen-restored-160x50");
  await openThemes();
  assert.match(ui.captureCharFrame(), /Лён \+/);
  await key("ESCAPE");
  await stop();
  await rm(packageDir, { recursive: true, force: true });
  await start();
  await until(
    () =>
      ui.captureCharFrame().includes("Выбранная тема расширения недоступна"),
    "Нет fallback notice",
  );
  await capture("unavailable-fallback-160x50");
  await key("t", true);
  assert.ok(
    !ui.renderer.root.findDescendantById(
      "settings-theme-extension:fixture.themes:linen",
    ),
  );
  assert.ok(ui.renderer.root.findDescendantById("settings-theme-obsidian"));
  await key("ESCAPE");
  await stop();
  console.log(
    "Extension themes TUI: ordinary external loader, dark/light native preview, search, apply/cancel, draft/focus, persistence, accent and unavailable fallback verified",
  );
} finally {
  if (application) await stop();
  globalThis.fetch = originalFetch;
  await rm(storage, { recursive: true, force: true });
}
