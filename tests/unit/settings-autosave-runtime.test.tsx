/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTerminalDimensions } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/load.js";
import { createBuiltinProviderRegistry } from "../../src/providers/runtime.js";
import {
  OpenTuiSettings,
  type OpenTuiSettingsActions,
} from "../../src/ui/opentui-settings.js";
import {
  saveProviderSettings,
  settingsDraft,
} from "../../src/ui/provider-settings.js";
import { menuAction, uiKey } from "../fixtures/menu-navigation.js";

test("native Settings autosaves through disk errors, fast edits, resize, close and reopen without activating viewed profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-autosave-ui-"));
  const path = join(root, "config.json");
  const registry = createBuiltinProviderRegistry();
  let writes = 0;
  let selected = "a";
  let closed = 0;
  let hold = false;
  let release: (() => void) | undefined;
  let started = false;
  const actions: OpenTuiSettingsActions = {
    catalog: async () => ({
      providers: registry.list(),
      profiles: (await loadGlobalConfig(path)).profiles,
    }),
    load: async (id) => ({
      values: settingsDraft(await loadGlobalConfig(path), registry, {
        profile: id ?? "a",
      }),
      hasKey: false,
    }),
    hasKey: async () => false,
    save: async (values, previous) => {
      writes++;
      if (hold) {
        hold = false;
        started = true;
        await new Promise<void>((done) => {
          release = done;
        });
      }
      return saveProviderSettings(values, registry, {
        configPath: path,
        previous,
        activate: false,
      });
    },
    activate: async (values) => {
      selected = values.profileId!;
    },
    check: async () => "OK",
    models: async () => ({ ok: true, models: [] }),
  };
  function App() {
    const { width, height } = useTerminalDimensions();
    return (
      <OpenTuiSettings
        actions={actions}
        width={width}
        height={height}
        onClose={() => {
          closed++;
        }}
      />
    );
  }
  let ui: Awaited<ReturnType<typeof testRender>> | undefined;
  try {
    await saveGlobalConfig(
      {
        schemaVersion: 2,
        defaultProfileId: "a",
        profiles: {
          a: { providerId: "openai", defaultModel: "gpt-5", label: "Первый" },
          b: { providerId: "openai", defaultModel: "other", label: "Второй" },
        },
        ui: { accent: "#123456" },
      },
      path,
    );
    ui = await testRender(<App />, { width: 120, height: 40 });
    const view = ui;
    const frame = async () => {
      await act(async () => {
        await view.renderOnce();
      });
    };
    const until = async (ready: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 4000;
      while (!(await ready())) {
        if (Date.now() > deadline) throw new Error(view.captureCharFrame());
        await act(async () => {
          await new Promise((done) => setTimeout(done, 10));
          await view.renderOnce();
        });
      }
    };
    const click = async (id: string) => {
      const node = view.renderer.root.findDescendantById(id);
      if (!node) throw new Error(`Missing ${id}\n${view.captureCharFrame()}`);
      await act(async () => {
        await view.mockMouse.click(node.x + 1, node.y);
      });
      await frame();
    };
    const paste = async (text: string) => {
      await act(async () => {
        await view.mockInput.pasteBracketedText(text);
      });
      await frame();
    };
    await until(() => view.captureCharFrame().includes("Второй"));
    await click("settings-row-b");
    expect(selected).toBe("a");
    expect(writes).toBe(0);
    await menuAction(view, "settings-actions", "settings-use-profile");
    expect(selected).toBe("b");
    await click("settings-profile-switcher");
    await click("settings-row-a");
    expect(writes).toBe(0);
    expect(selected).toBe("b");
    await click("settings-row-profile-label");
    await act(async () => view.mockInput.pressKey("u", { ctrl: true }));
    await frame();
    await paste("без ключа");
    await uiKey(view, "RETURN");
    await until(
      async () =>
        (await loadGlobalConfig(path)).profiles.a?.label === "без ключа",
    );
    await until(
      () =>
        view.captureCharFrame().includes("требуется настройка") &&
        !view.renderer.root.findDescendantById("settings-field"),
    );
    expect((await loadGlobalConfig(path)).defaultProfileId).toBe("a");
    const backup = await readFile(path, "utf8");
    await rm(path);
    await mkdir(path);
    await click("settings-row-profile-label");
    await act(async () => view.mockInput.pressKey("u", { ctrl: true }));
    await frame();
    await paste("после ошибки");
    await uiKey(view, "RETURN");
    expect(view.renderer.currentFocusedEditor?.plainText).toBe("после ошибки");
    await until(() => view.captureCharFrame().includes("EISDIR"));
    await act(async () => {
      await view.mockMouse.click(0, 0);
    });
    await frame();
    expect(closed).toBe(0);
    await until(() => view.captureCharFrame().includes("EISDIR"));
    await rm(path, { recursive: true });
    await writeFile(path, backup);
    await uiKey(view, "RETURN");
    await until(
      async () =>
        (await loadGlobalConfig(path)).profiles.a?.label === "после ошибки" &&
        !view.renderer.root.findDescendantById("settings-field"),
    );
    await uiKey(view, "RETURN");
    await act(async () => view.mockInput.pressKey("u", { ctrl: true }));
    await frame();
    await until(
      () => view.renderer.currentFocusedEditor?.id === "settings-field",
    );
    hold = true;
    await paste("быстро");
    await until(() => started);
    await paste(" и последнее");
    const editor = view.renderer.currentFocusedEditor;
    const captures = process.env.CHISEL_AUTOSAVE_CAPTURES;
    if (captures) await mkdir(captures, { recursive: true });
    for (const [width, height] of [
      [120, 40],
      [80, 24],
      [40, 16],
      [24, 8],
    ]) {
      await act(async () => view.resize(width!, height!));
      await frame();
      expect(view.renderer.currentFocusedEditor).toBe(editor);
      expect(editor?.plainText).toBe("быстро и последнее");
      if (captures) {
        const name = join(captures, `connections-${width}x${height}`);
        await writeFile(`${name}.txt`, view.captureCharFrame());
        const spans = view.captureSpans();
        await writeFile(
          `${name}.json`,
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
    }
    await act(async () => {
      await view.mockMouse.click(0, 0);
    });
    await frame();
    expect(closed).toBe(0);
    await act(async () => release?.());
    await until(() => closed === 1);
    const final = await loadGlobalConfig(path);
    expect(final.profiles.a?.label).toBe("быстро и последнее");
    expect(final.profiles.b?.label).toBe("Второй");
    expect(final.ui?.accent).toBe("#123456");
    expect(selected).toBe("b");
    expect(settingsDraft(final, registry, { profile: "a" }).label).toBe(
      "быстро и последнее",
    );
    act(() => view.renderer.destroy());
    ui = await testRender(<App />, { width: 100, height: 30 });
    const reopened = ui;
    const count = writes;
    await act(async () => {
      await reopened.renderOnce();
      await reopened.renderOnce();
    });
    const deadline = Date.now() + 4000;
    while (!reopened.captureCharFrame().includes("быстро и последнее")) {
      if (Date.now() > deadline) throw new Error(reopened.captureCharFrame());
      await act(async () => {
        await new Promise((done) => setTimeout(done, 10));
        await reopened.renderOnce();
      });
    }
    expect(writes).toBe(count);
    expect(reopened.captureCharFrame()).toContain("Второй");
  } finally {
    release?.();
    if (ui) act(() => ui!.renderer.destroy());
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
