/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { saveGlobalConfig } from "../../src/config/load.js";
import { LspSettingsStore } from "../../src/lsp/settings.js";
import { THEMES } from "../../src/ui/appearance.js";
import { OpenTuiLspSettings } from "../../src/ui/opentui-lsp-settings.js";
import type { SettingsPanelControl } from "../../src/ui/settings-panel.js";

test("LSP without a project saves keyboard toggles globally and retains a project selection action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chisel-lsp-home-ui-"));
  const configPath = join(directory, "selected.json");
  await saveGlobalConfig(
    { schemaVersion: 2, profiles: {}, future: { keep: true } },
    configPath,
  );
  let chosen = 0;
  const actions = new LspSettingsStore(undefined, configPath, {
    status: async () => {
      throw new Error("No workspace status must be requested");
    },
    apply: async () => {},
    restart: async () => {
      throw new Error("Passive home menu must not execute tools");
    },
  });
  const controls: { current: SettingsPanelControl | undefined } = {
    current: undefined,
  };
  const setup = await testRender(
    <OpenTuiLspSettings
      actions={actions}
      palette={THEMES.paper}
      width={70}
      height={22}
      active
      focused
      controls={controls}
      onDirty={() => {}}
      onChooseProject={() => {
        ++chosen;
      }}
    />,
    { width: 70, height: 22 },
  );
  const frame = async () =>
    act(async () => {
      await Bun.sleep(5);
      await setup.renderOnce();
    });
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      await frame();
      if (await predicate()) return;
    }
    throw new Error(`LSP home UI did not settle\n${setup.captureCharFrame()}`);
  };
  const key = async (name: string) => {
    await act(async () => setup.mockInput.pressKey(name));
    await frame();
  };
  try {
    await until(() =>
      setup.captureCharFrame().includes("Анализ кода: Включён"),
    );
    expect(setup.captureCharFrame()).toContain("Все проекты");
    await key("ARROW_DOWN"); // scope -> overall permission
    await key(" ");
    await until(
      async () =>
        JSON.parse(await readFile(configPath, "utf8")).lsp?.enabled === false,
    );
    await until(() =>
      setup.captureCharFrame().includes("Анализ кода: Выключен"),
    );
    expect(JSON.parse(await readFile(configPath, "utf8")).future).toEqual({
      keep: true,
    });
    await key("END");
    await key("RETURN");
    expect(chosen).toBe(1);
    await act(async () => controls.current?.search?.());
    await act(async () => setup.mockInput.pasteBracketedText("Python"));
    await frame();
    expect(setup.renderer.currentFocusedEditor).toBeDefined();
    await key(" ");
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("Python ");
    expect(JSON.parse(await readFile(configPath, "utf8")).lsp.enabled).toBe(
      false,
    );
  } finally {
    act(() => setup.renderer.destroy());
    await rm(directory, { recursive: true, force: true });
  }
});

test("LSP card explains Plan and disables explicit launch without asking the runtime to start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chisel-lsp-plan-ui-"));
  const configPath = join(directory, "selected.json");
  await saveGlobalConfig({ schemaVersion: 2, profiles: {} }, configPath);
  let restarts = 0;
  const actions = new LspSettingsStore(directory, configPath, {
    status: async () => ({
      workspaceRoot: directory,
      backend: "typescript",
      state: "stopped",
      generation: 0,
      trackedDocuments: 0,
      requiresRestart: false,
    }),
    apply: async () => {},
    restart: async () => {
      ++restarts;
      return { output: "unexpected" };
    },
    launchRestriction: () => "Режим Plan: явный запуск доступен в Build.",
  });
  const setup = await testRender(
    <OpenTuiLspSettings
      actions={actions}
      palette={THEMES.obsidian}
      width={90}
      height={24}
      active
      focused
      controls={{ current: undefined }}
      onDirty={() => {}}
    />,
    { width: 90, height: 24 },
  );
  const frame = async () =>
    act(async () => {
      await Bun.sleep(5);
      await setup.renderOnce();
    });
  const click = async (id: string) => {
    const deadline = Date.now() + 3000;
    while (!setup.renderer.root.findDescendantById(id) && Date.now() < deadline)
      await frame();
    const node = setup.renderer.root.findDescendantById(id);
    if (!node) throw new Error(`Missing ${id}`);
    await act(async () => setup.mockMouse.click(node.x + 1, node.y));
    await frame();
  };
  try {
    const readyDeadline = Date.now() + 3000;
    while (
      !setup.captureCharFrame().includes("Анализ кода: Включён") &&
      Date.now() < readyDeadline
    )
      await frame();
    expect(setup.captureCharFrame()).toContain("Анализ кода: Включён");
    await click("lsp-row-catalog");
    await click("lsp-row-server-auto");
    await click("lsp-row-start");
    expect(restarts).toBe(0);
    // Keyboard selection reveals the reason as well as the disabled mouse action.
    for (let index = 0; index < 3; index++) {
      await act(async () => setup.mockInput.pressKey("ARROW_DOWN"));
      await frame();
    }
    expect(setup.captureCharFrame()).toContain("Режим Plan");
    await act(async () => setup.mockInput.pressKey("RETURN"));
    await frame();
    expect(restarts).toBe(0);
    expect((await actions.load()).status.generation).toBe(0);
  } finally {
    act(() => setup.renderer.destroy());
    await rm(directory, { recursive: true, force: true });
  }
});
