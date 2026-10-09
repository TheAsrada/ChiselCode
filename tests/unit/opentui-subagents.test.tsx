/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { subagentDescriptor } from "../../src/subagents/service.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { childFixture } from "../helpers/subagent.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
async function frame(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
}
async function key(setup: Setup, name: string, ctrl = false) {
  await act(async () => {
    setup.mockInput.pressKey(name, { ctrl });
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame(setup);
}
async function capture(setup: Setup, name: string) {
  const folder = process.env.CHISEL_CAPTURE_DIR;
  if (!folder) return;
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.txt`), setup.captureCharFrame());
  const spans = setup.captureSpans();
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
for (const theme of ["obsidian", "paper", "graphite", "ember"] as const)
  for (const unicode of [false, true])
    test(`agent tree/details keyboard, cancellation and resize preserve main owner in ${theme}/${unicode}`, async () => {
      const controller = new TuiController(process.cwd());
      controller.setDraft("Не терять основной черновик");
      const child = childFixture();
      controller.setSessionId(child.rootOwnerId);
      child.parentConversationId = controller.conversationId;
      const sibling = {
        ...child,
        id: crypto.randomUUID(),
        ordinal: 2,
        label: "Другая задача — длинное русское название",
        status: "awaiting_approval" as const,
        step: "Нужно разрешение на изменение",
      };
      controller.acceptSubagent({
        type: "accepted",
        ownerId: child.rootOwnerId,
        child: subagentDescriptor(child),
      });
      controller.acceptSubagent({
        type: "accepted",
        ownerId: child.rootOwnerId,
        child: subagentDescriptor(sibling),
      });
      for (const [offset, status] of [
        "queued",
        "failed",
        "interrupted",
      ].entries()) {
        controller.acceptSubagent({
          type: "accepted",
          ownerId: child.rootOwnerId,
          child: subagentDescriptor({
            ...child,
            id: crypto.randomUUID(),
            ordinal: offset + 3,
            label:
              offset === 0
                ? "Следующая проверка"
                : offset === 1
                  ? "Проверка с частичной ошибкой"
                  : "Прерванный анализ",
            status: status as typeof child.status,
            step:
              offset === 0
                ? "Ожидает свободное место"
                : "Частичный результат сохранён",
            cleanup: {
              quiescent: offset !== 0,
              recoveryRequired: offset === 2,
            },
            text:
              "Длинный русский ответ. " + "Широкие символы: 界. ".repeat(24),
          }),
        });
      }
      controller.setAgentSidebar("agents");
      const stopped: string[] = [];
      let mainCancel = 0;
      controller.setSubagentControls({
        port: {
          list: async () => [child, sibling],
          status: async (id) => (id === child.id ? child : sibling),
          result: async () => child,
          wait: async () => [child, sibling],
          cancel: async (id) => {
            stopped.push(id);
            return child;
          },
        },
        busy: () => true,
        cancel: async () => {},
        close: async () => {},
        wait: async () => {},
        inspect: async () => ({ text: "Штатная история: read_file выполнен" }),
      });
      const setup = await testRender(
        <OpenTuiSpike
          controller={controller}
          initialTheme={theme}
          initialUnicodeDecorations={unicode}
          onCancel={() => mainCancel++}
        />,
        { width: 160, height: 50, exitOnCtrlC: false },
      );
      try {
        await frame(setup);
        controller.appendToLast("Основной поток");
        controller.acceptSubagent({
          type: "changed",
          ownerId: child.rootOwnerId,
          child: { ...child, revision: 2, text: child.text + " Новый текст" },
        });
        expect(controller.snapshot.streaming).toBe("Основной поток");
        await key(setup, "F7");
        await key(setup, "ARROW_DOWN");
        expect(controller.snapshot.agentTree?.selected).toBe(child.id);
        await capture(setup, `${theme}-${unicode}-160x50-tree`);
        await key(setup, "c", true);
        expect(mainCancel).toBe(0);
        expect(stopped).toEqual([]);
        await key(setup, "RETURN");
        expect(controller.snapshot.agentView?.id).toBe(child.id);
        await capture(setup, `${theme}-${unicode}-160x50-details`);
        await key(setup, "s");
        expect(stopped).toEqual([child.id]);
        for (const [width, height] of [
          [120, 40],
          [80, 24],
          [40, 12],
          [24, 8],
        ]) {
          await act(async () => {
            setup.renderer.resize(width!, height!);
          });
          await frame(setup);
          expect(controller.snapshot.agentView?.id).toBe(child.id);
          expect(controller.snapshot.draft).toBe("Не терять основной черновик");
          const footer = setup.renderer.root.findDescendantById(
            "agent-details-surface",
          );
          if (footer)
            expect(footer.y + footer.height).toBeLessThanOrEqual(height!);
          await capture(
            setup,
            `${theme}-${unicode}-${width}x${height}-details`,
          );
        }
        await key(setup, "ESCAPE");
        expect(controller.snapshot.agentView?.visible).toBe(false);
        expect(stopped).toEqual([child.id]);
        await capture(setup, `${theme}-${unicode}-24x8-tree`);
        await act(async () => setup.renderer.resize(120, 40));
        await frame(setup);
        await key(setup, "F7");
        const chevron =
          setup.renderer.root.findDescendantById("agents-collapse");
        if (!chevron) throw new Error("Missing root chevron");
        await act(async () => {
          await setup.mockMouse.click(chevron.x, chevron.y);
        });
        await frame(setup);
        expect(controller.snapshot.agentTree?.collapsed).toBe(true);
        expect(controller.snapshot.agentTree?.selected).toBeUndefined();
        await key(setup, "ARROW_RIGHT");
        await key(setup, "END");
        expect(controller.snapshot.agentTree?.selected).not.toBe(child.id);
        await capture(setup, `${theme}-${unicode}-120x40-recovery-tree`);
        await key(setup, "RETURN");
        await capture(setup, `${theme}-${unicode}-120x40-interrupted-details`);
        expect(controller.snapshot.draft).toBe("Не терять основной черновик");
      } finally {
        await act(async () => setup.renderer.destroy());
        controller.dispose();
      }
    }, 20000);

test("addressed approval Stop cancels its child while main and sibling remain untouched", async () => {
  const { createTuiApprovalResolver } = await import(
    "../../src/ui/tui-contract.js"
  );
  const resolver = createTuiApprovalResolver();
  const controller = new TuiController(process.cwd());
  const child = childFixture();
  controller.setSessionId(child.rootOwnerId);
  controller.setDraft("Основной черновик");
  const stopped: string[] = [];
  let mainCancel = 0;
  const abort = new AbortController();
  controller.setSubagentControls({
    port: {
      list: async () => [child],
      status: async () => child,
      result: async () => child,
      wait: async () => [child],
      cancel: async (id) => {
        stopped.push(id);
        abort.abort();
        return child;
      },
    },
    busy: () => true,
    cancel: async () => {},
    close: async () => {},
    wait: async () => {},
    inspect: async () => ({ text: "" }),
  });
  const setup = await testRender(
    <OpenTuiSpike
      controller={controller}
      approvalResolver={resolver}
      onCancel={() => mainCancel++}
    />,
    { width: 24, height: 8, exitOnCtrlC: false },
  );
  try {
    let decision!: Promise<unknown>;
    await act(async () => {
      decision = resolver.requestApproval(
        {
          tool: "edit_file",
          preview: "same.txt: base → result",
          owner: {
            rootOwnerId: child.rootOwnerId,
            childId: child.id,
            sessionId: crypto.randomUUID(),
            invocationId: crypto.randomUUID(),
            generation: 0,
            label: "Проверка",
            mode: "coding",
            cwd: process.cwd(),
          },
        },
        abort.signal,
      );
    });
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("S Стоп");
    await capture(setup, "obsidian-24x8-child-approval-stop");
    await key(setup, "c", true);
    expect(mainCancel).toBe(0);
    expect(stopped).toEqual([]);
    await key(setup, "s");
    await decision;
    expect(stopped).toEqual([child.id]);
    expect(mainCancel).toBe(0);
    expect(controller.snapshot.draft).toBe("Основной черновик");
    expect(
      setup.renderer.root.findDescendantById("approval-popup"),
    ).toBeUndefined();
  } finally {
    resolver.dispose();
    setup.renderer.destroy();
  }
});

test("maximum retained tree remains navigable in a 24×8 terminal", async () => {
  const controller = new TuiController(process.cwd());
  const first = childFixture();
  controller.setSessionId(first.rootOwnerId);
  const children = Array.from({ length: 32 }, (_, index) => ({
    ...first,
    id: crypto.randomUUID(),
    ordinal: index + 1,
    label: `Задача ${index + 1} — длинное название 界`,
    status: "completed" as const,
    cleanup: { quiescent: true },
  }));
  for (const child of children)
    controller.acceptSubagent({
      type: "accepted",
      ownerId: first.rootOwnerId,
      child: subagentDescriptor(child),
    });
  const setup = await testRender(
    <OpenTuiSpike
      controller={controller}
      initialTheme="paper"
      initialUnicodeDecorations={false}
    />,
    { width: 24, height: 8 },
  );
  try {
    await frame(setup);
    await key(setup, "F7");
    await key(setup, "END");
    expect(controller.snapshot.agentTree?.selected).toBe(children[31]?.id);
    await capture(setup, "paper-ascii-24x8-32-records");
    expect(setup.captureCharFrame()).toContain("Задача 32");
    await key(setup, "RETURN");
    expect(controller.snapshot.agentView?.id).toBe(children[31]?.id);
    await key(setup, "ESCAPE");
    expect(controller.snapshot.agentTree?.selected).toBe(children[31]?.id);
  } finally {
    setup.renderer.destroy();
  }
});
