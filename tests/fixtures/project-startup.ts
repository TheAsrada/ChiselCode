import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { chiselHomeDir, sessionProjectsDir } from "../../src/paths/home.js";
import { pathIdentity } from "../../src/projects/paths.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";
import { VERSION } from "../../src/version.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-startup-")),
);
for (const name of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[name] = join(directory, "home");
delete process.env.OPENAI_API_KEY;
const project = join(directory, "Проект с пробелами");
await mkdir(project);
await mkdir(chiselHomeDir(), { recursive: true });
// A poisoned service-root config would fail immediately if startup loaded it as a project.
await writeFile(join(chiselHomeDir(), ".chiselrc"), "invalid-service-config");
const archiveStore = await projectSessionStore(chiselHomeDir());
const archiveSession = archiveStore.create("openai", "fixture-model");
archiveSession.title = "Служебная история";
archiveSession.messages.push({
  role: "user",
  content: [
    { type: "text", text: "Сохранённый текст из старой служебной сессии" },
  ],
});
await archiveStore.save(archiveSession);
const archivePath = join(archiveStore.directory, `${archiveSession.id}.json`);
const archiveBytes = await readFile(archivePath, "utf8");
if (process.env.CHISEL_STARTUP_RECENT === "1")
  await projectSessionStore(project);
const calls: Record<string, unknown>[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.url.endsWith("/models"))
      return Response.json({
        data: [
          { id: "fixture-model", context_window: 65536 },
          { id: "remembered-model", context_window: 65536 },
        ],
      });
    calls.push((await request.json()) as Record<string, unknown>);
    return new Response(
      `data: ${JSON.stringify({ id: "startup", choices: [{ index: 0, delta: { content: "Проверенный ответ приложения" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
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
        providerId: "openai",
        defaultModel: "fixture-model",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
    },
    ui: { motion: "reduced" },
    web: { enabled: false },
    lsp: { mode: "off", servers: {} },
  }),
);
const width = Number(process.env.CHISEL_STARTUP_WIDTH ?? 80),
  height = Number(process.env.CHISEL_STARTUP_HEIGHT ?? 24);
const packaged = process.env.CHISEL_STARTUP_PACKAGED === "1";
let ui = await createTestRenderer({ width, height, exitOnCtrlC: false });
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
let activations = 0;
const wait = async (ready: () => boolean, label: string) => {
  const deadline = Date.now() + 12_000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `${label}\n${ui.captureCharFrame()}`);
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
  }
};
const capture = async (name: string) => {
  const output = process.env.CHISEL_STARTUP_CAPTURES;
  if (!output) return;
  await act(async () => {
    await ui.renderOnce();
  });
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, `${name}-${width}x${height}.txt`),
    ui.captureCharFrame(),
  );
  const spans = ui.captureSpans();
  await writeFile(
    join(output, `${name}-${width}x${height}.json`),
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
};
const type = async (text: string) => {
  await act(async () => {
    await ui.mockInput.pasteBracketedText(text);
  });
};
const enter = async () => {
  await act(async () => {
    ui.mockInput.pressEnter();
  });
};
const pathInput = async (text: string) => {
  const input = ui.renderer.root.findDescendantById("project-path");
  assert.ok(input);
  await act(async () => {
    ui.mockInput.pressKey("a", { ctrl: true });
    ui.mockInput.pressKey("k", { ctrl: true });
    await ui.mockInput.pasteBracketedText(text);
  });
  await act(async () => {
    await ui.renderOnce();
  });
};
const openPath = async (text: string) => {
  await pathInput(text);
  await wait(
    () => !ui.captureCharFrame().includes("Чтение папок…"),
    "folder listing ready",
  );
  const button = ui.renderer.root.findDescendantById("project-open");
  assert.ok(button);
  await act(async () => {
    await ui.mockMouse.click(button.x + 1, button.y);
  });
};
const checkHomeLayout = () => {
  const logo = ui.renderer.root.findDescendantById("welcome-logo");
  const prompt = ui.renderer.root.findDescendantById("prompt");
  const footer = ui.renderer.root.findDescendantById("home-project-status");
  const action = ui.renderer.root.findDescendantById("home-open-project");
  assert.ok(logo && prompt && footer && action);
  assert.equal(prompt.y, logo.y + logo.height + (height >= 12 ? 1 : 0));
  assert.equal(action.y, footer.y);
  assert.equal(action.width, 6);
  assert.equal(action.height, 1);
  assert.ok(action.x >= 0 && action.x + action.width <= width);
  assert.ok(action.y >= prompt.y + prompt.height && action.y < height);
  assert.ok(!ui.captureCharFrame().includes("Открыть папку /cwd"));
  assert.ok(!ui.captureCharFrame().includes("Сменить папку /cwd"));
};
const openFromFooter = async () => {
  await act(async () => {
    await ui.renderOnce();
  });
  const action = ui.renderer.root.findDescendantById("home-open-project");
  assert.ok(action);
  await act(async () => {
    await ui.mockMouse.click(action.x + 1, action.y);
  });
  await wait(
    () => !!ui.renderer.root.findDescendantById("project-path"),
    "footer opens project picker",
  );
  await wait(
    () => !ui.captureCharFrame().includes("Чтение папок…"),
    "folder listing ready",
  );
  assert.ok(!ui.captureCharFrame().includes("Недавний:"));
  await act(async () => ui.mockInput.pressEscape());
  await wait(
    () =>
      !ui.renderer.root.findDescendantById("projects-popup") &&
      !!ui.renderer.currentFocusedEditor,
    "footer picker cancellation restores composer",
  );
};
const start = async (model?: string) => {
  await act(async () => {
    application = runOpenTuiAgent(
      {
        launcher: true,
        configPath,
        externalExtensions: false,
        ...(model ? { model } : {}),
      },
      undefined,
      false,
      false,
      defaultExtensions(
        [
          {
            id: "fixture.startup",
            activate() {
              activations++;
            },
          },
        ],
        { configPath },
      ),
      async () => ui.renderer,
    );
  });
  await wait(
    () =>
      !!ui.renderer.root.findDescendantById(
        height < 10 ? "compact-terminal" : "welcome",
      ),
    "home",
  );
  if (height >= 10)
    await wait(() => !!ui.renderer.currentFocusedEditor, "composer ready");
};
try {
  await start();
  assert.equal(activations, 0);
  assert.equal(calls.length, 0);
  assert.equal(
    (await readdir(sessionProjectsDir())).length,
    process.env.CHISEL_STARTUP_RECENT === "1" ? 2 : 1,
  );
  await capture("home");
  if (height < 10) {
    console.log("Project startup compact renderer verified");
  } else {
    checkHomeLayout();
    if (width >= 24)
      assert.equal(
        ui.captureCharFrame().split("Проект не выбран").length - 1,
        1,
      );
    if (!packaged) {
      await type("/settings");
      await enter();
      await wait(
        () => !!ui.renderer.root.findDescendantById("settings-popup"),
        "global settings without project or key",
      );
      assert.equal(activations, 0);
      assert.equal(calls.length, 0);
      await act(async () => ui.mockInput.pressEscape());
      await wait(
        () =>
          !ui.renderer.root.findDescendantById("settings-popup") &&
          !!ui.renderer.currentFocusedEditor,
        "return from global settings",
      );
      await type("/resume");
      await enter();
      await wait(() => ui.captureCharFrame().includes("Архив"), "archive list");
      await enter();
      await wait(
        () => !!ui.renderer.root.findDescendantById("readonly-history"),
        "readonly archive",
      );
      assert.equal(calls.length, 0);
      assert.equal(activations, 0);
      assert.equal(await readFile(archivePath, "utf8"), archiveBytes);
      await act(async () => ui.mockInput.pressKey("c", { ctrl: true }));
      await wait(
        () => ui.captureCharFrame().includes("Продолжить разговор"),
        "return to history",
      );
      await act(async () => ui.mockInput.pressEscape());
      await wait(
        () => ui.renderer.currentFocusedEditor?.id === "prompt-editor",
        "return from history",
      );
    }
    if (!packaged) {
      process.env.OPENAI_API_KEY = "fixture-key";
      await type("/model");
      await enter();
      await wait(
        () => !!ui.renderer.root.findDescendantById("models-search"),
        "model picker",
      );
      await type("remembered-model");
      await wait(
        () =>
          !!ui.renderer.root.findDescendantById("models-row-0") &&
          ui.captureCharFrame().includes("remembered-model"),
        "remembered model available",
      );
      await enter();
      await wait(
        () => !ui.renderer.root.findDescendantById("models-popup"),
        "model chosen before a conversation exists",
      );
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(saved.ui.lastModelSelection.model, "remembered-model");
      assert.equal(saved.profiles.fixture.defaultModel, "fixture-model");
      await type("/cwd");
      await enter();
      await wait(
        () => !!ui.renderer.root.findDescendantById("projects-popup"),
        "slash folder picker",
      );
      await act(async () => ui.mockInput.pressEscape());
      await wait(
        () =>
          !ui.renderer.root.findDescendantById("projects-popup") &&
          !!ui.renderer.currentFocusedEditor,
        "slash command consumed",
      );
      assert.equal(ui.renderer.currentFocusedEditor?.plainText, "");
      await act(async () => {
        process.emit("SIGTERM");
        await application;
      });
      ui = await createTestRenderer({ width, height, exitOnCtrlC: false });
      await start("fixture-model");
      await wait(
        () => ui.captureCharFrame().includes("fixture-model"),
        "explicit CLI model wins",
      );
      await act(async () => {
        process.emit("SIGTERM");
        await application;
      });
      ui = await createTestRenderer({ width, height, exitOnCtrlC: false });
      await start();
      await wait(
        () => ui.captureCharFrame().includes("remembered-model"),
        "last explicit UI model survives restart",
      );
      assert.equal(
        ui.renderer.currentFocusedEditor?.plainText,
        "",
        "consumed /cwd cannot return after restart",
      );
    }
    const draft = "Какая версия, модель и интерфейс используются?";
    await type(draft);
    await openFromFooter();
    assert.equal(ui.renderer.currentFocusedEditor?.plainText, draft);
    assert.equal(calls.length, 0);
    assert.equal(activations, 0);
    await enter();
    await wait(
      () => !!ui.renderer.root.findDescendantById("project-path"),
      "picker",
    );
    if (!packaged) {
      await pathInput(directory);
      await wait(
        () =>
          !!ui.renderer.root.findDescendantById(
            `project-row-directory-${project}`,
          ),
        "bounded directory navigation",
      );
      await openPath(chiselHomeDir());
      await wait(
        () => ui.captureCharFrame().includes("служебная"),
        "private path refusal",
      );
      assert.equal(activations, 0);
      assert.equal(calls.length, 0);
      await capture("private-refusal");
    }
    process.env.OPENAI_API_KEY = "fixture-key";
    await openPath(project);
    await wait(
      () =>
        !ui.renderer.root.findDescendantById("projects-popup") &&
        !!ui.renderer.currentFocusedEditor,
      "project committed",
    );
    assert.equal(
      calls.length,
      0,
      "Picking a project must not submit the draft",
    );
    assert.equal(activations, 1);
    assert.equal(ui.renderer.currentFocusedEditor?.plainText, draft);
    checkHomeLayout();
    await capture("project-ready");
    if (!packaged) {
      await openFromFooter();
      assert.equal(ui.renderer.currentFocusedEditor?.plainText, draft);
      assert.equal(activations, 1);
      assert.equal(calls.length, 0);
    }
    await enter();
    await wait(
      () => ui.captureCharFrame().includes("Проверенный ответ"),
      "real runtime answer",
    );
    assert.equal(calls.length, 1);
    const payload = JSON.stringify(calls[0]);
    assert.ok(payload.includes(VERSION));
    assert.ok(
      payload.includes(packaged ? "fixture-model" : "remembered-model"),
    );
    assert.ok(payload.includes("runtime_identity"));
    assert.ok(payload.includes("ui_snapshot"));
    assert.ok(payload.includes("opentui"));
    const projects = await readdir(sessionProjectsDir());
    assert.equal(projects.length, 2);
    const selectedProject = (
      await Promise.all(
        projects.map(async (id) => ({
          id,
          metadata: JSON.parse(
            await readFile(
              join(sessionProjectsDir(), id, "project.json"),
              "utf8",
            ),
          ),
        })),
      )
    ).find(
      ({ metadata }) => pathIdentity(metadata.path) === pathIdentity(project),
    );
    assert.ok(selectedProject);
    const metadata = selectedProject.metadata;
    assert.equal(pathIdentity(metadata.path), pathIdentity(project));
    const sessionFiles = (
      await readdir(join(sessionProjectsDir(), selectedProject.id))
    ).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
    assert.equal(sessionFiles.length, 1);
    const session = await readFile(
      join(sessionProjectsDir(), selectedProject.id, sessionFiles[0]!),
      "utf8",
    );
    assert.ok(!session.includes("ui_snapshot"));
    console.log(
      packaged
        ? "Compiled application: projectless startup, native picker, preserved draft and explicit real runtime request verified"
        : "Project startup: private-root refusal, native picker, preserved draft, no automatic submission, real request identity and project-only history verified",
    );
  }
} finally {
  if (application)
    await act(async () => {
      process.emit("SIGTERM");
      await application;
    });
  await act(async () => ui.renderer.destroy());
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
}
