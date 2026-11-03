/** @jsxImportSource @opentui/react */
import "../../src/ui/opentui-spike.js";
// Настоящие native spans; только изолированные демонстрационные данные.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { builtinDefinitions } from "../../src/providers/definitions/index.js";
import { OpenTuiModels } from "../../src/ui/opentui-models.js";
import { OpenTuiSessions } from "../../src/ui/opentui-sessions.js";
import { OpenTuiSettings } from "../../src/ui/opentui-settings.js";
import { OpenTuiSkills } from "../../src/ui/opentui-skills.js";
import { focusMenuAction, uiKey } from "./menu-navigation.js";

const destination = resolve(process.argv[2] ?? "docs/assets/menu-keybindings");
const prefix = process.argv[3] ?? "after";
await mkdir(destination, { recursive: true });
const current = {
  provider: "openai" as const,
  profileId: "work",
  model: "gpt-5",
};
for (const [width, height] of [
  [120, 40],
  [80, 24],
  [60, 15],
  [32, 10],
] as const) {
  for (const name of ["models", "skills", "sessions", "settings"]) {
    const node =
      name === "models" ? (
        <OpenTuiModels
          width={width}
          height={height}
          onClose={() => {}}
          onSettings={() => {}}
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
            models: async () => ({
              ok: true,
              models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
            }),
            select: async () => {},
          }}
        />
      ) : name === "skills" ? (
        <OpenTuiSkills
          width={width}
          height={height}
          onClose={() => {}}
          onChoose={() => {}}
          onCreate={() => {}}
          actions={{
            load: () =>
              ["code-review", "skill-creator"].map((name) => ({
                name,
                description: "Проверка кода и подготовка изменений",
                instructions: "Изучите проект.\nЗапустите подходящие проверки.",
                source: "user",
                dir: "/demo/skills",
              })),
            activeNames: () => [],
            toggle: () => {},
          }}
        />
      ) : name === "sessions" ? (
        <OpenTuiSessions
          width={width}
          height={height}
          onClose={() => {}}
          actions={{
            load: async () => [
              {
                id: "demo",
                title: "Навигация по меню",
                createdAt: "2026-11-03T09:00:00Z",
                updatedAt: "2026-11-03T09:00:00Z",
                messageCount: 4,
                provider: "openai",
                model: "gpt-5",
                projectName: "ChiselCode",
                projectPath: "/demo/ChiselCode",
              },
            ],
            preview: async () => {
              throw new Error("Демонстрационный разговор");
            },
            resume: async () => {},
            rename: async () => {},
            delete: async () => {},
            activeId: () => undefined,
          }}
        />
      ) : (
        <OpenTuiSettings
          width={width}
          height={height}
          onClose={() => {}}
          actions={{
            catalog: async () => ({
              providers: builtinDefinitions,
              profiles: {
                work: { providerId: "openai", defaultModel: "gpt-5" },
              },
            }),
            load: async () => ({ values: current, hasKey: true }),
            hasKey: async () => true,
            save: async () => "saved",
            check: async () => "Подключение работает",
            models: async () => ({ ok: true, models: [{ id: "gpt-5" }] }),
          }}
        />
      );
    let setup!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => {
      setup = await testRender(node, { width, height });
    });
    try {
      await act(async () => {
        await setup.renderOnce();
        await setup.renderOnce();
      });
      if (name === "settings" && width < 100) await uiKey(setup, "RETURN");
      if (prefix === "after") {
        const rail = {
          models: ["models-actions", "models-refresh"],
          skills: ["skills-actions", "skills-instructions-action"],
          sessions: ["resume-actions", "resume-preview"],
          settings: ["settings-actions", "settings-save"],
        }[name];
        if (rail) await focusMenuAction(setup, rail[0] ?? "", rail[1] ?? "");
      }
      const base = resolve(destination, `${prefix}-${name}-${width}x${height}`);
      await writeFile(`${base}.txt`, setup.captureCharFrame());
      const spans = setup.captureSpans();
      await writeFile(
        `${base}.json`,
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
    } finally {
      act(() => setup.renderer.destroy());
    }
  }
}
