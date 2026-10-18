import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { renderLogoRows } from "../../src/ui/logo.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-graphics-"));
const theme = process.env.CHISEL_CAPTURE_THEME ?? "obsidian";
for (const key of [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(storage, "home");
const configPath = join(storage, "config.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    profiles: {},
    // Deliberately write the old file directly: saveGlobalConfig already removes this key.
    ui: { theme, unicodeDecorations: false },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);
const ui = await createTestRenderer({
  width: 120,
  height: 36,
  exitOnCtrlC: false,
});
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async () => new Response("Offline fixture", { status: 503 }),
  { preconnect: nativeFetch.preconnect },
);
const frame = () =>
  act(async () => {
    await ui.renderOnce();
    await ui.renderOnce();
  });
async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw Error(`${message}\n${ui.captureCharFrame()}`);
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
  }
  await frame();
}
async function key(name: string, ctrl = false) {
  await act(async () => {
    ui.mockInput.pressKey(name, { ctrl });
  });
  await frame();
}
async function capture(name: string) {
  const folder = process.env.CHISEL_GRAPHICS_CAPTURES;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${theme}-${name}.txt`), ui.captureCharFrame());
  const spans = ui.captureSpans();
  await writeFile(
    join(folder, `${theme}-${name}.json`),
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
      { cwd: storage, configPath },
      undefined,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
  });
  await until(() => !!ui.renderer.currentFocusedEditor, "Нет редактора");
  assert.ok(
    ui.captureCharFrame().includes(renderLogoRows()[2] ?? "Missing logo"),
    "Старое false не должно отключать Coder Mini",
  );
  await capture("home-120x36");
  await act(async () => {
    await ui.mockInput.pasteBracketedText("Черновик 👩‍💻 汉字 e\u0301");
  });
  await frame();
  const editor = ui.renderer.currentFocusedEditor;
  await key("t", true);
  await until(
    () => ui.captureCharFrame().includes("Coder Mini"),
    "Нет оформления",
  );
  assert.equal(
    ui.renderer.root.findDescendantById("settings-decoration-toggle"),
    undefined,
  );
  assert.ok(ui.captureCharFrame().includes("╭"));
  await capture("settings-120x36");
  await key("g", true);
  assert.ok(ui.captureCharFrame().includes("╭"));
  await key("ESCAPE");
  await until(
    () => ui.renderer.currentFocusedEditor === editor,
    "Потерян фокус",
  );
  assert.equal(editor?.plainText, "Черновик 👩‍💻 汉字 e\u0301");
  for (const [width, height] of [
    [40, 18],
    [24, 8],
  ]) {
    await act(async () => {
      ui.resize(width!, height!);
    });
    await frame();
    assert.equal(ui.renderer.currentFocusedEditor, editor);
    assert.equal(editor?.plainText, "Черновик 👩‍💻 汉字 e\u0301");
    assert.ok(ui.captureCharFrame().includes("ChiselCode"));
    await capture(`home-${width}x${height}`);
  }
  console.log(
    `Graphical OpenTUI: ${theme}, legacy false, home/settings, focus/draft, 40x18 and 24x8 verified`,
  );
} finally {
  if (application) {
    await act(async () => {
      process.emit("SIGTERM");
      await application?.catch(() => {});
    });
  }
  globalThis.fetch = nativeFetch;
  await rm(storage, { recursive: true, force: true });
}
