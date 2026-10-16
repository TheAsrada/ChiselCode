import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScrollBoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { z } from "zod";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const storage = await mkdtemp(join(tmpdir(), "chisel-settings-tools-"));
const theme = process.env.CHISEL_CAPTURE_THEME ?? "obsidian";
for (const name of [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "LOCALAPPDATA",
  "APPDATA",
])
  process.env[name] = join(storage, "home");
const root = join(storage, "workspace");
await mkdir(root);
// Keep the fixture-only server SDK out of the application's static client graph.
const { createMcpHandler, McpServer } = await import(
  "@modelcontextprotocol/server"
);
let toolCalls = 0;
const handler = createMcpHandler(() => {
  const server = new McpServer({
    name: "Документация проекта",
    version: "1.0.0",
  });
  server.registerTool(
    "get_note",
    {
      title: "Прочитать заметку",
      description: "Чтение документации проекта",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ name: z.string() }),
    },
    async () => {
      toolCalls++;
      return { content: [{ type: "text", text: "Заметка" }] };
    },
  );
  return server;
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/unavailable"
      ? new Response("Maintenance", { status: 418 })
      : handler.fetch(request),
});
const configPath = join(storage, "config.json");
await writeFile(
  configPath,
  JSON.stringify({
    schemaVersion: 2,
    profiles: {},
    ui: { theme },
    web: { enabled: false },
    lsp: { mode: "off", servers: {} },
    mcp: {
      schemaVersion: 1,
      servers: {
        notes: {
          label: "Документация",
          transport: { type: "http", url: `${server.url}mcp` },
        },
        unavailable: {
          label: "Недоступный сервис",
          transport: { type: "http", url: `${server.url}unavailable` },
        },
        archive: {
          label: "Архив проекта",
          enabled: false,
          transport: { type: "http", url: `${server.url}mcp` },
        },
      },
    },
  }),
);
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.origin === server.url.origin
      ? nativeFetch(...args)
      : new Response("Offline fixture", { status: 503 });
  },
  { preconnect: nativeFetch.preconnect },
);
const ui = await createTestRenderer({
  width: 120,
  height: 36,
  exitOnCtrlC: false,
});
const frame = () =>
  act(async () => {
    await ui.renderOnce();
    await ui.renderOnce();
  });
async function until(
  predicate: () => boolean | Promise<boolean>,
  reason: string,
) {
  const deadline = Date.now() + 12000;
  while (!(await predicate())) {
    if (Date.now() > deadline)
      throw Error(`${reason}\n${ui.captureCharFrame()}`);
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
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame();
}
async function paste(value: string) {
  await act(async () => {
    await ui.mockInput.pasteBracketedText(value);
  });
  await frame();
}
async function click(id: string) {
  const target = ui.renderer.root.findDescendantById(id);
  assert.ok(target, `Нет ${id}`);
  await act(async () => {
    for (let parent = target.parent; parent; parent = parent.parent)
      if (parent instanceof ScrollBoxRenderable) parent.scrollChildIntoView(id);
  });
  await frame();
  await act(async () => {
    await ui.mockMouse.click(
      target.x + Math.min(1, target.width - 1),
      target.y,
    );
  });
  await frame();
}
async function navigate(query: string) {
  await key("f", true);
  await key("a", true);
  await paste(query);
  await key("RETURN");
}
async function capture(name: string) {
  const folder = process.env.CHISEL_SETTINGS_TOOL_CAPTURES;
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
  });
  await until(() => !!ui.renderer.currentFocusedEditor, "Нет ввода");
  await paste("Мой черновик задачи");
  await key("\u001b[44;5u");
  await until(
    () => !!ui.renderer.root.findDescendantById("settings-popup"),
    "Нет Settings",
  );
  if (process.env.CHISEL_SETTINGS_TOOLS_SMOKE === "1") {
    await navigate("mcp");
    await until(
      () => !!ui.renderer.root.findDescendantById("mcp-row-notes"),
      "Нет MCP в compiled Settings",
    );
    await click("mcp-row-notes");
    await click("mcp-row-connect");
    await until(
      () => ui.captureCharFrame().includes("Переподключить"),
      "Compiled MCP не подключился",
    );
    await navigate("навыки");
    await until(
      () => !!ui.renderer.root.findDescendantById("skills-panel"),
      "Нет навыков в compiled Settings",
    );
    assert.ok(ui.captureCharFrame().includes("/skill-creator"));
    assert.equal(
      ui.renderer.root.findDescendantById("skills-popup"),
      undefined,
    );
    await click("settings-close");
    assert.equal(
      ui.renderer.currentFocusedEditor?.plainText,
      "Мой черновик задачи",
    );
    assert.equal(toolCalls, 0);
    console.log(
      "Settings tools packaged smoke: real MCP, bundled skills and return draft verified",
    );
  } else {
    const shell = ui.renderer.root.findDescendantById("settings-popup");
    for (const route of [
      "фоновые задачи",
      "субагенты",
      "анализ кода",
      "web",
      "расширения",
      "тема",
      "разрешения",
    ]) {
      await navigate(route);
      assert.equal(
        ui.renderer.root.findDescendantById("settings-popup"),
        shell,
      );
      assert.equal(ui.renderer.root.findDescendantById("mcp-popup"), undefined);
      assert.equal(
        ui.renderer.root.findDescendantById("skills-popup"),
        undefined,
      );
    }
    await navigate("mcp");
    await until(
      () => !!ui.renderer.root.findDescendantById("mcp-row-notes"),
      "Нет списка MCP",
    );
    assert.ok(ui.renderer.root.findDescendantById("mcp-panel"));
    assert.equal(
      ui.renderer.root.findDescendantById("mcp-backdrop"),
      undefined,
    );
    await capture("mcp-list");
    await click("mcp-row-notes");
    await click("mcp-row-connect");
    await until(
      () => ui.captureCharFrame().includes("Переподключить"),
      "MCP не подключился",
    );
    await capture("mcp-connected");
    await click("mcp-row-tools");
    await click("mcp-row-get_note");
    await click("mcp-tool-permission");
    await until(
      async () =>
        JSON.parse(await readFile(configPath, "utf8")).mcp.servers.notes
          .permissions?.tools?.get_note === "ask",
      "Правило не сохранено",
    );
    await key("ESCAPE");
    await key("ESCAPE");
    await key("ESCAPE");
    await click("mcp-row-unavailable");
    await click("mcp-row-connect");
    await until(
      () => ui.captureCharFrame().includes("Ошибка ·"),
      "Не показана ошибка MCP",
    );
    await capture("mcp-error");
    await key("ESCAPE");
    await click("mcp-row-add");
    await click("mcp-row-url");
    await click("mcp-row-id");
    await paste("draft_server");
    await key("RETURN");
    await click("mcp-row-token");
    await paste("local-test-credential");
    assert.ok(!ui.captureCharFrame().includes("local-test-credential"));
    await navigate("навыки");
    await until(
      () => !!ui.renderer.root.findDescendantById("skills-panel"),
      "Нет панели навыков",
    );
    assert.equal(
      ui.renderer.root.findDescendantById("skills-backdrop"),
      undefined,
    );
    await capture("skills-library");
    await click("skills-pins-tab");
    await click("skills-search");
    await paste("code-review");
    await key("RETURN");
    assert.ok(ui.captureCharFrame().includes("Закрепление 1"));
    await capture("skills-pins");
    await key("o", true);
    assert.ok(ui.renderer.root.findDescendantById("skills-instructions"));
    await capture("skills-instructions");
    await key("ESCAPE");
    await navigate("mcp");
    assert.equal(
      ui.renderer.currentFocusedEditor?.plainText,
      "*".repeat("local-test-credential".length),
    );
    await key("RETURN");
    assert.ok(
      ui.captureCharFrame().includes("draft_server"),
      "Переход потерял черновик MCP",
    );
    await capture("mcp-draft-restored");
    await navigate("навыки");
    for (const [width, height] of [
      [80, 24],
      [40, 16],
      [24, 8],
    ]) {
      await act(async () => ui.resize(width!, height!));
      await frame();
      assert.ok(ui.renderer.root.findDescendantById("settings-popup"));
      assert.equal(
        ui.renderer.root.findDescendantById("skills-popup"),
        undefined,
      );
      await capture(`skills-${width}x${height}`);
    }
    await act(async () => ui.resize(120, 36));
    await frame();
    await click("settings-close");
    assert.ok(
      ui.renderer.root.findDescendantById("settings-stay"),
      "Потеряна защита черновика MCP",
    );
    await click("settings-stay");
    await click("settings-close");
    await click("settings-discard");
    await until(
      () => !ui.renderer.root.findDescendantById("settings-popup"),
      "Settings не закрылся",
    );
    assert.equal(
      ui.renderer.currentFocusedEditor?.plainText,
      "Мой черновик задачи",
    );
    await key("t", true);
    await navigate("навыки");
    await click("skills-search");
    await paste("code-review");
    await key("RETURN");
    await until(
      () => !ui.renderer.root.findDescendantById("settings-popup"),
      "Выбор навыка не вернул редактор",
    );
    assert.equal(
      ui.renderer.currentFocusedEditor?.plainText,
      "/code-review Мой черновик задачи",
    );
    await key("a", true);
    await key("k", true);
    await paste("/mcp");
    await key("RETURN");
    await until(
      () => !!ui.renderer.root.findDescendantById("mcp-popup"),
      "Команда MCP потеряла отдельный диалог",
    );
    await key("ESCAPE");
    await key("a", true);
    await key("k", true);
    await paste("/skills");
    await key("RETURN");
    await until(
      () => !!ui.renderer.root.findDescendantById("skills-popup"),
      "Команда навыков потеряла диалог",
    );
    assert.equal(
      toolCalls,
      0,
      "Просмотр настроек не должен вызывать внешние инструменты",
    );
    console.log(
      `Settings tools: ${theme}, embedded MCP/skills, real HTTP/rules, retained drafts, focus, all sections, sizes, command dialogs verified`,
    );
  }
} finally {
  if (application)
    await act(async () => {
      process.emit("SIGTERM");
      await application?.catch(() => {});
    });
  globalThis.fetch = nativeFetch;
  server.stop(true);
  await handler.close();
  await rm(storage, { recursive: true, force: true });
}
