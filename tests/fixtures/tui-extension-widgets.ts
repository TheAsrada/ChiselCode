import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { PackageManagementService } from "../../src/extensions/packages/service.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-widgets-"));
for (const name of [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[name] = join(storage, "home");
const root = join(storage, "Проект"),
  source = join(storage, "package");
await mkdir(root);
await mkdir(source);
for (const name of ["chisel-extension.json", "index.mjs"])
  await writeFile(
    join(source, name),
    await readFile(resolve("examples/extensions/studio", name)),
  );
// Exercise callback faults in a reviewed test package; ordinary example has no failure action.
let code = await readFile(join(source, "index.mjs"), "utf8");
code = code.replace(
  'ctx.ui.on("note",',
  'ctx.ui.on("fault", () => {throw Error("token=must-not-leak")});\n    ctx.ui.on("note",',
);
code = code.replace(
  'actions: [{id: "tab",',
  'actions: [{id: "fault", label: "Проверить сбой", type: "event", eventId: "fault"}, {id: "tab",',
);
code = code.replace(
  '{type: "text", text: "Tab —',
  '{type: "button", key: "fault", label: "Проверить сбой", action: {id: "fault"}},\n              {type: "text", text: "Tab —',
);
code = code.replace(
  '{type: "text", text: "Tab —',
  '{type: "image", key: "image", alt: "Пиксель", data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGOU67nzn4GBgYGJAQoAJcoCiXWN7cIAAAAASUVORK5CYII=", style: {width: 4, height: 2}},\n              {type: "text", text: "Tab —',
);
await writeFile(join(source, "index.mjs"), code);
const packages = new PackageManagementService();
const candidate = await packages.prepareInstall(source);
await packages.commitCandidate(candidate, {
  digest: candidate.preview.digest,
  acknowledgeProcessAccess: true,
  enabled: true,
});
const configPath = join(storage, "config.json"),
  theme = process.env.CHISEL_CAPTURE_THEME ?? "obsidian";
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    profiles: {},
    ui: { theme },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);
const ui = await createTestRenderer({
  width: 145,
  height: 44,
  exitOnCtrlC: false,
});
const nativeFetch = globalThis.fetch;
let network = 0;
globalThis.fetch = Object.assign(
  async () => {
    ++network;
    return new Response("Offline fixture", { status: 503 });
  },
  { preconnect: nativeFetch.preconnect },
);
const frame = () =>
  act(async () => {
    await ui.renderOnce();
    await ui.renderOnce();
  });
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 12000;
  while (true) {
    let ready = false;
    await act(async () => {
      ready = await check();
    });
    if (ready) break;
    if (Date.now() > deadline)
      throw Error(`${message}\n${ui.captureCharFrame()}`);
    await act(async () => {
      await Bun.sleep(10);
      await ui.renderOnce();
    });
  }
  await frame();
}
async function key(name: string, ctrl = false, meta = false) {
  await act(async () => {
    ui.mockInput.pressKey(name, { ctrl, meta });
  });
  await frame();
}
async function click(id: string) {
  const target = ui.renderer.root.findDescendantById(id);
  assert.ok(target, `Нет ${id}`);
  await act(async () => {
    await ui.mockMouse.click(target.x + 1, target.y);
  });
  await frame();
}
async function choose(label: string) {
  await key("u", false, true);
  await until(
    () =>
      !!ui.renderer.root.findDescendantById("ui-composition-controls-popup"),
    "Нет списка элементов",
  );
  const popup = ui.renderer.root.findDescendantById(
    "ui-composition-controls-popup",
  )!;
  const find = (node: typeof popup): typeof popup | undefined => {
    if (
      "plainText" in node &&
      typeof node.plainText === "string" &&
      node.plainText.includes(label)
    )
      return node;
    for (const child of node.getChildren()) {
      const found = find(child);
      if (found) return found;
    }
  };
  const target = find(popup);
  assert.ok(target, `Нет элемента ${label}\n${ui.captureCharFrame()}`);
  await act(async () => {
    await ui.mockMouse.click(target.x + 2, target.y);
  });
  await until(
    () => !ui.renderer.root.findDescendantById("ui-composition-controls-popup"),
    "Список не закрылся",
  );
}
async function capture(name: string) {
  const folder = process.env.CHISEL_WIDGET_CAPTURES;
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
let app: ReturnType<typeof runOpenTuiAgent> | undefined;
try {
  const session = createSession(root, "openai", "fixture");
  session.messages = [
    {
      role: "user",
      content: [{ type: "text", text: "Сделай панель для заметок" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Панель готова. Текст и приоритет принадлежат этой беседе.",
        },
      ],
    },
  ];
  await (await projectSessionStore(root)).save(session);
  await act(async () => {
    app = runOpenTuiAgent(
      { cwd: root, configPath },
      session,
      false,
      false,
      undefined,
      async () => ui.renderer,
    );
  });
  await until(
    () =>
      ui.captureCharFrame().includes("Текст заметки") &&
      ui.captureCharFrame().includes("Задача · Studio"),
    "UI расширение не активировалось",
  );
  await until(
    () =>
      !!(
        ui.renderer.root.findDescendantById(
          "extension-example.studio/studio-image/pane:example.studio/studio",
        ) as { image?: { width: number } } | undefined
      )?.image?.width,
    "Изображение не декодировано native renderer",
  );
  await click("extension-example.studio/studio-map/pane:example.studio/studio");
  await key("ARROW_RIGHT");
  await until(
    () => ui.captureCharFrame().includes('"selected": 1'),
    "Canvas не обрабатывает мышь и клавиатуру",
  );
  await capture("form-wide");
  const baseline = network;
  await click("prompt-editor");
  await act(async () => {
    await ui.mockInput.typeText("Черновик чата");
  });
  await choose("Текст заметки");
  await until(
    () => !!ui.renderer.currentFocusedEditor?.id.includes("-note/"),
    "Поле не получило фокус после Alt+U",
  );
  await key("a", true);
  await key("k", true);
  await act(async () => {
    await ui.mockInput.typeText("План 界面");
  });
  await until(
    () => ui.captureCharFrame().includes("План 界面"),
    "Поле не принимает Unicode",
  );
  await capture("form-focused");
  await key("TAB");
  await key("ARROW_DOWN");
  await key("RETURN");
  await choose("Просмотр");
  await until(
    () =>
      ui.captureCharFrame().includes("Приоритет:") &&
      ui.captureCharFrame().includes("Высокий"),
    "Markdown и выбор не обновились",
  );
  await capture("preview");
  if (process.env.CHISEL_WIDGET_SMOKE !== "1") {
    await choose("Сохранить заметку");
    await until(
      () => !!ui.renderer.root.findDescendantById("approval-popup"),
      "Нет обычного подтверждения записи",
    );
    assert.ok(!(await Bun.file(join(root, "studio-note.md")).exists()));
    await capture("approval");
    await key("y");
    await until(
      async () => await Bun.file(join(root, "studio-note.md")).exists(),
      "Заметка не сохранена",
    );
    assert.equal(
      await readFile(join(root, "studio-note.md"), "utf8"),
      "План 界面\n",
    );
    await choose("Правка");
    await until(
      () => ui.captureCharFrame().includes("Текст заметки"),
      "Нет формы после смены вкладки",
    );
    await choose("Текст заметки");
    await key("END");
    await act(async () => {
      await ui.mockInput.typeText(" + draft");
    });
    await act(async () => ui.renderer.resize(52, 30));
    await until(
      () => ui.captureCharFrame().includes("Текст заметки"),
      "Панель не перенеслась на узком экране",
    );
    await capture("narrow");
    await act(async () => ui.renderer.resize(145, 44));
    await until(
      () => ui.captureCharFrame().includes("План 界面 + draft"),
      "Черновик формы потерян при переносе панели",
    );
    await choose("Просмотр");
    await until(
      () =>
        ui.captureCharFrame().includes("Приоритет:") &&
        ui.captureCharFrame().includes("План 界面 + draft"),
      "Изменение формы не дошло до источника",
    );
    await choose("Проверить сбой");
    await until(
      () => ui.captureCharFrame().includes("сохранён стандартный вид"),
      "Сбой callback не показан",
    );
    assert.ok(!ui.captureCharFrame().includes("must-not-leak"));
    await capture("callback-error");
    await until(
      () => ui.renderer.currentFocusedEditor?.id === "prompt-editor",
      "Фокус не вернулся из исчезнувшей формы",
    );
  } else {
    await key("ESCAPE");
    await until(
      () => ui.renderer.currentFocusedEditor?.id === "prompt-editor",
      "Фокус не вернулся из панели",
    );
  }
  assert.ok(ui.captureCharFrame().includes("Черновик чата"));
  assert.equal(network, baseline, "Интерактивный UI запустил сеть/модель");
  if (process.env.CHISEL_WIDGET_SMOKE !== "1") {
    await key("a", true);
    await key("k", true);
    await act(async () => {
      await ui.mockInput.pasteBracketedText("/exit");
      ui.mockInput.pressEnter();
    });
    await act(async () => {
      await app;
    });
  }
  console.log(
    process.env.CHISEL_WIDGET_SMOKE === "1"
      ? "Extension widgets OpenTUI: compiled external package, native forms/media/canvas, focus, Markdown and cleanup verified"
      : "Extension widgets OpenTUI: reviewed external package, forms, focus, tabs, Markdown/code/canvas, native props, approval, real file, narrow reflow, fault and cleanup verified",
  );
} finally {
  if (app)
    await act(async () => {
      process.emit("SIGTERM");
      await app?.catch(() => {});
    });
  globalThis.fetch = nativeFetch;
  await act(async () => ui.renderer.destroy());
  await rm(storage, { recursive: true, force: true });
}
