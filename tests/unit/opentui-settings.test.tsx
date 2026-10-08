/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import type { InputRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { builtinDefinitions } from "../../src/providers/definitions/index.js";
import { matchingCommands, parseSlashCommand } from "../../src/ui/commands.js";
import { renderLogoRows } from "../../src/ui/logo.js";
import {
  OpenTuiSettings,
  type OpenTuiSettingsActions,
} from "../../src/ui/opentui-settings.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import type { TuiSettingsValues } from "../../src/ui/settings.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

test("graphics toggle saves, redraws and survives tab changes while preserving the composer", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  const persisted: boolean[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      onExit={() => {}}
      onSubmit={async () => {}}
      onUnicodeDecorationsChange={async (value) => {
        persisted.push(value);
      }}
    />,
    { width: 120, height: 36 },
  );
  try {
    await frame(setup);
    expect(setup.captureCharFrame()).not.toMatch(/[\u2500-\u259f]/u);
    await paste(setup, "черновик 😀");
    const editor = setup.renderer.currentFocusedEditor;
    await key(setup, "t", true);
    await key(setup, "g", true);
    expect(persisted).toEqual([true]);
    expect(setup.captureCharFrame()).toContain("╭");
    await key(setup, "ESCAPE");
    expect(setup.captureCharFrame()).toContain(renderLogoRows()[2]);
    expect(setup.renderer.currentFocusedEditor).toBe(editor);
    expect(editor?.plainText).toBe("черновик 😀");
    await act(async () => {
      workspace.newTab();
      workspace.newDraft();
    });
    await frame(setup);
    expect(setup.captureCharFrame()).toContain(renderLogoRows()[2]);
    await key(setup, "t", true);
    await click(setup, "settings-decoration-toggle");
    expect(persisted).toEqual([true, false]);
    await key(setup, "ESCAPE");
    expect(setup.captureCharFrame()).not.toMatch(/[\u2500-\u259f]/u);
  } finally {
    destroy(setup);
    workspace.dispose();
  }
});

test("failed graphics persistence keeps compatible borders and an unsent draft", async () => {
  const setup = await testRender(
    <OpenTuiSpike
      onExit={() => {}}
      onSubmit={async () => {}}
      onUnicodeDecorationsChange={async () => {
        throw new Error("Save failed");
      }}
    />,
    { width: 40, height: 12 },
  );
  try {
    await frame(setup);
    await paste(setup, "черновик");
    const editor = setup.renderer.currentFocusedEditor;
    await key(setup, "t", true);
    await click(setup, "settings-decoration-toggle");
    expect(setup.captureCharFrame()).toContain("Save failed");
    expect(setup.captureCharFrame()).not.toMatch(/[\u2500-\u259f]/u);
    await key(setup, "ESCAPE");
    expect(setup.renderer.currentFocusedEditor).toBe(editor);
    expect(editor?.plainText).toBe("черновик");
  } finally {
    destroy(setup);
  }
});

type Setup = Awaited<ReturnType<typeof testRender>>;
function api(overrides: Partial<OpenTuiSettingsActions> = {}) {
  const saved: TuiSettingsValues[] = [];
  const actions: OpenTuiSettingsActions = {
    catalog: async () => ({
      providers: builtinDefinitions,
      profiles: {
        work: { providerId: "anthropic", defaultModel: "claude-opus-5" },
      },
    }),
    load: async () => ({
      values: {
        provider: "anthropic",
        profileId: "work",
        model: "claude-opus-5",
      },
      hasKey: true,
    }),
    hasKey: async () => true,
    save: async (values) => {
      saved.push(values);
      return "saved";
    },
    check: async () => "+ Соединение работает",
    models: async () => ({
      ok: true,
      models: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }],
    }),
    ...overrides,
  };
  return { actions, saved };
}
async function frame(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
  return setup.captureCharFrame();
}
async function key(setup: Setup, name: string, ctrl = false) {
  await act(async () => {
    const encoded =
      name === "ENTER"
        ? "RETURN"
        : ["UP", "DOWN", "LEFT", "RIGHT"].includes(name)
          ? `ARROW_${name}`
          : name;
    setup.mockInput.pressKey(encoded, { ctrl });
    if (name === "ESCAPE")
      await new Promise((resolve) => setTimeout(resolve, 120));
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
  if (!node) throw new Error(`Missing ${id}`);
  await act(async () => {
    await setup.mockMouse.click(node.x + 1, node.y);
  });
  await frame(setup);
}
function destroy(setup: Setup) {
  act(() => setup.renderer.destroy());
}
async function settings(
  actions: OpenTuiSettingsActions,
  selection = 0,
  onClose = () => {},
) {
  const setup = await testRender(
    <OpenTuiSettings
      actions={actions}
      width={100}
      height={30}
      initialSelection={selection}
      onClose={onClose}
    />,
    { width: 100, height: 30 },
  );
  await frame(setup);
  return setup;
}

test("settings overlay preserves native composer, cursor and ongoing conversation", async () => {
  const { actions } = api();
  const controller = new TuiController(process.cwd());
  controller.append("Существующий разговор", "assistant");
  const setup = await testRender(
    <OpenTuiSpike
      controller={controller}
      settingsActions={actions}
      onSubmit={async () => {}}
      onExit={() => {}}
    />,
    { width: 120, height: 36 },
  );
  try {
    await frame(setup);
    await paste(setup, "первая строка\nвторая строка");
    const editor = setup.renderer.currentFocusedEditor;
    if (!editor) throw new Error("Missing composer");
    editor.cursorOffset = 5;
    await key(setup, "\u001b[44;5u");
    expect(controller.snapshot.overlay).toBe("settings");
    expect(
      setup.renderer.root.findDescendantById("settings-popup"),
    ).toBeDefined();
    expect(editor.focused).toBe(false);
    act(() => controller.append("Ответ продолжает поступать", "assistant"));
    await frame(setup);
    await key(setup, "ESCAPE");
    expect(setup.renderer.currentFocusedEditor).toBe(editor);
    expect(editor.plainText).toBe("первая строка\nвторая строка");
    expect(editor.cursorOffset).toBe(5);
    expect(setup.captureCharFrame()).toContain("Ответ продолжает поступать");
    expect(controller.snapshot.overlay).toBeUndefined();
  } finally {
    destroy(setup);
    controller.dispose();
  }
});

test("secret input masks its native buffer and edits at cursor with undo/redo", async () => {
  const { actions, saved } = api();
  const setup = await settings(actions, 2);
  try {
    await key(setup, "ENTER");
    await paste(setup, "sk-секрет123");
    const input = setup.renderer.root.findDescendantById(
      "settings-secret",
    ) as InputRenderable;
    expect(input.value).toBe("*".repeat(12));
    expect(setup.captureCharFrame()).not.toContain("sk-секрет123");
    await key(setup, "HOME");
    await key(setup, "RIGHT");
    await key(setup, "X");
    await key(setup, "BACKSPACE");
    await key(setup, "END");
    await key(setup, "Z");
    await key(setup, "z", true);
    await key(setup, "y", true);
    expect(input.value).toMatch(/^\*+$/);
    await key(setup, "ENTER");
    await key(setup, "s", true);
    expect(saved[0]?.apiKey).toBe("sk-секрет123Z");
    expect(setup.captureCharFrame()).not.toContain("sk-секрет123");
  } finally {
    destroy(setup);
  }
});

test("masked selection replacement changes only the selected secret characters", async () => {
  const { actions, saved } = api();
  const setup = await settings(actions, 2);
  try {
    await key(setup, "ENTER");
    await paste(setup, "abcdef");
    const input = setup.renderer.root.findDescendantById(
      "settings-secret",
    ) as InputRenderable;
    act(() => input.setSelection(1, 4));
    await paste(setup, "Ж");
    expect(input.value).toBe("****");
    await key(setup, "ENTER");
    await key(setup, "s", true);
    expect(saved[0]?.apiKey).toBe("aЖef");
  } finally {
    destroy(setup);
  }
});

test("URL uses native cursor editing and Escape discards a field draft", async () => {
  const { actions, saved } = api({
    load: async () => ({
      values: {
        provider: "openai-compatible",
        model: "coder",
        baseUrl: "https://api.example.com/v1",
      },
      hasKey: true,
    }),
  });
  const setup = await settings(actions, 3);
  try {
    await key(setup, "ENTER");
    await paste(setup, "discard");
    await key(setup, "ESCAPE");
    await key(setup, "ENTER");
    await key(setup, "HOME");
    for (let i = 0; i < 8; i++) await key(setup, "RIGHT");
    await paste(setup, "new.");
    await key(setup, "ENTER");
    await key(setup, "s", true);
    expect(saved[0]?.baseUrl).toBe("https://new.api.example.com/v1");
  } finally {
    destroy(setup);
  }
});

test("provider search handles 500 definitions and clears the previous unsaved key", async () => {
  const original = builtinDefinitions.find((p) => p.id === "openai");
  if (!original) throw new Error("Missing builtin");
  const definitions = Array.from({ length: 500 }, (_, i) => ({
    ...original,
    id: `scale/provider-${i}`,
    label: `Scale ${i}`,
    description: `Сервис номер ${i}`,
    defaults: { model: `coder-${i}` },
  }));
  const { actions, saved } = api({
    catalog: async () => ({
      providers: [...builtinDefinitions, ...definitions],
      profiles: {},
    }),
    hasKey: async () => false,
  });
  const setup = await settings(actions, 2);
  try {
    await key(setup, "ENTER");
    await paste(setup, "private-key");
    await key(setup, "ENTER");
    await click(setup, "settings-row-providers");
    expect(setup.captureCharFrame()).not.toContain("Scale 499");
    await paste(setup, "Сервис номер 499");
    expect(setup.captureCharFrame()).toContain("Scale 499");
    expect(setup.captureCharFrame()).not.toContain("Scale 498");
    await key(setup, "ENTER");
    await key(setup, "s", true);
    expect(saved[0]?.provider).toBe("scale/provider-499");
    expect(saved[0]?.model).toBe("coder-499");
    expect(saved[0]?.apiKey).toBeUndefined();
  } finally {
    destroy(setup);
  }
});

test("model search selects a discovered model", async () => {
  const { actions, saved } = api();
  const setup = await settings(actions, 1);
  try {
    await key(setup, "ENTER");
    await paste(setup, "sonnet");
    expect(setup.captureCharFrame()).toContain("claude-sonnet-5");
    await key(setup, "ENTER");
    await key(setup, "s", true);
    expect(saved[0]?.model).toBe("claude-sonnet-5");
  } finally {
    destroy(setup);
  }
});

for (const slow of [false, true]) {
  test(`manual model entry works when lookup ${slow ? "is still pending" : "fails"}`, async () => {
    let finish:
      | ((
          result: Awaited<ReturnType<OpenTuiSettingsActions["models"]>>,
        ) => void)
      | undefined;
    const { actions, saved } = api({
      models: slow
        ? () =>
            new Promise((resolve) => {
              finish = resolve;
            })
        : async () => ({ ok: false, error: "Нет сети" }),
    });
    const setup = await settings(actions, 1);
    try {
      await key(setup, "ENTER");
      await paste(setup, "coder-custom");
      await key(setup, "ENTER");
      expect(
        setup.renderer.root.findDescendantById("settings-field"),
      ).toBeDefined();
      await key(setup, "ENTER");
      if (finish)
        await act(async () =>
          finish?.({ ok: true, models: [{ id: "late-model" }] }),
        );
      await key(setup, "s", true);
      expect(saved[0]?.model).toBe("coder-custom");
    } finally {
      destroy(setup);
    }
  });
}

test("profile search loads the selected account", async () => {
  const { actions, saved } = api({
    catalog: async () => ({
      providers: builtinDefinitions,
      profiles: {
        work: { providerId: "anthropic", defaultModel: "work-model" },
        personal: {
          providerId: "anthropic",
          label: "Личный",
          defaultModel: "personal-model",
        },
      },
    }),
    load: async (profile) => ({
      values: {
        provider: "anthropic",
        profileId: profile ?? "work",
        model: profile === "personal" ? "personal-model" : "work-model",
      },
      hasKey: true,
    }),
  });
  const setup = await settings(actions);
  try {
    await click(setup, "settings-row-profiles");
    await paste(setup, "Личный");
    await key(setup, "ENTER");
    await key(setup, "s", true);
    expect(saved[0]?.profileId).toBe("personal");
    expect(saved[0]?.model).toBe("personal-model");
  } finally {
    destroy(setup);
  }
});

test("new profile rejects duplicates and starts with a separate key", async () => {
  const { actions, saved } = api();
  const setup = await settings(actions);
  try {
    await click(setup, "settings-row-profile-id");
    await paste(setup, "work");
    await key(setup, "ENTER");
    expect(setup.captureCharFrame()).toContain("Такой профиль уже есть");
    await key(setup, "u", true);
    await paste(setup, "second");
    await key(setup, "ENTER");
    await key(setup, "s", true);
    expect(saved[0]?.profileId).toBe("second");
    expect(saved[0]?.apiKey).toBeUndefined();
  } finally {
    destroy(setup);
  }
});

test("connection errors redact the entered key and preserve the editable draft", async () => {
  const { actions, saved } = api({
    check: async (values) => {
      throw new Error(`Ошибка ${values.apiKey?.trim()}`);
    },
  });
  const setup = await settings(actions, 2);
  try {
    await key(setup, "ENTER");
    await paste(setup, " sk-private-key ");
    await key(setup, "ENTER");
    await key(setup, "r", true);
    expect(setup.captureCharFrame()).toContain("[ключ скрыт]");
    expect(setup.captureCharFrame()).not.toContain("sk-private-key");
    await key(setup, "s", true);
    expect(saved[0]?.apiKey).toBe("sk-private-key");
  } finally {
    destroy(setup);
  }
});

test("Escape cancels a slow connection check and ignores its late result", async () => {
  let finish: ((value: string) => void) | undefined;
  let closed = 0;
  const { actions } = api({
    check: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const setup = await settings(actions, 0, () => {
    closed++;
  });
  try {
    await key(setup, "r", true);
    expect(setup.captureCharFrame()).toContain("Проверяем");
    await key(setup, "ESCAPE");
    expect(closed).toBe(1);
    await act(async () => finish?.("late result"));
    expect(await frame(setup)).not.toContain("late result");
  } finally {
    destroy(setup);
  }
});

for (const values of [
  { provider: "openai", model: "coder", baseUrl: "ftp://example.com" },
  { provider: "openai", model: "" },
]) {
  test(`invalid connection is not saved: ${values.baseUrl ?? "empty model"}`, async () => {
    const { actions, saved } = api({
      load: async () => ({ values, hasKey: true }),
    });
    const setup = await settings(actions);
    try {
      await key(setup, "s", true);
      expect(saved).toEqual([]);
      expect(setup.captureCharFrame()).toContain(
        values.baseUrl ? "http:// или https://" : "Введите",
      );
    } finally {
      destroy(setup);
    }
  });
}

test("first-run theme save does not bypass required connection setup", async () => {
  let exited = 0;
  let completed = 0;
  const { actions, saved } = api({
    load: async () => ({
      values: { provider: "anthropic", model: "claude-opus-5" },
      hasKey: false,
    }),
    save: async (values) => {
      saved.push(values);
      return values.apiKey ? "saved" : "setup_required";
    },
  });
  const setup = await testRender(
    <OpenTuiSpike
      onExit={() => {
        exited++;
      }}
      onSubmit={async () => {}}
      settingsActions={actions}
      initialSettingsOpen
      onSetupComplete={() => {
        completed++;
      }}
    />,
    { width: 60, height: 15 },
  );
  try {
    expect(await frame(setup)).not.toContain("Опишите задачу");
    await key(setup, "TAB");
    await key(setup, "DOWN");
    await key(setup, "ENTER");
    expect(completed).toBe(0);
    expect(setup.captureCharFrame()).not.toContain("Опишите задачу");
    await key(setup, "TAB");
    await key(setup, "TAB");
    await key(setup, "s", true);
    expect(completed).toBe(0);
    await key(setup, "DOWN");
    await key(setup, "DOWN");
    await key(setup, "ENTER");
    await paste(setup, "new-private-key");
    await key(setup, "ENTER");
    await key(setup, "s", true);
    expect(saved.at(-1)?.apiKey).toBe("new-private-key");
    expect(completed).toBe(1);
    expect(exited).toBe(0);
    expect(setup.captureCharFrame()).toContain("Опишите задачу");
  } finally {
    destroy(setup);
  }
});

for (const [width, height] of [
  [40, 12],
  [60, 15],
  [80, 24],
  [120, 36],
]) {
  test(`settings at ${width}×${height} keep actions visible and search through resize`, async () => {
    const { actions } = api();
    const setup = await testRender(
      <OpenTuiSpike
        onExit={() => {}}
        onSubmit={async () => {}}
        settingsActions={actions}
      />,
      { width, height },
    );
    try {
      await frame(setup);
      await paste(setup, "/settings");
      await key(setup, "ENTER");
      const popup = setup.renderer.root.findDescendantById("settings-popup");
      if (!popup) throw new Error("Missing popup");
      expect(popup.x).toBeGreaterThanOrEqual(0);
      expect(popup.y).toBeGreaterThanOrEqual(0);
      expect(popup.x + popup.width).toBeLessThanOrEqual(width);
      expect(popup.y + popup.height).toBeLessThanOrEqual(height);
      expect(setup.captureCharFrame()).toContain("Сохранить");
      await key(setup, "DOWN");
      await key(setup, "ENTER");
      await paste(setup, "sonnet");
      await act(async () => setup.resize(100, 30));
      await frame(setup);
      const input = setup.renderer.root.findDescendantById(
        "settings-search",
      ) as InputRenderable;
      expect(input.value).toBe("sonnet");
      await key(setup, "ESCAPE");
      await key(setup, "ESCAPE");
      expect(setup.captureCharFrame()).toContain("Опишите задачу");
    } finally {
      destroy(setup);
    }
  });
}

for (const theme of ["obsidian", "graphite", "ember", "paper"] as const) {
  test(`theme ${theme} previews, commits explicitly and restores the unsent draft`, async () => {
    const persisted: string[] = [];
    const setup = await testRender(
      <OpenTuiSpike
        onExit={() => {}}
        onSubmit={async () => {}}
        onThemeChange={async (value) => {
          persisted.push(value);
        }}
      />,
      { width: 100, height: 30 },
    );
    try {
      await frame(setup);
      await paste(setup, "черновик\nвторая строка");
      const editor = setup.renderer.currentFocusedEditor;
      await key(setup, "t", true);
      await click(setup, `settings-theme-${theme}`);
      expect(persisted).toEqual([]);
      await click(setup, "settings-apply-theme");
      expect(persisted).toEqual([theme]);
      expect(setup.captureCharFrame()).toContain("Тема сохранена");
      await key(setup, "ESCAPE");
      expect(setup.renderer.currentFocusedEditor).toBe(editor);
      expect(editor?.plainText).toBe("черновик\nвторая строка");
      await key(setup, "t", true);
      expect(setup.captureCharFrame()).toContain("+");
    } finally {
      destroy(setup);
    }
  });
}

test("cancelled preview and failed persistence restore the saved theme", async () => {
  const persisted: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      onExit={() => {}}
      onSubmit={async () => {}}
      initialTheme="paper"
      onThemeChange={async (theme) => {
        persisted.push(theme);
        throw new Error("Не удалось записать конфиг");
      }}
    />,
    { width: 100, height: 30 },
  );
  try {
    await frame(setup);
    await key(setup, "t", true);
    await click(setup, "settings-theme-ember");
    await key(setup, "ESCAPE");
    expect(persisted).toEqual([]);
    await key(setup, "t", true);
    expect(setup.captureCharFrame()).toContain("Paper");
    await click(setup, "settings-theme-graphite");
    await key(setup, "ENTER");
    expect(setup.captureCharFrame()).toContain("Не удалось записать конфиг");
    expect(persisted).toEqual(["graphite"]);
    await key(setup, "ESCAPE");
    await key(setup, "t", true);
    const paper = setup.renderer.root.findDescendantById(
      "settings-theme-paper",
    );
    expect(paper).toBeDefined();
    expect(setup.captureCharFrame()).toContain("> Paper");
  } finally {
    destroy(setup);
  }
});

test("built-in commands expose settings without a separate theme command", () => {
  expect(parseSlashCommand("/theme")).toBeUndefined();
  expect(matchingCommands("/the")).toEqual([]);
  expect(parseSlashCommand("/settings")?.name).toBe("/settings");
});
