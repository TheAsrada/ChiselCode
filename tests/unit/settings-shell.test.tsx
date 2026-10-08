/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import type { InputRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { builtinDefinitions } from "../../src/providers/definitions/index.js";
import type { OpenTuiSettingsActions } from "../../src/ui/opentui-settings.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import {
  SETTINGS_SECTIONS,
  searchSettings,
} from "../../src/ui/settings-catalog.js";
import { WebConfigSchema } from "../../src/web/schema.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
async function frame(setup: Setup) {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await Bun.sleep(10);
      await setup.renderOnce();
    });
}
async function key(setup: Setup, name: string, ctrl = false, shift = false) {
  await act(async () => {
    setup.mockInput.pressKey(
      name === "ENTER"
        ? "RETURN"
        : ["UP", "DOWN", "LEFT", "RIGHT"].includes(name)
          ? `ARROW_${name}`
          : name,
      { ctrl, shift },
    );
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame(setup);
}
async function paste(setup: Setup, text: string) {
  await act(async () => {
    await setup.mockInput.pasteBracketedText(text);
  });
  await frame(setup);
}
async function click(setup: Setup, id: string) {
  const node = setup.renderer.root.findDescendantById(id);
  if (!node?.visible || !node.height) throw new Error(`Missing ${id}`);
  await act(async () => {
    await setup.mockMouse.click(node.x + 1, node.y);
  });
  await frame(setup);
}
function api() {
  const saves: unknown[] = [];
  const actions: OpenTuiSettingsActions = {
    catalog: async () => ({ providers: builtinDefinitions, profiles: {} }),
    load: async () => ({
      values: { provider: "anthropic", model: "claude-opus-5" },
      hasKey: true,
    }),
    hasKey: async () => true,
    save: async (value) => {
      saves.push(value);
      return "saved";
    },
    check: async () => "OK",
    models: async () => ({ models: [], source: "none" }),
    web: {
      load: async () => ({ config: WebConfigSchema.parse({}), hasKey: false }),
      save: async (config) => {
        saves.push(config);
        return { config, hasKey: false };
      },
    },
  };
  return { actions, saves };
}
test("catalog search uses only curated metadata and deep links fields in RU/EN", () => {
  for (const query of ["lsp", "анализ кода", "языковой сервер", "typescript"])
    expect(searchSettings(query)[0]?.section.id).toBe("tools.lsp");
  for (const query of ["ключ", "api"])
    expect(searchSettings(query)[0]).toMatchObject({
      field: "key",
      section: { id: "connection" },
    });
  expect(searchSettings("theme")[0]?.section.id).toBe("appearance");
  expect(searchSettings("mcp")[0]?.section.id).toBe("tools.mcp");
  expect(searchSettings("web")[0]?.section.id).toBe("tools.web");
  expect(searchSettings("private-key-value")).toEqual([]);
  expect(searchSettings("")).toHaveLength(7);
  expect(
    searchSettings("fixture", [
      ...SETTINGS_SECTIONS,
      {
        id: "tools.lsp",
        group: "Fixture",
        title: "Fixture section",
        description: "test",
        keywords: [],
        fields: [],
      },
    ])[0]?.title,
  ).toBe("Fixture section");
});
test("search deep links native secret input; hidden/composer controls cannot consume typing, resize retains cursor and dirty draft", async () => {
  const { actions, saves } = api();
  let prompts = 0;
  const setup = await testRender(
    <OpenTuiSpike
      settingsActions={actions}
      onExit={() => {}}
      onSubmit={async () => {
        ++prompts;
      }}
    />,
    { width: 120, height: 40 },
  );
  try {
    await frame(setup);
    await paste(setup, "ordinary draft");
    const composer = setup.renderer.currentFocusedEditor;
    await key(setup, "t", true);
    await key(setup, "f", true);
    await paste(setup, "ключ");
    await key(setup, "ENTER");
    const secret = setup.renderer.currentFocusedEditor;
    expect(secret?.id).toBe("settings-secret");
    await paste(setup, "private-key-value");
    await key(setup, "LEFT");
    const cursor = secret?.cursorOffset;
    for (const [width, height] of [
      [100, 30],
      [80, 24],
      [60, 20],
      [40, 12],
      [24, 8],
    ] as const) {
      await act(async () => setup.resize(width, height));
      await frame(setup);
      expect(setup.renderer.currentFocusedEditor === secret).toBe(true);
      expect(secret?.cursorOffset).toBe(cursor);
      expect(setup.captureCharFrame()).not.toContain("private-key-value");
    }
    await key(setup, "ENTER");
    await act(async () => setup.resize(120, 40));
    await frame(setup);
    await click(setup, "settings-route-appearance");
    await key(setup, "f", true);
    await paste(setup, "api");
    await key(setup, "ENTER");
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
      "*".repeat("private-key-value".length),
    );
    await key(setup, "ESCAPE");
    await key(setup, "ESCAPE");
    expect(setup.captureCharFrame()).toContain("Несохранённые");
    await key(setup, "DOWN");
    await key(setup, "DOWN");
    await key(setup, "ENTER");
    expect(setup.renderer.currentFocusedEditor === composer).toBe(true);
    expect(composer?.plainText).toBe("ordinary draft");
    expect(prompts).toBe(0);
    expect(saves).toEqual([]);
  } finally {
    act(() => setup.renderer.destroy());
  }
});
test("Web draft survives navigation, targeted save persists only Web, Escape query clear does not close Settings", async () => {
  const { actions, saves } = api();
  const setup = await testRender(
    <OpenTuiSpike
      settingsActions={actions}
      onExit={() => {}}
      onSubmit={async () => {}}
    />,
    { width: 120, height: 40 },
  );
  try {
    await frame(setup);
    await key(setup, "t", true);
    await click(setup, "settings-route-tools.web");
    await click(setup, "settings-web-row-0");
    expect(saves).toEqual([]);
    await click(setup, "settings-route-connection");
    await click(setup, "settings-route-tools.web");
    expect(setup.captureCharFrame()).toContain("Выключен");
    await key(setup, "s", true);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ enabled: false });
    await key(setup, "f", true);
    await paste(setup, "no-such-setting");
    expect(setup.captureCharFrame()).toContain("Нет результатов");
    await key(setup, "ESCAPE");
    expect(
      setup.renderer.root.findDescendantById("settings-popup"),
    ).toBeDefined();
    expect(
      (
        setup.renderer.root.findDescendantById(
          "settings-global-search",
        ) as InputRenderable
      ).value,
    ).toBe("");
    expect(setup.captureCharFrame()).not.toContain(
      "Изменения сохраняются сразу",
    );
  } finally {
    act(() => setup.renderer.destroy());
  }
});
