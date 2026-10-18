import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { extensionRecords } from "../../src/extensions/external/registry.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

const directory = await mkdtemp(join(tmpdir(), "chisel-ui-creator-"));
for (const name of [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "LOCALAPPDATA",
  "APPDATA",
])
  process.env[name] = join(directory, "home");
process.env.OPENAI_API_KEY = "ui-creator-fixture";
process.env.CHISEL_UI_IMPORTS = join(directory, "imports.txt");
const root = join(directory, "workspace");
await mkdir(root);
const manifest = JSON.parse(
  await readFile(
    resolve("examples/extensions/workbench/chisel-extension.json"),
    "utf8",
  ),
);
const module = (
  await readFile(resolve("examples/extensions/workbench/index.mjs"), "utf8")
)
  .replace(
    "// Self-contained",
    'import { appendFileSync } from "node:fs"; appendFileSync(process.env.CHISEL_UI_IMPORTS, "import\\n");\n// Self-contained',
  )
  .replace(
    "const settings = await sdk.settings.read();",
    "const settings = await sdk.settings.read(); if (!settings.compact) ctx.ui.register({id:'fault',slot:'render',surfaces:['SidebarMenu'],scope:'workspace',title:'Сбой виджета',source:{snapshot(){throw Error('private fixture source failure')}}});",
  )
  .replace(
    "const actions = [",
    'ctx.tools.register(sdk.defineTool({ name: "save_note", description: "Сохранить заметку", effect: "workspace_write", inputSchema: {type:"object",properties:{},additionalProperties:false}, prepare(invocation) { return invocation.plan.writeText("mod-note.txt", "Заметка через UI расширения\\n"); }, execute(invocation) { return invocation.effects.run(); } }));\n    const actions = [{ id: "save", label: "Сохранить заметку", type: "tool", tool: "save_note" }, ',
  )
  .replace(
    '{ type: "button", label: "Сведения", action: { id: "details" } },',
    '{ type: "button", label: "Сведения", action: { id: "details" } }, { type: "button", label: "Сохранить заметку", action: { id: "save" } },',
  );
const files = {
  "chisel-extension.json": JSON.stringify(manifest),
  "index.mjs": module,
};
let calls = 0,
  failure: unknown;
const tool = (id: string, name: string, input: object) => ({
  index: 0,
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(input) },
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/models"))
      return Response.json({
        data: [
          { id: "creator", context_window: 65536, max_output_tokens: 8192 },
        ],
      });
    try {
      const body = (await request.json()) as {
        messages: { role: string; content?: string }[];
      };
      const step = ++calls;
      let delta: object;
      if (step === 1) {
        assert.ok(
          JSON.stringify(body.messages).includes(
            "<name>extension-creator</name>",
          ),
        );
        delta = {
          tool_calls: [
            tool("load-creator", "load_skill", { name: "extension-creator" }),
          ],
        };
      } else if (step === 2) {
        assert.ok(
          body.messages
            .filter((message) => message.role === "tool")
            .at(-1)
            ?.content?.includes("# Extension Creator"),
        );
        delta = {
          tool_calls: [tool("create-extension", "create_extension", { files })],
        };
      } else {
        assert.equal(step, 3, "UI actions must not call a model");
        assert.ok(
          body.messages
            .filter((message) => message.role === "tool")
            .at(-1)
            ?.content?.includes("установлено выключенным"),
        );
        delta = {
          content: "Расширение готово: включите Мой рабочий стол в настройках.",
        };
      }
      return new Response(
        `data: ${JSON.stringify({ id: "creator", choices: [{ index: 0, delta, finish_reason: step === 3 ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    } catch (error) {
      failure = error;
      return Response.json(
        { error: { message: "Fixture assertion" } },
        { status: 500 },
      );
    }
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
        defaultModel: "creator",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
    },
    ui: {
      theme: process.env.CHISEL_CAPTURE_THEME ?? "obsidian",
    },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const ui = await createTestRenderer({
  width: 130,
  height: 44,
  exitOnCtrlC: false,
});
let application: ReturnType<typeof runOpenTuiAgent> | undefined;
async function until(ready: () => boolean, label: string) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
    if (ready()) return;
  }
  throw Error(`${label}\n${ui.captureCharFrame()}`);
}
async function key(
  name: string,
  modifiers?: { ctrl?: boolean; meta?: boolean },
) {
  await act(async () => ui.mockInput.pressKey(name, modifiers));
}
async function click(id: string) {
  await until(() => !!ui.renderer.root.findDescendantById(id), `Missing ${id}`);
  const node = ui.renderer.root.findDescendantById(id)!;
  let parent = node.parent;
  while (parent) {
    if (parent instanceof ScrollBoxRenderable) {
      const scroll = parent;
      await act(async () => {
        scroll.scrollChildIntoView(id);
        await ui.renderOnce();
      });
    }
    parent = parent.parent;
  }
  await until(() => {
    let ancestor = node.parent;
    while (ancestor) {
      if (
        ancestor instanceof ScrollBoxRenderable &&
        (node.y < ancestor.viewport.y ||
          node.y >= ancestor.viewport.y + ancestor.viewport.height)
      ) {
        ancestor.scrollChildIntoView(id);
        return false;
      }
      ancestor = ancestor.parent;
    }
    return (
      node.width > 0 &&
      node.height > 0 &&
      node.y >= 0 &&
      node.y < ui.renderer.height
    );
  }, `Target is not visible: ${id}`);
  await act(async () => {
    await ui.renderOnce();
    await ui.mockMouse.click(node.x + Math.min(1, node.width - 1), node.y);
  });
}
async function send(text: string) {
  await until(() => !!ui.renderer.currentFocusedEditor, "No editor");
  await act(async () => {
    await ui.mockInput.typeText(text);
    ui.mockInput.pressEnter();
  });
}
async function capture(name: string) {
  const output = process.env.CHISEL_CAPTURE_DIR;
  if (!output) return;
  await act(async () => ui.renderOnce());
  await mkdir(output, { recursive: true });
  await writeFile(join(output, `${name}.txt`), ui.captureCharFrame());
  const spans = ui.captureSpans();
  await writeFile(
    join(output, `${name}.json`),
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
async function settings() {
  await key("t", { ctrl: true });
  await click("settings-route-extensions");
  await click("extensions-item-example.workbench");
}
async function closeSettings() {
  for (
    let tries = 0;
    tries < 4 && ui.renderer.root.findDescendantById("settings-popup");
    tries++
  ) {
    await key("ESCAPE");
    await until(
      () => !ui.captureCharFrame().includes("Выполняется"),
      "Settings busy",
    );
    await act(async () => {
      await Bun.sleep(125);
      await ui.renderOnce();
    });
  }
  await until(
    () => !ui.renderer.root.findDescendantById("settings-popup"),
    "Settings still open",
  );
}
async function action(index: number) {
  await key("u", { meta: true });
  await until(
    () =>
      !!ui.renderer.root.findDescendantById("ui-composition-controls-popup"),
    "No UI action picker",
  );
  for (let i = 0; i < index; i++) await key("ARROW_DOWN");
  await key("RETURN");
}
try {
  await act(async () => {
    application = runOpenTuiAgent(
      { cwd: root, configPath, allow: "create_extension" },
      undefined,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
    void application.catch((error) => {
      failure = error;
    });
  });
  await send(
    "Создай расширение: панель над вводом, мой логотип и компактные ответы, с кнопкой сохранения заметки.",
  );
  await until(
    () =>
      calls === 3 &&
      ui.captureCharFrame().includes("Расширение готово") &&
      !ui.renderer.root.findDescendantById("request-status"),
    "Creation did not finish",
  );
  const record = (await extensionRecords()).find(
    (record) => record.id === manifest.id,
  );
  assert.ok(record);
  assert.equal(record.enabled, false);
  assert.equal(record.approvedAt, undefined);
  assert.equal(await Bun.file(process.env.CHISEL_UI_IMPORTS!).exists(), false);
  await settings();
  await capture("created-disabled");
  await click("extensions-action-trust");
  await click("extensions-trust");
  await click("extensions-commit");
  await until(
    () => ui.captureCharFrame().includes("Работает"),
    "Live enable did not activate",
  );
  assert.equal(
    await readFile(process.env.CHISEL_UI_IMPORTS!, "utf8"),
    "import\n",
  );
  await capture("enabled-settings");
  await closeSettings();
  await until(
    () =>
      ui.captureCharFrame().includes("Фон: 0") &&
      ui.captureCharFrame().includes("Ответ агента"),
    "Custom surfaces absent",
  );
  await capture("live-workbench");
  await key("g", { ctrl: true });
  await until(
    () =>
      !!ui.renderer.root.findDescendantById("welcome") &&
      ui.captureCharFrame().includes("[i] Мой рабочий стол"),
    "Custom home logo absent",
  );
  await capture("custom-home");
  await key("ARROW_RIGHT", { meta: true });
  await until(
    () =>
      !ui.renderer.root.findDescendantById("welcome") &&
      ui.captureCharFrame().includes("Фон: 0"),
    "Conversation not restored",
  );
  await action(0);
  await until(
    () => ui.captureCharFrame().includes("включено без перезапуска"),
    "View button failed",
  );
  await key("ESCAPE");
  await until(
    () => !ui.renderer.root.findDescendantById("extension-details-popup"),
    "View not closed",
  );
  await action(1);
  await until(
    () => !!ui.renderer.root.findDescendantById("approval-popup"),
    "UI write bypassed approval",
  );
  await capture("protected-approval");
  await click("approval-deny");
  await until(
    () =>
      !ui.renderer.root.findDescendantById("request-status") &&
      !ui.renderer.root.findDescendantById("approval-popup"),
    "Denied action did not settle",
  );
  assert.equal(await Bun.file(join(root, "mod-note.txt")).exists(), false);
  await action(1);
  await until(
    () => !!ui.renderer.root.findDescendantById("approval-popup"),
    "No repeat approval",
  );
  await click("approval-approve");
  await until(
    () => !ui.renderer.root.findDescendantById("request-status"),
    "Approved action did not settle",
  );
  assert.equal(
    await readFile(join(root, "mod-note.txt"), "utf8"),
    "Заметка через UI расширения\n",
  );
  assert.equal(calls, 3);
  await act(async () => {
    ui.renderer.resize(46, 25);
    await ui.renderOnce();
  });
  await capture("narrow-workbench");
  await act(async () => {
    ui.renderer.resize(130, 44);
    await ui.renderOnce();
  });
  await settings();
  await click("extensions-action-settings");
  await until(
    () => !!ui.renderer.root.findDescendantById("extensions-setting-title"),
    "No mod settings",
  );
  // Settings test uses the existing boolean field and the standard save route.
  await click("extensions-setting-compact");
  await key("s", { ctrl: true });
  await until(
    () => ui.captureCharFrame().includes("Интерфейс расширения обновлён"),
    "Settings require restart",
  );
  await closeSettings();
  await until(
    () =>
      !ui.captureCharFrame().includes("Ответ агента") &&
      ui.captureCharFrame().includes("Фон: 0"),
    "Fresh settings snapshot not used",
  );
  assert.equal(
    await readFile(process.env.CHISEL_UI_IMPORTS!, "utf8"),
    "import\n",
    "ESM module evaluated once",
  );
  await until(
    () => ui.captureCharFrame().includes("сохранён стандартный вид"),
    "Provider fallback invisible",
  );
  await capture("provider-fallback");
  await settings();
  await click("extensions-action-disable");
  await closeSettings();
  await until(
    () => !ui.captureCharFrame().includes("Фон: 0"),
    "Disable did not restore native UI",
  );
  await capture("disabled-restored");
  const saved = await projectSessionStore(root);
  const session = await saved.load((await saved.list())[0]!.id);
  assert.equal(
    session.runtime?.invocations["create-extension"]?.state,
    "succeeded",
  );
  assert.equal(calls, 3);
  console.log(
    "Extension creator OpenTUI: agent install disabled, exact trust/live enable, view/keyboard, approved and denied UI writes, settings, narrow layout, live disable, checkpoints verified",
  );
} finally {
  if (application)
    await act(async () => {
      process.emit("SIGTERM");
      await application?.catch(() => {});
    });
  server.stop(true);
  ui.renderer.destroy();
  await rm(directory, { recursive: true, force: true });
}
