import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createSessionToolRuntime } from "../../src/app/tool-runtime.js";
import type { BackgroundControls } from "../../src/background/binding.js";
import { loadGlobalConfig, loadProjectConfig } from "../../src/config/load.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";
import { quoteShellArg } from "../helpers/shell.js";

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-tui-background-owner-")),
);
for (const key of [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(directory, "home");
process.env.OPENAI_API_KEY = "fixture-background-owner-key";
const root = join(directory, "Проект владельца");
const alias = join(directory, "Ссылка на проект");
await mkdir(root);
await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
let calls = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
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
    calls++;
    return new Response(
      `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: `Разговор продолжен: ${calls}.` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
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
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);
const host = new ExtensionHost(defaultExtensions());
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ui = await createTestRenderer({
  width: 120,
  height: 40,
  exitOnCtrlC: false,
});
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
let applicationError: unknown;
async function frame() {
  await act(async () => {
    await ui.renderOnce();
  });
}
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (applicationError) throw applicationError;
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
    if (check()) return;
  }
  throw new Error(`${label}\n${ui.captureCharFrame()}`);
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
try {
  const scope = await host.open(root);
  const store = await projectSessionStore(root);
  const session = store.create("openai-compatible", "fixture-model");
  session.profileId = "fixture";
  session.mode = "build";
  await store.save(session);
  const source = join(root, "once.cjs");
  await writeFile(
    source,
    "require('node:fs').appendFileSync('launches.txt','one\\n');console.log('Сохранённый вывод задачи');",
  );
  let controls!: BackgroundControls;
  const tools = await createSessionToolRuntime({
    root,
    session,
    store,
    scope,
    config: await loadProjectConfig(root),
    global: await loadGlobalConfig(configPath),
    options: { configPath, interactive: true, allow: "run_shell" },
    mode: "build",
    approvalMode: "default",
    events: new RuntimeEventBus(session.id),
    resolver: { requestApproval: async () => "approved" },
    signal: new AbortController().signal,
    onBackgroundControls: (value) => {
      controls = value;
    },
  });
  try {
    const result = await tools.executor.execute({
      id: "once-before-restart",
      name: "run_shell",
      input: {
        command: `${quoteShellArg(process.argv[2] ?? process.execPath)} ${quoteShellArg(source)}`,
        background: true,
        label: "Завершённая проверка",
      },
    });
    assert.ok(!result.isError, result.output);
    const accepted = result.details?.backgroundTask as
      | { id: string }
      | undefined;
    assert.ok(accepted);
    const id = accepted.id;
    const [task] = await controls.port.wait([id], 10000);
    assert.ok(task);
    assert.equal(task.state, "completed");
    assert.equal(task.cleanup.confirmed, true);
    assert.match(
      (await controls.port.readOutput(id)).text,
      /Сохранённый вывод/,
    );
  } finally {
    await tools.dispose();
    await host.dispose();
  }
  const restored = await store.load(session.id);
  // Old sessions can store mixed-case Windows paths or a junction/symlink alias.
  restored.projectPath =
    process.platform === "win32" ? alias.toUpperCase() : alias;
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath },
      restored,
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
    () => ui.captureCharFrame().includes("Завершённая проверка"),
    "История задач не восстановлена",
  );
  assert.equal(calls, 0, "Восстановление не обращается к модели");
  for (let turn = 1; turn <= 2; turn++) {
    await send(`Продолжи разговор, сообщение ${turn}`);
    await until(
      () =>
        ui.captureCharFrame().includes(`Разговор продолжен: ${turn}.`) &&
        !ui.captureCharFrame().includes("Думаю") &&
        !ui.renderer.root.findDescendantById("request-status"),
      "Восстановленный разговор не продолжился",
    );
    assert.equal(calls, turn);
    assert.doesNotMatch(
      ui.captureCharFrame(),
      /RuntimeError|Владелец фоновых задач изменился/,
    );
  }
  assert.equal(
    await readFile(join(root, "launches.txt"), "utf8"),
    "one\n",
    "История не запускает команду повторно",
  );
  const captures = process.env.CHISEL_CAPTURE_DIR;
  if (captures) {
    await mkdir(captures, { recursive: true });
    await writeFile(
      join(captures, "background-owner-resumed.txt"),
      ui.captureCharFrame(),
    );
    const spans = ui.captureSpans();
    await writeFile(
      join(captures, "background-owner-resumed.json"),
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
  const saved = await store.load(session.id);
  assert.equal(
    saved.messages.filter((message) => message.role === "user").length,
    2,
  );
  await act(async () => {
    await ui.mockInput.pasteBracketedText("/exit");
    await ui.renderOnce();
    ui.mockInput.pressEnter();
    await application;
  });
  application = undefined;
  console.log(
    "Background owner TUI: restored path alias, two real turns, retained task and no replay",
  );
} finally {
  await host.dispose();
  if (application) {
    await act(async () => {
      process.emit("SIGTERM");
      await application?.catch(() => {});
    });
  }
  server.stop(true);
  ui.renderer.destroy();
  await rm(directory, { recursive: true, force: true });
}
