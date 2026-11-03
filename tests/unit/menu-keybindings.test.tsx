/** @jsxImportSource @opentui/react */
import "../../src/ui/opentui-spike.js";
import { expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";
import { createSession } from "../../src/sessions/store.js";
import { OpenTuiModels } from "../../src/ui/opentui-models.js";
import { OpenTuiSessions } from "../../src/ui/opentui-sessions.js";
import { OpenTuiSettings } from "../../src/ui/opentui-settings.js";
import { OpenTuiSkills } from "../../src/ui/opentui-skills.js";
import {
  focusMenuAction,
  menuAction,
  settingsRoute,
  uiKey,
} from "../fixtures/menu-navigation.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
async function draw(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
}
async function mount(node: ReactNode, width: number, height: number) {
  let setup!: Setup;
  await act(async () => {
    setup = await testRender(node, { width, height });
  });
  await draw(setup);
  return setup;
}
async function wait(setup: Setup, ready: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(setup.captureCharFrame());
    await act(async () => {
      await Bun.sleep(5);
    });
    await draw(setup);
  }
}
async function removedKeys(setup: Setup, keys: string[]) {
  for (const name of keys) {
    await act(async () => setup.mockInput.pressKey(name, { ctrl: true }));
    await draw(setup);
  }
}

for (const [width, height] of [
  [120, 40],
  [80, 24],
  [60, 15],
  [32, 10],
] as const) {
  test(`Settings checks and saves only through its current form at ${width}x${height}`, async () => {
    let checked = 0,
      saved = 0;
    const setup = await mount(
      <OpenTuiSettings
        width={width}
        height={height}
        onClose={() => {}}
        actions={{
          load: async () => ({
            values: { provider: "openai", model: "demo" },
            hasKey: true,
          }),
          hasKey: async () => true,
          models: async () => ({ ok: true, models: [] }),
          check: async () => {
            checked++;
            return "Подключение проверено";
          },
          save: async () => {
            saved++;
            return "saved";
          },
        }}
      />,
      width,
      height,
    );
    try {
      await settingsRoute(setup, "Подключение");
      await removedKeys(setup, ["r", "t"]);
      await uiKey(setup, "F2");
      expect([checked, saved]).toEqual([0, 0]);
      expect(
        setup.renderer.root.findDescendantById("settings-motion"),
      ).toBeFalsy();
      await menuAction(setup, "settings-actions", "settings-check");
      await menuAction(setup, "settings-actions", "settings-save");
      expect([checked, saved]).toEqual([1, 1]);
      const rail = setup.renderer.root.findDescendantById("settings-actions");
      expect((rail?.y ?? height) + (rail?.height ?? 1)).toBeLessThanOrEqual(
        height,
      );
      await settingsRoute(setup, "Внешний вид");
      await focusMenuAction(
        setup,
        "settings-actions",
        "settings-motion-action",
      );
      expect(setup.captureCharFrame()).toContain("Анимации");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
  test(`model actions remain keyboard accessible at ${width}x${height} during a pending catalog`, async () => {
    let refreshes = 0,
      settings = 0;
    const selected: string[] = [];
    const current = { provider: "openai", model: "model-current" };
    const setup = await mount(
      <OpenTuiModels
        width={width}
        height={height}
        onClose={() => {}}
        onSettings={() => settings++}
        actions={{
          load: async () => ({
            current,
            profiles: [
              {
                key: "work",
                label: "Работа",
                providerLabel: "OpenAI",
                selection: current,
              },
            ],
          }),
          models: (_selection, refresh) => {
            if (refresh) refreshes++;
            return new Promise(() => {});
          },
          select: async (value) => {
            selected.push(value.model);
          },
        }}
      />,
      width,
      height,
    );
    try {
      await removedKeys(setup, ["n", "r"]);
      expect(refreshes).toBe(0);
      expect(
        setup.renderer.root.findDescendantById("models-manual"),
      ).toBeFalsy();
      await menuAction(setup, "models-actions", "models-refresh");
      expect(refreshes).toBe(1);
      await menuAction(setup, "models-actions", "models-settings");
      expect(settings).toBe(1);
      await menuAction(setup, "models-actions", "models-manual-action");
      expect(setup.renderer.currentFocusedEditor?.id).toBe("models-manual");
      await act(async () => {
        setup.renderer.currentFocusedEditor?.setText("");
        await setup.mockInput.pasteBracketedText("русский ID [123] с пробелом");
      });
      await draw(setup);
      await uiKey(setup, "RETURN");
      expect(selected).toEqual(["русский ID [123] с пробелом"]);
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test(`skill actions, instructions and pinning work without local shortcuts at ${width}x${height}`, async () => {
    let created = 0,
      edited = 0,
      chosen = 0,
      reads = 0;
    const active = new Set<string>();
    const setup = await mount(
      <OpenTuiSkills
        width={width}
        height={height}
        onClose={() => {}}
        onChoose={() => chosen++}
        onCreate={() => created++}
        onEdit={() => edited++}
        actions={{
          load: () => {
            reads++;
            return [
              {
                name: "skill-creator",
                description: "Создание навыков",
                instructions: Array.from(
                  { length: 60 },
                  (_, i) => `Инструкция ${i}`,
                ).join("\n"),
                source: "user",
                dir: "/demo",
              },
            ];
          },
          activeNames: () => [...active],
          toggle: (name) => {
            if (active.has(name)) active.delete(name);
            else active.add(name);
          },
        }}
      />,
      width,
      height,
    );
    try {
      await removedKeys(setup, ["o", "n", "e", "r"]);
      expect([created, edited, chosen, reads]).toEqual([0, 0, 0, 1]);
      await uiKey(setup, "TAB", true);
      await uiKey(setup, "ARROW_RIGHT");
      await uiKey(setup, "TAB");
      await menuAction(setup, "skills-actions", "skills-choose");
      expect([...active]).toEqual(["skill-creator"]);
      await menuAction(setup, "skills-actions", "skills-create");
      await menuAction(setup, "skills-actions", "skills-edit");
      await menuAction(setup, "skills-actions", "skills-refresh");
      expect([created, edited, chosen, reads]).toEqual([1, 1, 0, 2]);
      await menuAction(setup, "skills-actions", "skills-instructions-action");
      const before = setup.captureCharFrame();
      await uiKey(setup, "PAGEDOWN");
      expect(setup.captureCharFrame()).not.toBe(before);
      expect(setup.renderer.currentFocusedEditor).toBeNull();
      const row = setup.renderer.root.findDescendantById("skills-actions");
      expect((row?.y ?? height) + (row?.height ?? 1)).toBeLessThanOrEqual(
        height,
      );
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test(`history preview, rename and confirmed deletion remain accessible at ${width}x${height}`, async () => {
    const session = createSession(process.cwd(), "openai", "demo");
    session.messages.push({
      role: "user",
      content: [{ type: "text", text: "Полный разговор" }],
    });
    let title = "Разговор",
      deleted = 0,
      resumed = 0;
    const setup = await mount(
      <OpenTuiSessions
        width={width}
        height={height}
        onClose={() => {}}
        actions={{
          load: async () =>
            deleted
              ? []
              : [
                  {
                    id: session.id,
                    title,
                    createdAt: session.createdAt,
                    updatedAt: session.updatedAt,
                    messageCount: 1,
                    provider: "openai",
                    model: "demo",
                  },
                ],
          preview: async () => session,
          resume: async () => {
            resumed++;
          },
          rename: async (_id, value) => {
            title = value;
          },
          delete: async () => {
            deleted++;
          },
          activeId: () => undefined,
        }}
      />,
      width,
      height,
    );
    try {
      await removedKeys(setup, ["p", "r", "d"]);
      await uiKey(setup, "F3");
      expect([deleted, resumed]).toEqual([0, 0]);
      expect(
        setup.renderer.root.findDescendantById("readonly-history"),
      ).toBeFalsy();
      await menuAction(setup, "resume-actions", "resume-preview");
      expect(setup.captureCharFrame()).toContain("Полный разговор");
      await uiKey(setup, "ESCAPE");
      await wait(
        setup,
        () => !setup.renderer.root.findDescendantById("readonly-history"),
      );
      await menuAction(setup, "resume-actions", "resume-rename");
      await act(async () => {
        setup.renderer.currentFocusedEditor?.setText("Новое название");
      });
      await draw(setup);
      await uiKey(setup, "RETURN");
      expect(title).toBe("Новое название");
      await menuAction(setup, "resume-actions", "resume-delete");
      expect(deleted).toBe(0);
      await uiKey(setup, "ESCAPE");
      await wait(
        setup,
        () => !setup.captureCharFrame().includes("y — удалить"),
      );
      await menuAction(setup, "resume-actions", "resume-delete");
      await uiKey(setup, "y");
      expect(deleted).toBe(1);
      expect(resumed).toBe(0);
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
}

test("a held action key cannot execute again after resize or a changed action selection", async () => {
  let count = 0;
  const current = { provider: "openai", model: "model" };
  const setup = await mount(
    <OpenTuiModels
      width={80}
      height={24}
      onClose={() => {}}
      onSettings={() => count++}
      actions={{
        load: async () => ({ current, profiles: [] }),
        models: async () => ({ ok: true, models: [] }),
        select: async () => {},
      }}
    />,
    80,
    24,
  );
  try {
    await focusMenuAction(setup, "models-actions", "models-settings");
    await uiKey(setup, "space");
    expect(count).toBe(1);
    await act(async () => {
      setup.resize(32, 10);
      setup.renderer.keyInput.emit(
        "keypress",
        new KeyEvent({
          name: "return",
          sequence: "\r",
          raw: "\r",
          ctrl: false,
          meta: false,
          shift: false,
          option: false,
          number: false,
          eventType: "press",
          source: "kitty",
          repeated: true,
        }),
      );
    });
    await draw(setup);
    expect(count).toBe(1);
  } finally {
    act(() => setup.renderer.destroy());
  }
});
