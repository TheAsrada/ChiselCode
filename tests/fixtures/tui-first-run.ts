import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { loadGlobalConfig } from "../../src/config/load.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";
import { menuAction } from "./menu-navigation.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-first-run-")),
);
for (const name of [
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[name] = join(directory, "home");
delete process.env.OPENAI_API_KEY;
delete process.env.OPENCODE_CONFIG;
const cwd = join(directory, "Проект");
await mkdir(cwd);
const configPath = join(directory, "config.json");
const calls: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    assert.equal(request.headers.get("authorization"), "Bearer fixture-key");
    const route = new URL(request.url).pathname;
    calls.push(route);
    if (route === "/v1/models")
      return Response.json({ data: [{ id: "listed-model" }] });
    assert.equal(route, "/v1/chat/completions");
    const body = await request.json();
    assert.equal(body.model, "manual-model");
    assert.match(JSON.stringify(body.messages), /Первая задача в проекте/);
    return new Response(
      'data: {"id":"first-run","choices":[{"index":0,"delta":{"content":"Готово для первой задачи"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const createUi = () =>
  createTestRenderer({ width: 120, height: 36, exitOnCtrlC: false });
let ui = await createUi();
let application: ReturnType<typeof runOpenTuiAgent> | undefined;

async function start(path = configPath) {
  application = runOpenTuiAgent(
    { cwd, configPath: path, externalExtensions: false },
    undefined,
    true,
    false,
    undefined,
    async () => ui.renderer,
  );
}

async function stop() {
  if (!application) return;
  await act(async () => {
    process.emit("SIGTERM");
    await application;
  });
  application = undefined;
}

const ready = async (
  target: string | (() => boolean),
  label = typeof target === "string" ? target : "startup screen",
) => {
  const deadline = Date.now() + 4500;
  do {
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
    if (
      typeof target === "string"
        ? ui.captureCharFrame().includes(target)
        : target()
    )
      return;
  } while (Date.now() < deadline);
  assert.fail(`Missing ${label}\n${ui.captureCharFrame()}`);
};

const paste = async (text: string, submit = false) => {
  await act(async () => {
    await ui.mockInput.pasteBracketedText(text);
    if (submit) ui.mockInput.pressEnter();
  });
};

try {
  await start();
  await ready(() => !!ui.renderer.root.findDescendantById("startup-intro"));
  await act(async () => {
    ui.resize(52, 15);
    ui.mockInput.pressEscape();
    ui.mockInput.pressEnter();
  });
  assert.ok(!ui.captureCharFrame().includes("Добавить подключение"));
  await ready("Press any key");
  const waiting = ui.captureCharFrame();
  await ready(
    () =>
      ui.captureCharFrame().includes("Press any key") &&
      ui.captureCharFrame() !== waiting,
    "moving particles while waiting for a key",
  );
  assert.equal(
    (await loadGlobalConfig(configPath)).ui?.startupIntroSeen,
    undefined,
  );
  await act(async () => ui.mockInput.pressEnter());
  await ready("> Добавить подключение");
  await act(async () => ui.mockInput.pressEnter());
  await ready("Выберите сервис");
  await paste("openai-compatible");
  await ready("OpenAI-совместимый API");
  await act(async () => ui.mockInput.pressEnter());
  await ready("openai-compatible-default");
  await act(async () => ui.mockInput.pressEnter());
  await ready("Адрес API");
  await paste(`http://127.0.0.1:${server.port}`, true);
  await ready("Вставьте API-ключ");
  await stop();

  let config = await loadGlobalConfig(configPath);
  assert.equal(config.ui?.startupIntroSeen, true);
  assert.equal(config.ui?.pendingSetupProfileId, "openai-compatible-default");
  assert.equal(config.defaultProfileId, undefined);

  ui = await createUi();
  await start();
  await ready("Вставьте API-ключ");
  assert.ok(!ui.renderer.root.findDescendantById("startup-intro"));
  await paste("fixture-key", true);
  await ready("listed-model");
  await paste("manual-model");
  await ready("manual-model");
  await act(async () => ui.mockInput.pressEnter());
  await ready("Название модели");
  await act(async () => ui.mockInput.pressEnter());
  await ready("Использовать подключение");
  await menuAction(ui, "settings-actions", "settings-use-profile");
  await ready("Опишите задачу");
  assert.equal(ui.renderer.currentFocusedRenderable?.id, "prompt-editor");
  assert.ok(ui.captureCharFrame().includes("Проект"));
  assert.ok(calls.length > 0);
  assert.equal(
    calls.every((route) => route === "/v1/models"),
    true,
  );
  await paste("Первая задача в проекте", true);
  await ready("Готово для первой задачи");
  assert.equal(
    calls.filter((route) => route === "/v1/chat/completions").length,
    1,
  );
  config = await loadGlobalConfig(configPath);
  assert.equal(config.defaultProfileId, "openai-compatible-default");
  assert.equal(config.ui?.pendingSetupProfileId, undefined);
  await stop();

  const reducedConfig = join(directory, "reduced.json");
  await writeFile(
    reducedConfig,
    JSON.stringify({
      schemaVersion: 2,
      profiles: {},
      ui: { motion: "reduced" },
    }),
  );
  ui = await createUi();
  await start(reducedConfig);
  await ready("Press any key");
  assert.ok(!ui.captureCharFrame().includes("Добавить подключение"));
  await act(async () => ui.mockInput.pressKey("space"));
  await ready("> Добавить подключение");
} finally {
  await stop();
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
