/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type {
  CatalogExtension,
  ExtensionReview,
  ExtensionSettings,
} from "../../src/desktop/protocol.js";
import type { ExtensionManagementService } from "../../src/extensions/management.js";
import { THEMES } from "../../src/ui/appearance.js";
import { OpenTuiExtensions } from "../../src/ui/opentui-extensions.js";
import type { SettingsPanelControl } from "../../src/ui/settings-panel.js";

const extension = (id = "example.notes"): CatalogExtension => ({
  id,
  name: id,
  description: "Заметки проекта без облачного сервиса",
  origin: "installed",
  version: "1.0.0",
  source: "/extensions/notes",
  digest: "a".repeat(64),
  revision: 1,
  compatible: true,
  compatibility: "API v1",
  trusted: true,
  desiredEnabled: false,
  actualState: "disabled",
  actualLabel: "Выключено",
  state: "disabled",
  projectBlocked: false,
  restartRequired: false,
  deferredRemoval: false,
  actions: ["enable", "settings", "update", "versions", "remove"],
  versions: [],
});
function api(items = [extension()]) {
  const calls: unknown[] = [];
  let settings: ExtensionSettings = {
    id: items[0]!.id,
    schema: {
      fields: [
        { name: "message", label: "Сообщение", type: "string" },
        { name: "token", label: "Токен", type: "string", secret: true },
      ],
    },
    revision: 1,
    values: { message: "Привет" },
    secretSet: {},
    unknownKeys: [],
    issues: [],
    restartRequired: false,
  };
  const service = {
    list: async () => ({ items, revision: 1 }),
    setEnabled: async (value: { id: string; enabled: boolean }) => {
      calls.push(value);
      return { id: value.id, restartRequired: false };
    },
    settings: async (
      _read: unknown,
      patch?: {
        values: Record<string, string>;
        secrets: Record<string, string>;
      },
    ) => {
      if (patch) {
        calls.push(patch);
        settings = {
          ...settings,
          revision: settings.revision + 1,
          values: patch.values,
          secretSet: { token: !!patch.secrets.token },
        };
      }
      return settings;
    },
    prepare: async (value: { requestId: string; kind: string }) => {
      calls.push(value);
      return {
        ...extension(),
        requestId: value.requestId,
        kind: value.kind,
        location: "/extensions/notes",
        entry: "index.mjs",
        files: 2,
        bytes: 123,
        contents: [],
        trustRequired: true,
        requestedEnabled: false,
        downgrade: false,
      } as unknown as ExtensionReview;
    },
    operation: () => ({ phase: "review" }),
    cancel: async (id: string) => {
      calls.push({ cancel: id });
    },
    commit: async (value: unknown) => {
      calls.push(value);
      return { id: items[0]!.id, restartRequired: false };
    },
  } as unknown as ExtensionManagementService;
  return { calls, service };
}
type Setup = Awaited<ReturnType<typeof testRender>>;
async function frame(ui: Setup) {
  await act(async () => {
    await ui.renderOnce();
    await ui.renderOnce();
  });
}
async function key(ui: Setup, name: string) {
  await act(async () => ui.mockInput.pressKey(name));
  await frame(ui);
}
async function paste(ui: Setup, value: string) {
  await act(async () => ui.mockInput.pasteBracketedText(value));
  await frame(ui);
}
async function click(ui: Setup, id: string) {
  const node = ui.renderer.root.findDescendantById(id);
  expect(node, id).toBeDefined();
  await act(async () => {
    for (let parent = node!.parent; parent; parent = parent.parent)
      if (parent instanceof ScrollBoxRenderable) parent.scrollChildIntoView(id);
  });
  await frame(ui);
  await act(async () => ui.mockMouse.click(node!.x + 1, node!.y));
  await frame(ui);
}
async function setup(items?: CatalogExtension[], width = 73, height = 21) {
  const { service, calls } = api(items);
  const controls: { current: SettingsPanelControl | undefined } = {
    current: undefined,
  };
  let dirty = false;
  const builtins: string[] = [];
  function Panel() {
    const size = useTerminalDimensions();
    return (
      <OpenTuiExtensions
        management={service}
        palette={THEMES.obsidian}
        width={size.width}
        height={size.height}
        active
        focused
        controls={controls}
        onDirty={(value) => {
          dirty = value;
        }}
        onOpenBuiltin={(route) => builtins.push(route)}
      />
    );
  }
  const ui = await testRender(<Panel />, { width, height });
  await frame(ui);
  return { ui, controls, calls, builtins, dirty: () => dirty };
}
function destroy(ui: Setup) {
  act(() => ui.renderer.destroy());
}

test("catalog letters never mutate a package; Enter opens its separate action card", async () => {
  const { ui, calls } = await setup();
  try {
    for (const letter of ["i", "e", "s", "u", "v", "t", "DELETE"])
      await key(ui, letter);
    expect(calls).toEqual([]);
    expect(
      ui.renderer.root.findDescendantById("extensions-actions"),
    ).toBeUndefined();
    await key(ui, "RETURN");
    expect(
      ui.renderer.root.findDescendantById("extensions-actions"),
    ).toBeDefined();
    expect(
      ui.renderer.root.findDescendantById("extensions-install"),
    ).toBeUndefined();
    expect(calls).toEqual([]);
    await key(ui, "RETURN");
    expect(calls).toEqual([
      expect.objectContaining({ id: "example.notes", enabled: true }),
    ]);
    expect(ui.captureCharFrame()).not.toContain("E вкл");
  } finally {
    destroy(ui);
  }
});

test("filter, search and card return keep context; a large catalog reaches its last item by keyboard", async () => {
  const items = Array.from({ length: 120 }, (_, index) =>
    extension(`example.item-${String(index).padStart(3, "0")}`),
  );
  const { ui, controls, calls } = await setup(items);
  try {
    await key(ui, "END");
    await key(ui, "RETURN");
    expect(ui.captureCharFrame()).toContain("item-119");
    await act(async () => {
      controls.current!.back();
    });
    await frame(ui);
    expect(ui.captureCharFrame()).toContain("item-119");
    await click(ui, "extensions-search");
    await paste(ui, "item-042");
    await key(ui, "RETURN");
    await key(ui, "RETURN");
    expect(ui.captureCharFrame()).toContain("item-042");
    await act(async () => {
      controls.current!.back();
    });
    await frame(ui);
    expect(ui.captureCharFrame()).toContain("Показано 1 из 120");
    await click(ui, "extensions-filter");
    await click(ui, "extensions-filter-1");
    expect(ui.captureCharFrame()).toContain("Ничего не найдено");
    expect(calls).toEqual([]);
  } finally {
    destroy(ui);
  }
});

test("trust remains unchecked and Enter cannot bypass a disabled confirmation", async () => {
  const { ui, calls } = await setup([
    {
      ...extension(),
      trusted: false,
      state: "not_trusted",
      actions: ["trust", "remove"],
    },
  ]);
  try {
    await key(ui, "RETURN");
    await click(ui, "extensions-action-trust");
    await key(ui, "RETURN");
    expect(calls).toHaveLength(1);
    await key(ui, "t");
    expect(calls).toHaveLength(1);
    await click(ui, "extensions-trust");
    await click(ui, "extensions-commit");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      digest: "a".repeat(64),
      revision: 1,
      trust: true,
      enable: true,
    });
  } finally {
    destroy(ui);
  }
});

test("unconfirmed input is dirty, secret stays masked, and settings remain bound to the selected package", async () => {
  const { ui, controls, calls, dirty } = await setup([
    extension(),
    extension("other.package"),
  ]);
  try {
    await key(ui, "RETURN");
    await click(ui, "extensions-action-settings");
    await click(ui, "extensions-setting-message");
    await paste(ui, " новый");
    expect(dirty()).toBe(true);
    await act(async () => {
      controls.current!.back();
    });
    await frame(ui);
    expect(dirty()).toBe(false);
    await click(ui, "extensions-setting-token");
    await paste(ui, "private-test-token");
    expect(ui.renderer.currentFocusedEditor?.plainText).toBe("*".repeat(18));
    for (const [width, height] of [
      [40, 16],
      [24, 8],
      [73, 21],
    ]) {
      const editor = ui.renderer.currentFocusedEditor;
      await act(async () => ui.resize(width!, height!));
      await frame(ui);
      expect(ui.renderer.currentFocusedEditor).toBe(editor);
      expect(ui.captureCharFrame()).not.toContain("private-test-token");
      expect(ui.captureCharFrame()).toContain("***");
    }
    await key(ui, "RETURN");
    await click(ui, "extensions-settings-save");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      values: { message: "Привет" },
      secrets: { token: "private-test-token" },
    });
  } finally {
    destroy(ui);
  }
});

test("builtin configuration is a named action in its card", async () => {
  const { ui, calls, builtins } = await setup([
    {
      ...extension("builtin.lsp"),
      origin: "builtin",
      actions: ["settings"],
      settingsRoute: "tools.lsp",
    },
  ]);
  try {
    await key(ui, "RETURN");
    expect(builtins).toEqual([]);
    await key(ui, "RETURN");
    expect(builtins).toEqual(["tools.lsp"]);
    expect(calls).toEqual([]);
  } finally {
    destroy(ui);
  }
});

test("a 24-column catalog only navigates controls that are actually shown", async () => {
  const { ui, calls } = await setup(undefined, 24, 8);
  try {
    expect(
      ui.renderer.root.findDescendantById("extensions-refresh"),
    ).toBeUndefined();
    await key(ui, "ARROW_UP");
    await key(ui, "RETURN");
    expect(
      ui.renderer.root.findDescendantById("extensions-filter-0"),
    ).toBeDefined();
    expect(calls).toEqual([]);
  } finally {
    destroy(ui);
  }
});
