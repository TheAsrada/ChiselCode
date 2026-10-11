/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { subagentChatCard } from "../../src/extensions/builtins/subagent-presentation.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { childFixture } from "../helpers/subagent.js";

for (const [index, theme] of (
  ["obsidian", "paper", "graphite", "ember"] as const
).entries())
  test(`extension chat cards update, open the addressed task and fit narrow windows in ${theme}`, async () => {
    const controller = new TuiController(process.cwd());
    const child = childFixture();
    controller.setSessionId(child.rootOwnerId);
    controller.append("Проверь навигацию и обработку ошибок.", "user");
    controller.setDraft("Не потерять черновик");
    const event = (status: typeof child.status, revision: number) => {
      const value = {
        ...child,
        status,
        revision,
        label: "Проверить навигацию",
        step:
          status === "awaiting_approval"
            ? "Ожидает разрешения на проверку"
            : "Читает src/runtime.ts",
      };
      controller.acceptSubagent({
        type: revision === 1 ? "accepted" : "changed",
        ownerId: child.rootOwnerId,
        child: value,
        presentation: {
          extensionId: child.extensionId,
          view: { cards: [subagentChatCard(value)] },
        },
      });
    };
    event("running", 1);
    controller.upsertCard("vendor/report", {
      id: "report",
      revision: 1,
      title: "Проверка расширения",
      subtitle: "Анализ проекта",
      description: "Проверены все доступные файлы",
      status: { label: "Готово", tone: "success" },
      detail: "Ошибок не найдено",
    });
    controller.setAgentSidebar("context");
    controller.setSubagentControls({
      port: {
        list: async () => [child],
        status: async () => child,
        result: async () => child,
        wait: async () => [child],
        cancel: async () => child,
      },
      busy: () => true,
      cancel: async () => {},
      close: async () => {},
      wait: async () => {},
      inspect: async () => ({ text: "Сохранённая история проверки" }),
    });
    let setup!: Awaited<ReturnType<typeof testRender>>;
    await act(async () => {
      setup = await testRender(
        <OpenTuiSpike
          controller={controller}
          initialTheme={theme}
          initialUnicodeDecorations={index % 2 === 1}
        />,
        { width: 160, height: 46 },
      );
    });
    const frame = () =>
      act(async () => {
        await setup.renderOnce();
        await setup.renderOnce();
      });
    try {
      await frame();
      const identity = JSON.stringify([child.extensionId, child.id]);
      const card = setup.renderer.root.findDescendantById(
        `chat-card-${identity}`,
      );
      expect(card).toBeDefined();
      expect(setup.captureCharFrame()).toContain("Проверить навигацию");
      expect(setup.captureCharFrame()).toContain("Проверка расширения");
      const listeners = setup.renderer.listenerCount("resize");
      await act(async () => {
        controller.appendToLast("Продолжаю основной ответ.");
        event("awaiting_approval", 3);
        event("running", 2);
      });
      await frame();
      expect(
        controller.snapshot.transcript.filter(
          (entry) => entry.chatCard?.card.id === child.id,
        ),
      ).toHaveLength(1);
      expect(controller.snapshot.streaming).toBe("Продолжаю основной ответ.");
      expect(setup.captureCharFrame()).toContain("Нужно разрешение");
      expect(setup.captureCharFrame()).not.toContain("[extension]");
      const folder = process.env.CHISEL_CAPTURE_DIR;
      if (folder) {
        await mkdir(folder, { recursive: true });
        await writeFile(
          join(folder, `chat-card-${theme}.txt`),
          setup.captureCharFrame(),
        );
        const spans = setup.captureSpans();
        await writeFile(
          join(folder, `chat-card-${theme}.json`),
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
      const open = setup.renderer.root.findDescendantById(
        `chat-card-open-${identity}`,
      );
      expect(open).toBeDefined();
      if (!open) throw new Error("Нет кнопки карточки");
      await act(async () => {
        await setup.mockMouse.click(open.x + 1, open.y);
      });
      await frame();
      expect(controller.snapshot.agentView?.id).toBe(child.id);
      expect(setup.captureCharFrame()).toContain(
        "Сохранённая история проверки",
      );
      await act(async () => {
        setup.mockInput.pressKey("ESCAPE");
        await Bun.sleep(120);
      });
      await frame();
      expect(controller.snapshot.focus).toBe("composer");
      expect(controller.snapshot.draft).toBe("Не потерять черновик");
      for (const width of [80, 40, 24]) {
        await act(async () => setup.renderer.resize(width, 20));
        await frame();
        const resized = setup.renderer.root.findDescendantById(
          `chat-card-${identity}`,
        );
        expect(resized?.width).toBeLessThanOrEqual(width);
        expect(setup.renderer.listenerCount("resize")).toBe(listeners);
        expect(controller.snapshot.draft).toBe("Не потерять черновик");
      }
    } finally {
      act(() => setup.renderer.destroy());
      controller.dispose();
    }
  });
