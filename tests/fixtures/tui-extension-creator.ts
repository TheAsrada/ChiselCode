import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core";
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
const composer = process.argv[2] === "composer";
const originalPackage = composer
  ? process.env.CHISEL_ORIGINAL_COMPOSER
  : undefined;
const example = composer ? "refined-composer" : "workbench";
const archivedFiles = originalPackage
  ? ((await Bun.file(originalPackage).json()) as Record<string, string>)
  : undefined;
const manifest = JSON.parse(
  archivedFiles?.["chisel-extension.json"] ??
    (await readFile(
      resolve("examples/extensions", example, "chisel-extension.json"),
      "utf8",
    )),
);
const moduleSource =
  archivedFiles?.["index.mjs"] ??
  (await readFile(
    resolve("examples/extensions", example, "index.mjs"),
    "utf8",
  ));
const instrumented = `import { appendFileSync } from "node:fs"; appendFileSync(process.env.CHISEL_UI_IMPORTS, "import\\n");\n${moduleSource}`;
const module = composer
  ? instrumented
  : instrumented
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
const files = archivedFiles ?? {
  "chisel-extension.json": JSON.stringify(manifest),
  "index.mjs": module,
};
const composerDraft = "Привет, Composer!";
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
      } else if (step === 3) {
        assert.ok(
          body.messages
            .filter((message) => message.role === "tool")
            .at(-1)
            ?.content?.includes("установлено выключенным"),
        );
        delta = {
          content: "Расширение готово. Откройте Настройки → Расширения.",
        };
      } else {
        assert.ok(composer && !originalPackage && step === 4);
        assert.equal(body.messages.at(-1)?.content, composerDraft);
        delta = { content: "Проверочный текст получен." };
      }
      return new Response(
        `data: ${JSON.stringify({ id: "creator", choices: [{ index: 0, delta, finish_reason: step >= 3 ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
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
  await click(`extensions-item-${manifest.id}`);
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
async function verifyWorkbench() {
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
  // The existing boolean field persists and updates the mounted UI automatically.
  await click("extensions-setting-compact");
  await until(
    () => ui.captureCharFrame().includes("Сохранено"),
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
  assert.equal(calls, 3);
}
async function verifyComposer() {
  const editor = () =>
    ui.renderer.root.findDescendantById("prompt-editor") as
      | TextareaRenderable
      | undefined;
  const focused = () =>
    !!editor() && ui.renderer.currentFocusedEditor === editor();
  if (originalPackage) {
    await until(
      () =>
        ui.captureCharFrame().includes("composer-wrapper · Composer · SDK:") &&
        focused(),
      "Original package did not fall back to the standard composer",
    );
    assert.ok(ui.captureCharFrame().includes("style.padding"));
    assert.ok(ui.captureCharFrame().includes("style.border"));
    assert.ok(
      ui.captureCharFrame().includes("PromptHints · SDK: style.padding"),
    );
    assert.ok(ui.captureCharFrame().includes("Опишите задачу..."));
    await capture("original-fallback");
    return;
  }
  await until(
    () =>
      ui.captureCharFrame().includes("Refined Composer") &&
      ui.captureCharFrame().includes("С чем помочь?") &&
      focused(),
    "Native Composer styling or focus did not apply",
  );
  assert.match(ui.captureCharFrame(), /╭[^\n]*Refined Composer/);
  assert.ok(!ui.captureCharFrame().includes("сохранён стандартный вид"));
  await capture("composer-enabled");
  await act(async () => ui.renderer.resize(46, 25));
  await until(
    () => ui.captureCharFrame().includes("С чем помочь?") && focused(),
    "Composer styling or focus disappeared on a narrow terminal",
  );
  await capture("composer-narrow");
  await act(async () => ui.renderer.resize(130, 44));
  await act(async () => {
    ui.mockInput.typeText("Привет, Compose!");
    ui.mockInput.pressArrow("left");
    ui.mockInput.typeText("r");
  });
  await until(
    () => editor()?.plainText === composerDraft,
    "Native cursor edit failed",
  );
  await key("RETURN");
  await until(
    () =>
      calls === 4 &&
      ui.captureCharFrame().includes("Проверочный текст получен.") &&
      focused(),
    "Native Composer failed to send the exact text",
  );
  await act(async () => {
    ui.mockInput.typeText("Черновик");
    ui.mockInput.pressArrow("left");
  });
  await until(() => editor()?.plainText === "Черновик", "No draft to preserve");
  const cursor = editor()!.cursorOffset;
  await settings();
  await click("extensions-action-disable");
  await closeSettings();
  await until(
    () =>
      /┌[^\n]*Черновик/.test(ui.captureCharFrame()) &&
      !ui.captureCharFrame().includes("Refined Composer") &&
      focused(),
    "Disable did not restore the native view and focus",
  );
  assert.equal(editor()!.plainText, "Черновик");
  assert.equal(editor()!.cursorOffset, cursor);
  await capture("composer-disabled");
  await act(async () => ui.mockInput.typeText("!"));
  await until(
    () => editor()?.plainText === "Чернови!к",
    "Native editing after disable failed",
  );
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
    composer
      ? "Оформи строку ввода и сохрани её штатное поведение."
      : "Создай расширение: панель над вводом, мой логотип и компактные ответы, с кнопкой сохранения заметки.",
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
  if (!originalPackage)
    assert.equal(
      await readFile(process.env.CHISEL_UI_IMPORTS!, "utf8"),
      "import\n",
    );
  await capture("enabled-settings");
  await closeSettings();
  if (composer) await verifyComposer();
  else await verifyWorkbench();
  const saved = await projectSessionStore(root);
  const session = await saved.load((await saved.list())[0]!.id);
  assert.equal(
    session.runtime?.invocations["create-extension"]?.state,
    "succeeded",
  );
  console.log(
    `Extension creator OpenTUI: ${
      originalPackage
        ? "original Composer fallback verified"
        : composer
          ? "Composer live style, native input, submit and disable verified"
          : "workbench settings, approved and denied UI writes, narrow layout and disable verified"
    }`,
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
