import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { defaultExtensions } from "../../src/extensions/composition.js";
import type { ChiselExtension } from "../../src/extensions/contracts.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { runOpenTuiAgent } from "../../src/ui/opentui-agent.js";
import {
  installedLsp,
  lspProcessTree,
  waitForLspProcessExit,
} from "./lsp-runtime.js";

export const LSP_TUI_MARKER =
  "LSP Settings: Auto, custom setup, explicit trust, approval, real analysis, edit, restart, revocation and cleanup passed";
export async function runLspTuiScenario(
  captures = process.env.CHISEL_TEST_LSP_CAPTURES,
): Promise<void> {
  const storage = await mkdtemp(join(tmpdir(), "chisel-lsp-tui-"));
  const root = join(storage, "workspace");
  await mkdir(root);
  const configPath = join(storage, "selected-config.json");
  const variables = [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CHISEL_ALT_SCREEN",
    "CHISEL_NO_ALT_SCREEN",
  ];
  const previous = new Map(variables.map((key) => [key, process.env[key]]));
  for (const key of variables) {
    if (key.endsWith("HOME") || key.endsWith("APPDATA"))
      process.env[key] = storage;
    else delete process.env[key];
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const nativeFetch = globalThis.fetch;
  let modelRequests = 0;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (/chat\/completions|\/messages(?:\?|$)/.test(url)) ++modelRequests;
      return new Response("Offline fixture", { status: 503 });
    },
    { preconnect: nativeFetch.preconnect },
  );
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 2,
      profiles: {},
      web: { enabled: false },
      ui: { theme: "graphite", sidebarMode: "hide" },
    }),
  );
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
  );
  await writeFile(
    join(root, "main.ts"),
    'export const value: number = "wrong";\n',
  );
  const fixture: ChiselExtension = {
    id: "fixture.lsp-ui",
    activate(ctx) {
      ctx.commands.register({
        name: "inspect-types",
        description: "Fixture: analyse real saved TypeScript",
        parse: () => ({}),
        execute: (context) =>
          context.tools.execute("ext:builtin.lsp:diagnostics", {
            path: "main.ts",
          }),
      });
      ctx.commands.register({
        name: "inspect-status",
        description: "Fixture status through real tool",
        parse: () => ({}),
        execute: (context) =>
          context.tools.execute("ext:builtin.lsp:status", {}),
      });
      ctx.commands.register({
        name: "fix-type",
        description: "Fixture: edit using real observations",
        parse: () => ({}),
        execute: (context) =>
          context.tools.execute("edit_file", {
            path: "main.ts",
            old_str: "value: number",
            new_str: "value: string",
          }),
      });
    },
  };
  const setup = await createTestRenderer({
    width: 120,
    height: 40,
    exitOnCtrlC: false,
  });
  let application: ReturnType<typeof runOpenTuiAgent> | undefined;
  const frames = async (count = 3) => {
    for (let i = 0; i < count; i++)
      await act(async () => {
        await Bun.sleep(15);
        await setup.renderOnce();
      });
  };
  const key = async (name: string, ctrl = false) => {
    await act(async () => {
      setup.mockInput.pressKey(
        name === "ENTER"
          ? "RETURN"
          : name === "DOWN"
            ? "ARROW_DOWN"
            : name === "UP"
              ? "ARROW_UP"
              : name,
        { ctrl },
      );
    });
    if (name === "ESCAPE")
      await act(async () => {
        await Bun.sleep(120);
      });
    await frames();
  };
  const paste = async (value: string) => {
    await act(async () => {
      await setup.mockInput.pasteBracketedText(value);
    });
    await frames();
  };
  const click = async (id: string) => {
    const node = setup.renderer.root.findDescendantById(id);
    assert.ok(
      node?.visible && node.height > 0,
      `Missing visible ${id}\n${setup.captureCharFrame()}`,
    );
    await act(async () => {
      await setup.mockMouse.click(node.x + 1, node.y);
    });
    await frames();
  };
  const wait = async (
    predicate: () => boolean | Promise<boolean>,
    message: string,
    milliseconds = 12_000,
  ) => {
    const end = Date.now() + milliseconds;
    let matched = await predicate();
    while (!matched && Date.now() < end) {
      await frames();
      matched = await predicate();
    }
    assert.ok(matched, `${message}\n${setup.captureCharFrame()}`);
  };
  const capture = async (name: string) => {
    if (!captures) return;
    await mkdir(captures, { recursive: true });
    const spans = setup.captureSpans();
    await writeFile(join(captures, `${name}.txt`), setup.captureCharFrame());
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
  };
  const command = async (value: string) => {
    await wait(
      () => !setup.captureCharFrame().includes("Enter в очередь"),
      "Prior operation did not finish",
    );
    await paste(value);
    await key("ENTER");
  };
  const choose = async (id: string) => {
    const visible = () => {
      const node = setup.renderer.root.findDescendantById(id);
      return !!node?.visible && node.height > 0;
    };
    if (!visible() && id.startsWith("lsp-row-")) {
      await key("HOME");
      const deadline = Date.now() + 5000;
      for (
        let index = 0;
        !visible() && index < 90 && Date.now() < deadline;
        index++
      )
        await key("DOWN");
    }
    await wait(visible, `Missing ${id}`, 1000);
    await click(id);
  };
  const field = async (id: string, value: string) => {
    await choose(`lsp-row-${id}`);
    await key("a", true);
    await key("k", true);
    await paste(value);
    await key("ENTER");
  };
  try {
    await act(async () => {
      application = runOpenTuiAgent(
        { cwd: root, configPath },
        undefined,
        false,
        false,
        defaultExtensions([fixture], { configPath }),
        async () => setup.renderer,
      );
      await Bun.sleep(30);
    });
    await wait(
      () =>
        !!setup.renderer.root.findDescendantById("welcome") &&
        !!setup.renderer.root.findDescendantById("prompt-editor"),
      "Application input did not become ready",
    );
    await click("prompt-editor");
    await paste("Неотправленный черновик");
    // All three entrances share the actual Settings panel and its captured actions.
    await key("F9");
    await wait(
      () =>
        !!setup.renderer.root.findDescendantById(
          "ui-overflow-builtin.lsp/status",
        ),
      "LSP status did not appear",
    );
    await click("ui-overflow-builtin.lsp/status");
    await wait(
      () => !!setup.renderer.root.findDescendantById("lsp-row-enabled"),
      "Unified menu did not open",
    );
    assert.ok(setup.captureCharFrame().includes("Этот проект"));
    assert.equal(
      (await lspProcessTree()).length,
      0,
      "Passive menu started a server",
    );
    await capture("overview-120x40");
    for (const [width, height] of [
      [80, 24],
      [40, 12],
      [24, 8],
    ] as const) {
      await act(async () => setup.resize(width, height));
      await frames();
      await capture(`overview-${width}x${height}`);
      assert.ok(
        setup.captureCharFrame().includes("LSP"),
        "Tiny menu lost its identity",
      );
    }
    await act(async () => setup.resize(120, 40));
    await frames();
    await key("ESCAPE");
    await wait(
      () => !setup.renderer.root.findDescendantById("settings-popup"),
      "Menu did not close",
    );
    assert.equal(
      setup.renderer.currentFocusedEditor?.plainText,
      "Неотправленный черновик",
    );
    await key("b", true);
    await wait(
      () => !!setup.renderer.root.findDescendantById("sidebar-tab-menu"),
      "Sidebar unavailable",
    );
    await click("sidebar-tab-menu");
    await wait(
      () =>
        !!setup.renderer.root.findDescendantById(
          "sidebar-menu-builtin.lsp/menu_entry",
        ),
      "Sidebar LSP entry unavailable",
    );
    await click("sidebar-menu-builtin.lsp/menu_entry");
    await wait(
      () => !!setup.renderer.root.findDescendantById("lsp-row-enabled"),
      "Sidebar did not open unified menu",
    );
    await key("ESCAPE");
    await click("prompt-editor");
    assert.equal(
      setup.renderer.currentFocusedEditor?.plainText,
      "Неотправленный черновик",
    );
    await key("a", true);
    await key("k", true);
    await command("/settings");
    await wait(
      () => !!setup.renderer.root.findDescendantById("settings-global-search"),
      "Settings unavailable",
    );
    await key("f", true);
    await paste("анализ кода");
    await key("ENTER");
    await wait(
      () => !!setup.renderer.root.findDescendantById("lsp-row-enabled"),
      "Settings did not reuse LSP menu",
    );
    await choose("lsp-row-catalog");
    await choose("lsp-row-server-auto");
    await capture("card-idle-120x40");
    await choose("lsp-row-start");
    await wait(
      () => !!setup.renderer.root.findDescendantById("approval-popup"),
      "UI invocation bypassed approval on home",
    );
    await key("y");
    await wait(
      () =>
        setup.captureCharFrame().includes("Сервер работает после initialize"),
      "Real Auto initialize failed",
    );
    const autoProcesses = await lspProcessTree();
    assert.ok(autoProcesses.length >= 2, "Real Auto process tree missing");
    await capture("card-running-120x40");
    await choose("lsp-row-start");
    await wait(
      () => !!setup.renderer.root.findDescendantById("approval-popup"),
      "Second UI restart bypassed approval",
    );
    await key("y");
    await wait(
      () =>
        setup.captureCharFrame().includes("Сервер работает после initialize") &&
        !setup.renderer.root.findDescendantById("approval-popup"),
      "Second home restart failed",
    );
    // Home UI operations retain checkpoints without allocating visible tabs or making model messages.
    const homeStore = await projectSessionStore(root);
    let advanced = false;
    const checkpointDeadline = Date.now() + 3000;
    while (!advanced && Date.now() < checkpointDeadline) {
      for (const summary of await homeStore.list()) {
        const saved = await homeStore.load(summary.id);
        advanced ||= Object.values(saved.runtime?.invocations ?? {}).some(
          (record) =>
            record.name === "ext:builtin.lsp:restart" &&
            record.result?.output.includes('"generation": 2'),
        );
        assert.equal(saved.messages.length, 0);
      }
      if (!advanced) await frames(1);
    }
    assert.ok(advanced, "UI restart checkpoint/generation missing");
    await key("ESCAPE"); // card -> overview
    await click("lsp-global");
    await choose("lsp-row-enabled");
    await wait(
      () => setup.captureCharFrame().includes("Анализ кода: Выключен"),
      "Global Off did not apply",
    );
    const stopped = await lspProcessTree();
    assert.equal(stopped.length, 0, "Off did not close all server descendants");
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).lsp.enabled,
      false,
    );
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).lsp.mode,
      undefined,
    );
    await capture("off-120x40");
    await click("lsp-project");
    await choose("lsp-row-enabled");
    await wait(
      () =>
        setup.captureCharFrame().includes("Анализ выключен для всех проектов"),
      "Project switch did not explain global ceiling",
    );
    await choose("lsp-row-enabled");
    await wait(
      () => setup.captureCharFrame().includes("Анализ кода: Включён"),
      "Global On failed",
    );
    assert.equal((await lspProcessTree()).length, 0, "On must remain lazy");
    if (process.env.CHISEL_LSP_MENU_SMOKE === "1") {
      assert.equal(modelRequests, 0);
      await key("ESCAPE");
      await wait(
        () => !setup.renderer.root.findDescendantById("settings-popup"),
        "Smoke menu did not close",
      );
      await command("/exit");
      await application;
      process.stdout.write(
        "LSP menu smoke: три входа, ui_tool/approval, checkpoints, lazy toggle и cleanup проверены\n",
      );
      return;
    }
    const paths = await installedLsp();
    await choose("lsp-row-add");
    await field("node", paths.command);
    await field("server", paths.args[0] ?? "");
    await choose("lsp-row-typescript");
    await key("a", true);
    await key("k", true);
    await paste(paths.typescriptPath);
    const editor = setup.renderer.currentFocusedEditor;
    assert.ok(editor);
    const cursor = editor.cursorOffset;
    for (const [width, height] of [
      [120, 40],
      [80, 24],
      [40, 12],
      [24, 8],
    ] as const) {
      await act(async () => setup.resize(width, height));
      await frames();
      assert.equal(
        setup.renderer.currentFocusedEditor,
        editor,
        "Resize replaced native input",
      );
      assert.equal(editor.cursorOffset, cursor);
      await capture(`form-input-${width}x${height}`);
    }
    await act(async () => setup.resize(120, 40));
    await frames();
    await key("ENTER");
    await capture("form-draft-120x40");
    await key("f", true);
    await paste("python");
    await key("ENTER");
    await choose("lsp-row-server-auto-python");
    await choose("lsp-row-server-enabled");
    await wait(
      () => setup.captureCharFrame().includes("Сохранено"),
      "Individual quick patch failed",
    );
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).lsp.serverOverrides[
        "auto-python"
      ].enabled,
      false,
    );
    assert.deepEqual(
      JSON.parse(await readFile(configPath, "utf8")).lsp.servers.typescript
        .command,
      paths.command,
      "Autosave lost the manual server",
    );
    await key("ESCAPE");
    await choose("lsp-row-draft");
    assert.ok(setup.captureCharFrame().includes("typescript"));
    await choose("lsp-row-check");
    await wait(
      () => setup.captureCharFrame().includes("Пути доступны"),
      "Real path validation failed",
    );
    await wait(
      async () =>
        JSON.parse(await readFile(configPath, "utf8")).lsp.servers.typescript
          ?.command === paths.command,
      "Manual autosave failed",
    );
    let savedConfig = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(savedConfig.lsp.servers.typescript.command, paths.command);
    assert.deepEqual(savedConfig.lsp.servers.typescript.trustedWorkspaces, []);
    assert.equal(savedConfig.lsp.serverOverrides["auto-python"].enabled, false);
    await key("ESCAPE");
    await choose("lsp-row-clear-search");
    await choose("lsp-row-strategy");
    await choose("lsp-row-mode-custom");
    await wait(
      () => setup.captureCharFrame().includes("Сохранено"),
      "Custom strategy failed",
    );
    await key("ESCAPE");
    await choose("lsp-row-server-typescript");
    await choose("lsp-row-settings");
    await choose("lsp-row-trust");
    await wait(
      () => setup.captureCharFrame().includes("Разрешён только"),
      "Explicit trust failed",
    );
    await choose("lsp-row-start");
    await wait(
      () => !!setup.renderer.root.findDescendantById("approval-popup"),
      "Custom restart bypassed permissions",
    );
    await key("y");
    await wait(
      () =>
        setup.captureCharFrame().includes("Сервер работает после initialize"),
      "Custom initialize failed",
    );
    await capture("custom-running-120x40");
    await key("ESCAPE");
    await key("ESCAPE");
    await key("ESCAPE");
    await wait(
      () => !setup.renderer.root.findDescendantById("settings-popup"),
      "Settings did not close",
    );
    await click("prompt-editor");
    for (let attempt = 0; attempt < 4; attempt++) {
      await command("/inspect-types");
      await wait(
        () =>
          setup.captureCharFrame().includes("2322") ||
          setup.captureCharFrame().includes("Завершено"),
        "Real diagnostics unfinished",
      );
      if (setup.captureCharFrame().includes("2322")) break;
    }
    await wait(
      () => setup.captureCharFrame().includes("2322"),
      "Real diagnostics missing",
    );
    await command("/fix-type");
    await wait(
      () => !!setup.renderer.root.findDescendantById("approval-popup"),
      "Editing approval missing",
    );
    await key("y");
    await wait(
      () => !setup.renderer.root.findDescendantById("approval-popup"),
      "Editing unfinished",
    );
    await wait(
      async () =>
        (await readFile(join(root, "main.ts"), "utf8")).includes(
          "value: string",
        ),
      "Real edit did not persist",
    );
    await command("/inspect-status");
    await wait(
      () => setup.captureCharFrame().includes('"state": "ready"'),
      "Status tool failed",
    );
    await key("F9");
    await click("ui-overflow-builtin.lsp/status");
    await wait(
      () => !!setup.renderer.root.findDescendantById("lsp-row-enabled"),
      "Menu did not reopen",
    );
    await choose("lsp-row-server-typescript");
    await capture("diagnostics-120x40");
    await choose("lsp-row-settings");
    const descendants = await lspProcessTree();
    await choose("lsp-row-trusted-root-0");
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).lsp.servers.typescript
        .trustedWorkspaces.length,
      0,
      "Explicit trust revocation was not persisted",
    );
    await wait(
      async () =>
        JSON.parse(await readFile(configPath, "utf8")).lsp.servers.typescript
          .trustedWorkspaces.length === 0,
      "Trust revocation autosave failed",
    );
    await waitForLspProcessExit(descendants);
    await key("ESCAPE");
    await capture("untrusted-120x40");
    await key("ESCAPE");
    await click("lsp-global");
    await choose("lsp-row-add-generic");
    await field("id", "broken");
    await field("node", paths.command);
    await field("languages", "notes");
    await field("extensions", ".notes");
    await choose("lsp-row-args");
    await paste("-e\nprocess.exit(3)");
    await click("lsp-field-done");
    await wait(
      async () =>
        JSON.parse(await readFile(configPath, "utf8")).lsp.servers.broken
          ?.command === paths.command,
      "Generic autosave failed",
    );
    await choose("lsp-row-trust");
    await wait(
      () => setup.captureCharFrame().includes("Разрешён только"),
      "Generic trust failed",
    );
    await choose("lsp-row-start");
    await wait(
      () => !!setup.renderer.root.findDescendantById("approval-popup"),
      "Generic process approval missing",
    );
    await key("y");
    await wait(
      () =>
        !setup.renderer.root.findDescendantById("approval-popup") &&
        !setup.renderer.root.findDescendantById("lsp-applying"),
      "Expected server failure did not settle",
    );
    await key("ESCAPE");
    await choose("lsp-row-server-broken");
    await wait(
      () => setup.captureCharFrame().includes("Ошибка"),
      "Real failed backend did not show error",
    );
    await capture("server-error-120x40");
    if (captures) {
      await click("settings-route-appearance");
      await click("settings-theme-paper");
      await key("s", true);
      await frames();
      await click("settings-route-tools.lsp");
      await capture("server-error-paper-120x40");
      await key("ESCAPE");
      for (const [width, height] of [
        [120, 40],
        [80, 24],
        [40, 12],
        [24, 8],
      ] as const) {
        await act(async () => setup.resize(width, height));
        await frames();
        await capture(`overview-paper-${width}x${height}`);
      }
      await act(async () => setup.resize(120, 40));
      await frames();
    } else await key("ESCAPE");
    // Conflict keeps the real native form and unrelated external settings.
    await choose("lsp-row-server-broken");
    await choose("lsp-row-settings");
    await choose("lsp-row-args");
    await paste("\n--external-conflict");
    savedConfig = JSON.parse(await readFile(configPath, "utf8"));
    savedConfig.lsp.serverOverrides["auto-lua"] = { enabled: false };
    await writeFile(configPath, JSON.stringify(savedConfig));
    await click("lsp-field-done");
    await wait(
      () => setup.captureCharFrame().includes("изменились"),
      "Concurrent config edit was overwritten",
    );
    await capture("form-conflict-120x40");
    await click("settings-route-appearance");
    assert.ok(
      setup.renderer.root.findDescendantById("lsp-row-args"),
      "Write failure lost the input form",
    );
    assert.equal(
      setup.renderer.root.findDescendantById("settings-discard"),
      undefined,
    );
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).lsp.servers.broken.command,
      paths.command,
    );
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).lsp.serverOverrides[
        "auto-lua"
      ].enabled,
      false,
    );
    assert.equal(modelRequests, 0, "LSP menu requested model chat");
    const store = await projectSessionStore(root);
    let invocationFound = false;
    for (const summary of await store.list()) {
      const session = await store.load(summary.id);
      assert.equal(
        session.messages.length,
        0,
        "Local tool invocation created model history",
      );
      invocationFound ||= Object.values(
        session.runtime?.invocations ?? {},
      ).some(
        (record) =>
          record.toolSource?.type === "extension" &&
          record.toolSource.extensionId === "builtin.lsp",
      );
    }
    assert.ok(invocationFound, "LSP checkpoint persistence missing");
    await choose("lsp-row-discard");
    await key("ESCAPE");
    await command("/exit");
    await application;
    process.stdout.write(`${LSP_TUI_MARKER}\n`);
  } finally {
    if (application) {
      await act(async () => {
        setup.mockInput.pressKey("c", { ctrl: true });
      });
      process.emit("SIGTERM");
      await application.catch(() => {});
    }
    act(() => setup.renderer.destroy());
    globalThis.fetch = nativeFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(storage, { recursive: true, force: true });
  }
}
if (import.meta.main)
  await runLspTuiScenario(process.env.CHISEL_TEST_LSP_CAPTURES);
