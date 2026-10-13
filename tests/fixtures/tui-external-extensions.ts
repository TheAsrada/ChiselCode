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
import { createTestRenderer } from "@opentui/core/testing";
import { execa } from "execa";
import { act } from "react";
import {
  extensionsDirectory,
  inspectPackage,
} from "../../src/extensions/external/package.js";
import { approvePackage } from "../../src/extensions/external/registry.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-external-tui-")),
  root = join(storage, "Проект внешнего SDK"),
  author = join(storage, "Самостоятельный автор");
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
      theme: process.env.CHISEL_CAPTURE_THEME ?? "obsidian",
      unicodeDecorations: process.env.CHISEL_CAPTURE_UNICODE === "1",
    },
    lsp: { mode: "off", servers: {} },
    web: { enabled: false },
  }),
);
const example = resolve("examples/extensions/project-notes");
await copyFile(join(example, "index.ts"), join(author, "index.ts"));
const bun = Bun.which("bun");
assert.ok(bun, "Authoring fixture requires the installed Bun compiler");
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
const packageDir = join(await extensionsDirectory(), "Заметки проекта");
await mkdir(packageDir);
// Files arrive after the application/harness was built; no source definition injection.
await copyFile(join(author, "index.mjs"), join(packageDir, "index.mjs"));
await copyFile(
  join(example, "chisel-extension.json"),
  join(packageDir, "chisel-extension.json"),
);
const candidate = await inspectPackage(packageDir);
await approvePackage(packageDir, candidate.manifest.id, candidate.digest, true);
const broken = join(await extensionsDirectory(), "Сломанный пакет");
await mkdir(broken);
await writeFile(
  join(broken, "chisel-extension.json"),
  JSON.stringify({
    schemaVersion: 1,
    id: "fixture.broken",
    version: "1.0.0",
    apiVersion: 1,
    entry: "index.mjs",
    displayName: "Недоступная возможность",
  }),
);
await writeFile(
  join(broken, "index.mjs"),
  "export default ({manifest})=>({id:manifest.id,version:manifest.version,apiVersion:1,entry:manifest.entry,activate(){throw Error('token=never-display-raw-cause')}});",
);
const failedCandidate = await inspectPackage(broken);
await approvePackage(
  broken,
  failedCandidate.manifest.id,
  failedCandidate.digest,
  true,
);
await writeFile(join(root, "note.txt"), "Внешняя заметка\n");
const ui = await createTestRenderer({
  width: 160,
  height: 50,
  exitOnCtrlC: false,
});
const originalFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = Object.assign(
  async () => {
    fetches++;
    return new Response("Offline fixture", { status: 503 });
  },
  { preconnect: originalFetch.preconnect },
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
  const folder = process.env.CHISEL_EXTERNAL_CAPTURES;
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
let application: Promise<void> | undefined;
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
    await Bun.sleep(20);
  });
  await until(
    () => !!ui.renderer.root.findDescendantById("ui-status-more"),
    "Внешний status не подключён ordinary loader",
  );
  await until(
    () => ui.captureCharFrame().includes("Недоступная возможность"),
    "Нет безопасного startup notice",
  );
  assert.ok(!ui.captureCharFrame().includes("never-display-raw-cause"));
  await capture("external-error-status-160x50");
  await click("prompt-editor");
  await act(async () =>
    ui.mockInput.pasteBracketedText("Сохранённый черновик"),
  );
  await frame();
  const beforeFetch = fetches;
  await key("b", true);
  await until(
    () => !!ui.renderer.root.findDescendantById("sidebar-panel"),
    "Нет панели",
  );
  await click("sidebar-tab-context");
  assert.match(ui.captureCharFrame(), /Заметки проекта/);
  await capture("external-context-160x50");
  await click("sidebar-tab-menu");
  await key("END");
  await key("RETURN");
  assert.ok(!ui.renderer.root.findDescendantById("extension-details-popup"));
  await capture("external-menu-160x50");
  await key(" ");
  await until(
    () => !!ui.renderer.root.findDescendantById("extension-details-popup"),
    "Space не открыл внешний details",
  );
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
    assert.ok(back && back.y < height!);
    const row = ui.renderer.root.findDescendantById("extension-row-note-0");
    assert.ok(
      row && row.y < height! - 2,
      "На малом экране должна оставаться строка списка",
    );
    await capture(`external-details-${width}x${height}`);
  }
  await act(async () => ui.renderer.resize(120, 40));
  await frame();
  await click("extension-refresh");
  assert.ok(ui.renderer.root.findDescendantById("extension-row-note-50"));
  await key("c", true);
  assert.ok(ui.renderer.root.findDescendantById("extension-details-popup"));
  await key("TAB");
  await key("TAB");
  await key("TAB");
  await key("RETURN");
  await until(
    () => !!ui.renderer.root.findDescendantById("approval-popup"),
    "Нет ordinary approval внешнего UI tool",
  );
  await capture("external-approval-120x40");
  await key("y");
  await until(
    async () =>
      (await readFile(join(root, "ui-note.txt"), "utf8").catch(() => "")) ===
      "Заметка через внешний UI SDK\n",
    "Нет настоящей записи SDK",
  );
  await key("ESCAPE");
  await until(
    () => !ui.renderer.root.findDescendantById("extension-details-popup"),
    "Закрытие details",
  );
  assert.match(ui.captureCharFrame(), /Сохранённый черновик/);
  assert.equal(
    fetches,
    beforeFetch,
    "Просмотр и own-tool action не создают model request",
  );
  const store = await projectSessionStore(root);
  await until(async () => (await store.list()).length > 0, "Нет checkpoint");
  const session = await store.load((await store.list())[0]!.id);
  assert.equal(
    session.undoStack.at(-1)?.after,
    "Заметка через внешний UI SDK\n",
  );
  await capture("external-return-draft-120x40");
  await click("prompt-editor");
  await key("a", true);
  await key("k", true);
  await act(async () => {
    await ui.mockInput.pasteBracketedText("/exit");
    ui.mockInput.pressEnter();
  });
  await frame();
  await application;
  console.log(
    "External TUI: ordinary loader, external slots/details/pages, menu Enter/Space, approval, real file/checkpoint and draft/focus verified",
  );
} finally {
  if (application) {
    process.emit("SIGTERM");
    await application.catch(() => {});
  }
  globalThis.fetch = originalFetch;
  ui.renderer.destroy();
  await rm(storage, { recursive: true, force: true });
}
