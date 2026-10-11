/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createSession } from "../../src/sessions/store.js";
import { subagentDescriptor } from "../../src/subagents/service.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";
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
async function click(setup: Setup, id: string) {
  const target = setup.renderer.root.findDescendantById(id);
  expect(target).toBeDefined();
  if (!target) throw new Error(id);
  await act(async () => {
    await setup.mockMouse.click(target.x + 1, target.y);
  });
  await frame(setup);
}
async function capture(setup: Setup, name: string) {
  const folder = process.env.CHISEL_SIDEBAR_CAPTURES;
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
function scenario() {
  const controller = new TuiController(process.cwd());
  const session = createSession(
    process.cwd(),
    "openai-compatible",
    "deepseek-v4-flash",
  );
  session.title = "Обновить интерфейс проекта";
  session.totalTokens = { inputTokens: 38000, outputTokens: 8200 };
  controller.setSessionUsage(session);
  const selection = {
    provider: "openai-compatible" as const,
    model: "deepseek-v4-flash",
  };
  controller.setActiveModel(selection.provider, selection.model);
  controller.setModelCapabilities(selection, {
    tokenCounting: "local_estimate",
    contextWindow: 1_000_000,
    limitsSource: "catalog",
  });
  controller.setContextSnapshot(selection, {
    model: selection.model,
    occupiedTokens: 38207,
    observedInputTokens: 38207,
    contextWindow: 1_000_000,
    status: "estimated",
    source: "local_estimate",
    windowSource: "catalog",
    observedAt: new Date().toISOString(),
  });
  controller.append(
    "Обнови правую панель: контекст, меню и помощники.",
    "user",
  );
  controller.append(
    "## План работы\n\n1. Изучить структуру интерфейса.\n2. Собрать панель с вкладками.\n3. Проверить навигацию и узкие окна.",
    "assistant",
  );
  controller.setDraft("Черновик следующего сообщения");
  const child = childFixture(session.id);
  child.parentConversationId = controller.conversationId;
  child.label = "Проверить навигацию";
  child.step = "Изучает src/ui/opentui-spike.tsx";
  controller.acceptSubagent({
    type: "accepted",
    ownerId: session.id,
    child: subagentDescriptor(child),
  });
  const sibling = {
    ...child,
    id: crypto.randomUUID(),
    ordinal: 2,
    label: "Проверить изменения",
    status: "awaiting_approval" as const,
    step: "Ожидает разрешения на запуск",
  };
  controller.acceptSubagent({
    type: "accepted",
    ownerId: session.id,
    child: subagentDescriptor(sibling),
  });
  controller.setAgentSidebar("context", false);
  return { controller, child };
}
for (const theme of ["obsidian", "paper", "graphite", "ember"] as const) {
  test(`sidebar tabs, real menu actions and focus preserve a streaming conversation in ${theme}`, async () => {
    const { controller, child } = scenario();
    let cancellations = 0;
    let setup!: Setup;
    await act(async () => {
      setup = await testRender(
        <OpenTuiSpike
          controller={controller}
          initialTheme={theme}
          onExit={() => {}}
          onSubmit={async () => {}}
          onCancel={() => cancellations++}
        />,
        { width: 160, height: 36, exitOnCtrlC: false },
      );
    });
    try {
      await frame(setup);
      await capture(setup, `${theme}-context`);
      await click(setup, "context-sidebar");
      expect(controller.snapshot.focus).toBe("sidebar");
      await click(setup, "sidebar-tab-menu");
      expect(controller.snapshot.agentTree?.view).toBe("menu");
      expect(controller.snapshot.focus).toBe("sidebar");
      await act(async () => {
        controller.appendToLast("Проверка продолжается…");
        controller.acceptSubagent({
          type: "changed",
          ownerId: child.rootOwnerId,
          child: subagentDescriptor({
            ...child,
            revision: 2,
            step: "Проверяет клавиатуру",
          }),
        });
      });
      await frame(setup);
      expect(controller.snapshot.agentTree?.view).toBe("menu");
      await capture(setup, `${theme}-menu`);
      await key(setup, "ARROW_DOWN");
      await key(setup, "RETURN");
      expect(controller.snapshot.overlay).toBe("settings");
      expect(
        setup.renderer.root.findDescendantById("settings-popup"),
      ).toBeDefined();
      // Keys belong to the dialog and cannot switch the sidebar beneath it.
      await key(setup, "3");
      expect(controller.snapshot.agentTree?.view).toBe("menu");
      await key(setup, "ESCAPE");
      expect(controller.snapshot.focus).toBe("sidebar");
      expect(controller.snapshot.draft).toBe("Черновик следующего сообщения");
      await key(setup, "]");
      expect(controller.snapshot.agentTree?.view).toBe("context");
      const context = setup.renderer.root.findDescendantById(
        "context-sidebar",
      ) as ScrollBoxRenderable;
      expect(context.focused).toBe(true);
      await key(setup, "3");
      expect(controller.snapshot.agentTree?.view).toBe("agents");
      await key(setup, "ARROW_DOWN");
      expect(controller.snapshot.agentTree?.selected).toBe(child.id);
      await capture(setup, `${theme}-agents`);
      await key(setup, "c", true);
      expect(cancellations).toBe(0);
      await key(setup, "1");
      await key(setup, "2");
      await key(setup, "3");
      expect(controller.snapshot.agentTree?.selected).toBe(child.id);
      await click(setup, "sidebar-tab-context");
      await key(setup, "ESCAPE");
      expect(controller.snapshot.focus).toBe("composer");
      await key(setup, "END");
      await key(setup, "1");
      expect(controller.snapshot.draft).toBe("Черновик следующего сообщения1");
      expect(controller.snapshot.agentTree?.view).toBe("context");
    } finally {
      act(() => setup.renderer.destroy());
      controller.dispose();
    }
  });
}

test("sidebar drawer anchors to the right, restores scroll and uses the full narrow screen", async () => {
  const { controller } = scenario();
  let setup!: Setup;
  await act(async () => {
    setup = await testRender(
      <OpenTuiSpike
        controller={controller}
        onExit={() => {}}
        onSubmit={async () => {}}
        initialUnicodeDecorations
      />,
      { width: 100, height: 22 },
    );
  });
  try {
    await frame(setup);
    expect(
      setup.renderer.root.findDescendantById("sidebar-panel"),
    ).toBeUndefined();
    await key(setup, "b", true);
    let panel = setup.renderer.root.findDescendantById("sidebar-panel");
    expect(panel?.x).toBe(60);
    expect(panel?.width).toBe(40);
    expect(
      setup.renderer.root.findDescendantById("prompt-editor"),
    ).toBeDefined();
    await capture(setup, "drawer-context");
    await key(setup, "END");
    const context = setup.renderer.root.findDescendantById(
      "context-sidebar",
    ) as ScrollBoxRenderable;
    expect(context.scrollTop).toBeGreaterThan(0);
    const position = context.scrollTop;
    await key(setup, "1");
    await key(setup, "2");
    const restored = setup.renderer.root.findDescendantById(
      "context-sidebar",
    ) as ScrollBoxRenderable;
    expect(restored.scrollTop).toBe(position);
    await key(setup, "ESCAPE");
    expect(
      setup.renderer.root.findDescendantById("sidebar-panel"),
    ).toBeUndefined();
    expect(controller.snapshot.focus).toBe("composer");
    await key(setup, "b", true);
    expect(
      setup.renderer.root.findDescendantById("sidebar-panel"),
    ).toBeDefined();
    expect(controller.snapshot.focus).toBe("sidebar");
    await key(setup, "ESCAPE");
    await act(async () => setup.renderer.resize(60, 18));
    await key(setup, "F7");
    panel = setup.renderer.root.findDescendantById("sidebar-panel");
    expect(panel?.x).toBe(0);
    expect(panel?.width).toBe(60);
    await capture(setup, "fullscreen-agents");
    await act(async () => setup.renderer.resize(24, 8));
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("Аг.2");
    await capture(setup, "tiny-agents");
    await key(setup, "1");
    await key(setup, "2");
    expect(controller.snapshot.agentTree?.view).toBe("context");
    await key(setup, "ESCAPE");
    expect(controller.snapshot.focus).toBe("composer");
    expect(controller.snapshot.draft).toBe("Черновик следующего сообщения");
  } finally {
    act(() => setup.renderer.destroy());
    controller.dispose();
  }
});

test("home opens the sidebar with one Ctrl+B and menu settings preserve the active conversation", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  let setup!: Setup;
  await act(async () => {
    setup = await testRender(
      <OpenTuiSpike
        workspace={workspace}
        onExit={() => {}}
        onSubmit={async () => {}}
      />,
      { width: 120, height: 30 },
    );
  });
  try {
    await frame(setup);
    expect(
      setup.renderer.root.findDescendantById("sidebar-panel"),
    ).toBeUndefined();
    await key(setup, "b", true);
    expect(
      setup.renderer.root.findDescendantById("sidebar-panel"),
    ).toBeDefined();
    let origin!: TuiController;
    await act(async () => {
      origin = workspace.newTab();
      origin.setDraft("Задача в первой вкладке");
      origin.setBusy(true);
    });
    await frame(setup);
    await click(setup, "sidebar-tab-menu");
    expect(
      setup.renderer.root.findDescendantById("sidebar-menu-new"),
    ).toBeUndefined();
    await click(setup, "sidebar-menu-appearance");
    expect(origin.snapshot.overlay).toBe("settings");
    await key(setup, "ESCAPE");
    expect(workspace.controller).toBe(origin);
    expect(origin.snapshot.draft).toBe("Задача в первой вкладке");
    expect(origin.snapshot.busy).toBe(true);
    expect(origin.snapshot.focus).toBe("sidebar");
    expect(origin.snapshot.agentTree?.view).toBe("menu");
  } finally {
    act(() => setup.renderer.destroy());
    workspace.dispose();
  }
});
