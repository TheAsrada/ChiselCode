/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { captureConversation } from "../../src/models/context.js";
import type { SideQueryRecord } from "../../src/models/contracts.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiController } from "../../src/ui/tui-controller.js";

function record(controller: TuiController): SideQueryRecord {
  const now = new Date().toISOString();
  return {
    operationId: randomUUID(),
    owner: {
      extensionId: "builtin.btw",
      sessionId: randomUUID(),
      conversationId: controller.conversationId,
      workspaceRoot: process.cwd(),
      generation: controller.currentGeneration,
    },
    status: "receiving",
    text: `${"Побочный ответ: основной агент продолжает задачу.\n\n".repeat(12)}\n\`\`\`ts\nconst answer = 42;\n`,
    question:
      "Почему побочный вопрос не меняет основной контекст разговора? Объясни на примере текущей задачи и очереди запросов.",
    command: "btw",
    providerId: "openai",
    profileId: "fixture",
    model: "captured-model-with-a-long-identifier",
    acceptedAt: now,
    updatedAt: now,
    afterMessage: 0,
    revision: 1,
    context: captureConversation().provenance,
    usageSource: "unknown",
    cost: { source: "unknown" },
    knownCost: 0,
    attempts: 1,
  };
}
type Setup = Awaited<ReturnType<typeof testRender>>;
async function frames(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
}
async function key(
  setup: Setup,
  name: string,
  options: { ctrl?: boolean; shift?: boolean } = {},
) {
  await act(async () => {
    setup.mockInput.pressKey(name, options);
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frames(setup);
}
async function capture(setup: Setup, name: string) {
  const folder = process.env.CHISEL_CAPTURE_DIR;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  const spans = setup.captureSpans();
  await writeFile(join(folder, `${name}.txt`), setup.captureCharFrame());
  await writeFile(
    join(folder, `${name}.json`),
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

for (const theme of ["obsidian", "paper"] as const)
  for (const unicode of [false, true]) {
    test(`side view focus/resize/draft/actions stay isolated in ${theme}/${unicode ? "Unicode" : "ASCII"}`, async () => {
      const controller = new TuiController(process.cwd());
      controller.setDraft("Основной черновик");
      controller.append("Основная задача продолжает выполняться", "assistant");
      let stopped = 0,
        foregroundCancelled = 0,
        submitted = 0;
      const current = record(controller);
      controller.receiveSide(current);
      controller.openSide(current.operationId);
      const setup = await testRender(
        <OpenTuiSpike
          controller={controller}
          onExit={() => {}}
          onCancel={() => {
            foregroundCancelled++;
          }}
          onSideCancel={() => {
            stopped++;
          }}
          onSubmit={async () => {
            submitted++;
          }}
          initialTheme={theme}
          initialUnicodeDecorations={unicode}
        />,
        { width: 120, height: 40, exitOnCtrlC: false },
      );
      try {
        await frames(setup);
        const mode = controller.snapshot.agentMode;
        for (const [width, height] of [
          [120, 40],
          [100, 30],
          [80, 24],
          [60, 20],
          [40, 12],
          [24, 8],
        ]) {
          await act(async () => {
            setup.renderer.resize(width ?? 120, height ?? 40);
          });
          await frames(setup);
          const popup =
            setup.renderer.root.findDescendantById("side-query-popup");
          expect(popup).toBeDefined();
          if (popup) {
            expect(popup.x).toBeGreaterThanOrEqual(0);
            expect(popup.y).toBeGreaterThanOrEqual(0);
            expect(popup.x + popup.width).toBeLessThanOrEqual(width ?? 120);
            expect(popup.y + popup.height).toBeLessThanOrEqual(height ?? 40);
          }
          expect(
            setup.renderer.root.findDescendantById("side-query-body")?.height,
          ).toBeGreaterThan(0);
          await capture(
            setup,
            `${theme}-${unicode ? "unicode" : "ascii"}-receiving-${width}x${height}`,
          );
        }
        await key(setup, "TAB", { shift: true });
        expect(controller.snapshot.agentMode).toBe(mode);
        await key(setup, "c", { ctrl: true });
        expect(foregroundCancelled).toBe(1);
        expect(stopped).toBe(0);
        await key(setup, "ESCAPE");
        expect(controller.snapshot.sideView?.visible).toBe(false);
        await capture(
          setup,
          `${theme}-${unicode ? "unicode" : "ascii"}-hidden-24x8`,
        );
        await key(setup, "F6");
        expect(controller.snapshot.sideView?.visible).toBe(true);
        expect(submitted).toBe(0);
        await act(async () => {
          setup.renderer.resize(120, 40);
          controller.newSideQuestion();
        });
        await frames(setup);
        await act(async () => {
          await setup.mockInput.pasteBracketedText(
            "Отдельный черновик\nс несколькими строками",
          );
        });
        await frames(setup);
        expect(controller.snapshot.sideView?.draft).toContain(
          "Отдельный черновик",
        );
        expect(controller.snapshot.draft).toBe("Основной черновик");
        expect(submitted).toBe(0);
        await capture(
          setup,
          `${theme}-${unicode ? "unicode" : "ascii"}-draft-120x40`,
        );
        await key(setup, "ESCAPE");
        await key(setup, "F6");
        expect(controller.snapshot.sideView?.draft).toContain(
          "с несколькими строками",
        );
        await act(async () => {
          controller.readSideAnswer();
          controller.receiveSide({
            ...current,
            status: "failed",
            error: {
              code: "transport",
              message: "Сбой провайдера; сохранён неполный ответ.",
            },
            revision: 2,
          });
        });
        await frames(setup);
        await capture(
          setup,
          `${theme}-${unicode ? "unicode" : "ascii"}-error-partial-120x40`,
        );
        await key(setup, "HOME");
        await act(async () => {
          controller.receiveSide({
            ...current,
            text: `${current.text}\nНовый текст`,
            revision: 3,
          });
        });
        await frames(setup);
        // A terminal failed record cannot be resurrected by a late active delta.
        expect(controller.snapshot.sideQueries?.[0]?.status).toBe("failed");
        await act(async () => {
          controller.receiveSide({
            ...current,
            status: "completed",
            text: `${current.text}\`\`\`\nГотово.`,
            revision: 4,
          });
        });
        await frames(setup);
        await capture(
          setup,
          `${theme}-${unicode ? "unicode" : "ascii"}-completed-120x40`,
        );
        await key(setup, "TAB");
        await capture(
          setup,
          `${theme}-${unicode ? "unicode" : "ascii"}-focused-action-120x40`,
        );
        await key(setup, "ESCAPE");
        expect(controller.snapshot.draft).toBe("Основной черновик");
        await key(setup, "F6");
        expect(submitted).toBe(0);
      } finally {
        setup.renderer.destroy();
        controller.dispose();
      }
    });
  }
