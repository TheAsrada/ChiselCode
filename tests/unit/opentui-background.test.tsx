/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { BackgroundTask } from "../../src/background/contracts.js";
import { createSession } from "../../src/sessions/store.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiController } from "../../src/ui/tui-controller.js";

function countRows(node: Renderable): number {
  return (
    (node.id.startsWith("background-row-") ? 1 : 0) +
    node.getChildren().reduce((sum, child) => sum + countRows(child), 0)
  );
}

for (const theme of ["obsidian", "graphite", "ember", "paper"] as const) {
  for (const unicode of [true, false]) {
    test(`background popup bounds mounted rows and preserves identity in ${theme}/${unicode ? "unicode" : "ascii"}`, async () => {
      const controller = new TuiController(process.cwd());
      const session = createSession(
        process.cwd(),
        "openai-compatible",
        "fixture",
      );
      controller.setSessionUsage(session);
      controller.setDraft("Несохранённый черновик");
      const stamp = new Date().toISOString();
      const childId = crypto.randomUUID();
      const tasks: BackgroundTask[] = Array.from(
        { length: 256 },
        (_, index) => ({
          id: crypto.randomUUID(),
          ordinal: index + 1,
          rootOwnerId: session.id,
          sessionId: session.id,
          conversationId: controller.conversationId,
          generation: controller.currentGeneration,
          invocationId: `fixture-${index}`,
          turnId: "fixture",
          ...(index >= 128 ? { childId } : {}),
          ownerLabel:
            index < 128 ? "Основной агент" : "Помощник · проверка 日本語",
          origin: process.cwd(),
          workspace: process.cwd(),
          workspaceLabel: "Копия с длинным русским названием",
          label: `Задача ${index + 1} · длинное название 日本語`,
          commandPreview: "bun run проверка",
          replayable: true,
          kind: index % 2 ? "batch" : "service",
          foreground: false,
          state: (
            [
              "running",
              "queued",
              "awaiting_approval",
              "failed",
              "cleanup_unknown",
            ] as const
          )[index % 5]!,
          revision: 1,
          acceptedAt: stamp,
          updatedAt: stamp,
          deadline: stamp,
          readiness: "unknown",
          tail: ["Последняя строка настоящего текстового представления"],
          outputBytes: 64,
          outputLines: 1,
          outputLimit: 16 * 1024 * 1024,
          outputGeneration: crypto.randomUUID(),
          truncated: false,
          cleanup: {
            confirmed: index % 5 !== 4,
            ...(index % 5 === 4 ? { recoveryRequired: true } : {}),
          },
          resources: [],
        }),
      );
      for (const task of tasks)
        controller.acceptBackground({
          type: "accepted",
          ownerId: session.id,
          task,
        });
      controller.showBackground();
      let cancellations = 0;
      let setup!: Awaited<ReturnType<typeof testRender>>;
      await act(async () => {
        setup = await testRender(
          <OpenTuiSpike
            controller={controller}
            initialTheme={theme}
            initialUnicodeDecorations={unicode}
            onExit={() => {}}
            onSubmit={async () => {}}
            onCancel={() => cancellations++}
          />,
          { width: 160, height: 50, exitOnCtrlC: false },
        );
      });
      const frame = async () => {
        await act(async () => {
          await setup.renderOnce();
          await setup.renderOnce();
        });
      };
      const press = async (name: string, ctrl = false) => {
        await act(async () => {
          setup.mockInput.pressKey(name, { ctrl });
          if (name === "ESCAPE") await Bun.sleep(120);
        });
        await frame();
      };
      try {
        await frame();
        expect(countRows(setup.renderer.root)).toBeLessThanOrEqual(64);
        for (const [index, text] of [
          "Работает",
          "В очереди",
          "Нужно разрешение",
          "Ошибка",
          "Завершение не подтверждено",
        ].entries()) {
          await act(async () =>
            controller.setBackgroundList({ selected: tasks[index]!.id }),
          );
          await frame();
          expect(setup.captureCharFrame()).toContain(text);
        }
        const folder = process.env.CHISEL_BACKGROUND_STATE_CAPTURES;
        for (const [width, height] of [
          [160, 50],
          [120, 40],
          [80, 24],
          [40, 12],
          [24, 8],
        ]) {
          await act(async () => setup.renderer.resize(width!, height!));
          await frame();
          for (const id of [
            "background-action-0",
            "background-action-1",
            "background-action-2",
          ])
            expect(setup.renderer.root.findDescendantById(id)).toBeDefined();
          if (folder) {
            await mkdir(folder, { recursive: true });
            const base = join(
              folder,
              `${theme}-${unicode ? "unicode" : "ascii"}-${width}x${height}-state-projection`,
            );
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
          }
        }
        await press("END");
        expect(controller.snapshot.backgroundList?.selected).toBe(
          tasks.at(-1)!.id,
        );
        expect(
          setup.renderer.root.findDescendantById(
            `background-row-${tasks.at(-1)!.id}`,
          ),
        ).toBeDefined();
        await act(async () => setup.renderer.resize(120, 40));
        await frame();
        expect(setup.captureCharFrame()).toContain("Задача 256");
        expect(countRows(setup.renderer.root)).toBeLessThanOrEqual(64);
        const neighbor = tasks[3]!;
        await act(async () =>
          controller.acceptBackground({
            type: "terminal",
            ownerId: session.id,
            task: { ...neighbor, revision: 2, state: "completed", exitCode: 0 },
          }),
        );
        await frame();
        expect(controller.snapshot.backgroundList?.selected).toBe(
          tasks.at(-1)!.id,
        );
        await press("c", true);
        expect(cancellations).toBe(0);
        if (theme === "obsidian" && unicode) {
          const listeners = setup.renderer.listenerCount("resize");
          const keys = setup.renderer.keyInput.listenerCount("keypress");
          expect(keys).toBeLessThanOrEqual(6);
          for (let cycle = 0; cycle < 12; cycle++) {
            await act(async () => controller.hideBackgroundPanel());
            await frame();
            await act(async () => controller.showBackground());
            await frame();
          }
          expect(setup.renderer.listenerCount("resize")).toBe(listeners);
          expect(setup.renderer.keyInput.listenerCount("keypress")).toBe(keys);
        }
        await press("ESCAPE");
        expect(controller.snapshot.backgroundPanel).toBe(false);
        expect(controller.snapshot.draft).toBe("Несохранённый черновик");
      } finally {
        setup.renderer.destroy();
        controller.dispose();
      }
    });
  }
}
