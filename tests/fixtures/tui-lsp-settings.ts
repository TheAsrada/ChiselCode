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
export async function runLspTuiScenario(captures?: string): Promise<void> {
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
      ui: { theme: "graphite", sidebarMode: "hide", unicodeDecorations: false },
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
  const paths = await installedLsp();
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
  let application: Promise<void> | undefined;
  const frames = async (count = 3) => {
    for (let i = 0; i < count; i++)
      await act(async () => {
        await Bun.sleep(15);
        await setup.renderOnce();
      });
  };
  const key = async (name: string, ctrl = false) => {
    await act(async () => {
      setup.mockInput.pressKey(name === "ENTER" ? "RETURN" : name, { ctrl });
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
    predicate: () => boolean,
    message: string,
    milliseconds = 12_000,
  ) => {
    const end = Date.now() + milliseconds;
    while (!predicate() && Date.now() < end) await frames();
    assert.ok(predicate(), `${message}\n${setup.captureCharFrame()}`);
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
  const field = async (id: string, value: string) => {
    await click(`lsp-row-${id}`);
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
    await frames(6);
    await command("/settings");
    await wait(
      () => !!setup.renderer.root.findDescendantById("settings-global-search"),
      "Settings did not open",
    );
    await capture("wide-120x40");
    if (captures) {
      for (const [width, height] of [
        [100, 30],
        [80, 24],
        [60, 20],
        [40, 12],
        [24, 8],
      ] as const) {
        await act(async () => setup.resize(width, height));
        await frames();
        await capture(`navigation-${width}x${height}`);
      }
      await act(async () => setup.resize(120, 40));
      await frames();
    }
    await key("f", true);
    await paste("анализ кода");
    assert.ok(setup.captureCharFrame().includes("Анализ кода"));
    await capture("search-120x40");
    await key("ENTER");
    await wait(
      () => !!setup.renderer.root.findDescendantById("lsp-row-mode-auto"),
      "Default Auto mode missing",
    );
    assert.ok(setup.captureCharFrame().includes("[x] Auto"));
    assert.equal(
      (await lspProcessTree()).length,
      0,
      "Settings/listing must not start Auto",
    );
    await capture("lsp-auto-idle-120x40");
    if (captures) {
      for (const [width, height] of [
        [100, 30],
        [80, 24],
        [60, 20],
        [40, 12],
        [24, 8],
      ] as const) {
        await act(async () => setup.resize(width, height));
        await frames();
        await capture(`lsp-auto-idle-${width}x${height}`);
      }
      await act(async () => setup.resize(120, 40));
      await frames();
    }
    await click("lsp-project");
    assert.ok(
      !setup.renderer.root.findDescendantById("lsp-row-trust")?.visible,
      "Standard backend must not require per-project trust",
    );
    await capture("lsp-auto-project-120x40");
    await key("ESCAPE");
    await key("ESCAPE");
    await command("/inspect-types");
    await wait(
      () => setup.captureCharFrame().includes("2322"),
      "Default Auto must lazily analyse without paths/trust",
    );
    const autoProcesses = await lspProcessTree();
    assert.ok(
      autoProcesses.length >= 2,
      "Real Auto server/tsserver not observed",
    );
    await command("/settings");
    await wait(
      () => !!setup.renderer.root.findDescendantById("settings-global-search"),
      "Settings did not reopen for Auto",
    );
    await key("f", true);
    await paste("анализ кода");
    await key("ENTER");
    await wait(
      () => setup.captureCharFrame().includes("[ok] Готов"),
      "Auto should show actual readiness",
    );
    await capture("lsp-auto-ready-120x40");
    if (captures) {
      await click("settings-route-appearance");
      await click("settings-theme-paper");
      await key("s", true);
      await frames();
      await click("settings-route-tools.lsp");
      await capture("lsp-auto-ready-paper-120x40");
      await click("settings-route-appearance");
      await click("settings-theme-graphite");
      await key("s", true);
      await click("settings-route-tools.lsp");
    }
    await click("lsp-row-mode-off");
    await capture("lsp-auto-off-draft-120x40");
    await click("lsp-save");
    await wait(
      () => setup.captureCharFrame().includes("активные серверы закрыты"),
      "Off save failed",
    );
    await waitForLspProcessExit(autoProcesses);
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).lsp.mode,
      "off",
    );
    await click("lsp-row-mode-custom");
    await capture("lsp-empty-120x40");
    await click("lsp-row-add");
    await field("node", paths.command);
    await field("server", paths.args[0] ?? "");
    await click("lsp-row-typescript");
    await key("a", true);
    await paste(paths.typescriptPath);
    const editor = setup.renderer.currentFocusedEditor;
    assert.ok(editor);
    const cursor = editor.cursorOffset;
    for (const [width, height] of [
      [100, 30],
      [80, 24],
      [60, 20],
      [40, 12],
      [24, 8],
    ] as const) {
      await act(async () => setup.resize(width, height));
      await frames();
      assert.ok(
        setup.renderer.currentFocusedEditor === editor,
        "Resize lost native path focus",
      );
      assert.equal(editor.cursorOffset, cursor);
      await capture(`path-${width}x${height}`);
    }
    await act(async () => setup.resize(120, 40));
    await frames();
    await key("ENTER");
    await capture("lsp-form-dirty-120x40");
    await key("f", true);
    await key("a", true);
    await paste("auto");
    await key("ENTER");
    assert.ok(
      setup.captureCharFrame().includes("черновик своего сервера"),
      "Mode deep link must not discard a dirty server form",
    );
    assert.ok(
      setup.renderer.root.findDescendantById("lsp-row-node")?.visible,
      "Unsaved custom paths disappeared",
    );
    await click("lsp-row-check");
    await wait(
      () => setup.captureCharFrame().includes("Пути доступны"),
      "Read-only path check failed",
    );
    assert.deepEqual(
      JSON.parse(await readFile(configPath, "utf8")).lsp,
      { mode: "off", servers: {} },
      "Check must not save or start",
    );
    await click("lsp-save");
    await wait(
      () => setup.captureCharFrame().includes("Сохранено"),
      "LSP config save failed",
    );
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.lsp.servers.typescript.command, paths.command);
    assert.deepEqual(saved.lsp.servers.typescript.trustedWorkspaces, []);
    // Saving one scope must leave the other scope's draft intact.
    await click("lsp-row-enabled");
    await click("lsp-project");
    await click("lsp-row-mode"); // inherit → auto
    await click("lsp-row-mode"); // auto → custom
    await click("lsp-row-mode"); // custom → off
    await click("lsp-global");
    await click("lsp-save");
    await wait(
      () => setup.captureCharFrame().includes("Сохранено"),
      "Global draft save failed",
    );
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).lsp.servers.typescript
        .enabled,
      false,
    );
    assert.equal(
      await readFile(join(root, ".chiselrc"), "utf8").catch(() => ""),
      "",
      "Global save must not save the hidden project draft",
    );
    assert.ok(
      setup.captureCharFrame().includes("draft *"),
      "Hidden project draft must remain dirty",
    );
    await click("lsp-project");
    assert.ok(
      setup.captureCharFrame().includes("Выключен"),
      "Global save discarded the project draft",
    );
    await click("lsp-save");
    await wait(
      () =>
        setup.captureCharFrame().includes("Настройки этого проекта сохранены"),
      "Project draft save failed",
    );
    assert.equal(
      JSON.parse(await readFile(join(root, ".chiselrc"), "utf8")).lsp.mode,
      "off",
    );
    await click("lsp-row-mode"); // off → inherit
    await click("lsp-save");
    await wait(
      () =>
        setup.captureCharFrame().includes("Настройки этого проекта сохранены"),
      "Project inherit save failed",
    );
    await click("lsp-global");
    await click("lsp-row-enabled");
    await click("lsp-save");
    await wait(
      () => setup.captureCharFrame().includes("Сохранено"),
      "Server re-enable save failed",
    );
    await click("lsp-row-trust");
    await wait(
      () => setup.captureCharFrame().includes("Разрешён только"),
      "Explicit trust failed",
    );
    await click("lsp-row-start");
    await wait(
      () => !!setup.renderer.root.findDescendantById("approval-popup"),
      "Restart bypassed normal approval",
    );
    await key("y");
    await wait(
      () => setup.captureCharFrame().includes("[ok] Готов"),
      "Real LSP initialize did not return ready",
    );
    assert.ok(
      setup.renderer.root.findDescendantById("lsp-row-node"),
      "Home→conversation discarded the Settings form",
    );
    await capture("lsp-ready-120x40");
    await click("lsp-row-start");
    await wait(
      () => !!setup.renderer.root.findDescendantById("approval-popup"),
      "Second restart did not use the existing approval path",
    );
    await key("y");
    await wait(
      () =>
        setup.captureCharFrame().includes("[ok] Готов") &&
        !setup.renderer.root.findDescendantById("approval-popup"),
      "Second restart did not complete",
    );
    const restartedStore = await projectSessionStore(root);
    const restartedSessions = await restartedStore.list();
    assert.equal(
      restartedSessions.length,
      1,
      "Settings must reuse the conversation allocated on home",
    );
    let restarted = false;
    for (let attempt = 0; attempt < 100 && !restarted; ++attempt) {
      await frames();
      const session = await restartedStore.load(restartedSessions[0]?.id ?? "");
      restarted = Object.values(session.runtime?.invocations ?? {}).some(
        (record) =>
          record.name === "ext:builtin.lsp:restart" &&
          record.result?.output.includes('"generation": 2'),
      );
    }
    assert.ok(restarted, "Second restart must advance the shared generation");
    if (captures) {
      await click("settings-route-appearance");
      await click("settings-theme-paper");
      await click("settings-route-tools.lsp");
      await capture("lsp-ready-paper-120x40");
      await click("settings-route-appearance");
      await click("settings-theme-graphite");
      await click("settings-apply-theme");
      await key("g", true);
      await click("settings-route-tools.lsp");
      await capture("lsp-ready-unicode-120x40");
      await click("settings-route-appearance");
      await click("settings-theme-paper");
      await click("settings-route-tools.lsp");
      await capture("lsp-ready-paper-unicode-120x40");
      await click("settings-route-appearance");
      await click("settings-theme-graphite");
      await click("settings-apply-theme");
      await key("g", true);
      await click("settings-route-tools.lsp");
    }
    await key("ESCAPE");
    await key("ESCAPE");
    await command("/inspect-types");
    await wait(
      () => setup.captureCharFrame().includes("2322"),
      "Real diagnostics missing",
    );
    const descendants = await lspProcessTree();
    assert.ok(descendants.length >= 2, "Real TLS/tsserver processes missing");
    await command("/fix-type");
    await wait(
      () => !!setup.renderer.root.findDescendantById("approval-popup"),
      "Editing approval missing",
    );
    await key("y");
    await wait(
      () => !setup.renderer.root.findDescendantById("approval-popup"),
      "Editing approval did not close",
    );
    await wait(
      () =>
        setup.captureCharFrame().includes("изменён") ||
        setup.captureCharFrame().includes("Updated") ||
        setup.captureCharFrame().includes("Заменено"),
      "Edit did not complete",
      1000,
    ).catch(() => {});
    assert.ok(
      (await readFile(join(root, "main.ts"), "utf8")).includes("value: string"),
    );
    await command("/lsp-status");
    await wait(
      () => setup.captureCharFrame().includes('"state": "ready"'),
      "LSP status command failed",
    );
    await command("/settings");
    await wait(
      () => !!setup.renderer.root.findDescendantById("settings-global-search"),
      "Settings did not reopen",
    );
    await key("f", true);
    await paste("lsp");
    await key("ENTER");
    await click("lsp-row-typescript"); // The saved server row, not the form's TypeScript field.
    await click("lsp-row-trusted-root-0");
    assert.equal(
      JSON.parse(await readFile(configPath, "utf8")).lsp.servers.typescript
        .trustedWorkspaces.length,
      1,
      "Removing a root from the draft must not revoke permission before save",
    );
    await click("lsp-save");
    await wait(
      () => setup.captureCharFrame().includes("Нет разрешения для проекта"),
      "Trust revocation did not complete",
    );
    assert.deepEqual(
      JSON.parse(await readFile(configPath, "utf8")).lsp.servers.typescript
        .trustedWorkspaces,
      [],
    );
    await waitForLspProcessExit(descendants);
    await capture("lsp-untrusted-120x40");
    const store = await projectSessionStore(root);
    const sessions = await store.list();
    assert.ok(sessions.length);
    const session = await store.load(sessions[0]?.id ?? "");
    assert.ok(
      Object.values(session.runtime?.invocations ?? {}).some(
        (record) =>
          record.toolSource?.type === "extension" &&
          record.toolSource.extensionId === "builtin.lsp",
      ),
    );
    assert.equal(
      session.messages.length,
      0,
      "Command tools must not create orphan model messages",
    );
    assert.equal(
      modelRequests,
      0,
      "Local LSP setup/commands must not request model chat",
    );
    if (captures) {
      await field("typescript", join(storage, "missing-tsserver.js"));
      await click("lsp-row-check");
      await wait(
        () => setup.captureCharFrame().includes("Проверьте пути"),
        "Missing path did not produce safe error",
      );
      await capture("lsp-path-error-120x40");
      await key("ESCAPE");
      await capture("lsp-dirty-confirm-120x40");
      await click("settings-discard");
      await command("/exit");
      await application;
      process.stdout.write(`${LSP_TUI_MARKER}\n`);
      return;
    }
    await key("ESCAPE");
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
