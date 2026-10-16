import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-child-settings-ui-"));
const root = join(storage, "project");
await mkdir(root);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(storage, "state");
const configPath = join(storage, "global.json");
const theme = process.env.CHISEL_SETTINGS_CAPTURE_THEME ?? "graphite";
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    profiles: {},
    ui: { theme },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
    subagents: {
      inputTokens: 1,
      outputTokens: 1,
      childTokens: 1,
      ownerTokens: 1,
    },
  }),
);
const ui = await createTestRenderer({
  width: 120,
  height: 40,
  exitOnCtrlC: false,
});
let application: Promise<void> | undefined;
const frame = async () => {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
};
const until = async (check: () => boolean) => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(ui.captureCharFrame());
    await frame();
  }
};
const click = async (id: string) => {
  await frame();
  const node = ui.renderer.root.findDescendantById(id);
  assert.ok(node, `${id}\n${ui.captureCharFrame()}`);
  await act(async () => {
    await ui.mockMouse.click(node.x + 1, node.y);
  });
  await frame();
};
try {
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
  await until(() => !!ui.renderer.root.findDescendantById("welcome"));
  await click("prompt-editor");
  await act(async () =>
    ui.mockInput.pasteBracketedText("Черновик перед настройками помощников"),
  );
  await act(async () => ui.mockInput.pressKey("t", { ctrl: true }));
  await until(
    () =>
      !!ui.renderer.root.findDescendantById("settings-route-tools.subagents"),
  );
  await click("settings-route-tools.subagents");
  await until(() => ui.captureCharFrame().includes("Одновременно: 2"));
  assert.doesNotMatch(
    ui.captureCharFrame(),
    /Токены|токенов|Owner tokens|Child tokens/,
  );
  const captures = process.env.CHISEL_SUBAGENT_SETTINGS_CAPTURES;
  for (const [width, height] of [
    [120, 40],
    [80, 24],
    [40, 16],
    [24, 8],
  ]) {
    await act(async () => ui.resize(width!, height!));
    await frame();
    if (!captures) continue;
    await mkdir(captures, { recursive: true });
    const name = `${theme}-${width}x${height}`;
    const spans = ui.captureSpans();
    await writeFile(join(captures, `${name}.txt`), ui.captureCharFrame());
    await writeFile(
      join(captures, `${name}.json`),
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
  await act(async () => ui.resize(120, 40));
  await frame();
  await act(async () => {
    ui.mockInput.pressKey("ESCAPE");
    await Bun.sleep(120);
  });
  await until(() => !ui.renderer.root.findDescendantById("settings-popup"));
  assert.match(ui.captureCharFrame(), /Черновик перед настройками помощников/);
  console.log(
    "Subagent Settings: actual native UI, legacy config migration, no token fields, compact layout and draft preserved",
  );
} finally {
  if (application) {
    process.emit("SIGTERM");
    await application;
  }
  ui.renderer.destroy();
  await rm(storage, { recursive: true, force: true });
}
