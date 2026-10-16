/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  type ExtensionContext,
  ExtensionHost,
} from "../../src/extensions/index.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { WorkspaceCommands } from "../../src/ui/workspace-commands.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
test("production surfaces compose ordered wrappers, preserve editor updates, hide normal rows and retain errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-composition-"));
  let revision = 1;
  const listeners = new Set<() => void>();
  const source = (text: string) => ({
    snapshot: () => ({
      revision,
      state: "ready" as const,
      render: {
        mode: "replace" as const,
        content: {
          type: "box" as const,
          children: [
            { type: "text" as const, text: `${text}:${revision}` },
            ...(revision === 3
              ? [
                  {
                    type: "box" as const,
                    children: [{ type: "native" as const }],
                  },
                ]
              : [{ type: "native" as const }]),
          ],
        },
      },
    }),
    subscribe(_binding: unknown, changed: () => void) {
      listeners.add(changed);
      return {
        dispose() {
          listeners.delete(changed);
        },
      };
    },
  });
  const host = new ExtensionHost([
    {
      id: "a",
      activate(ctx) {
        ctx.ui.register({
          id: "wrap",
          slot: "render",
          surfaces: ["AssistantMessage", "Composer"],
          scope: "conversation",
          title: "A",
          order: 10,
          source: source("INNER"),
        });
        ctx.ui.register({
          id: "hide",
          slot: "render",
          surfaces: ["SystemMessage"],
          scope: "conversation",
          title: "Hide",
          source: {
            snapshot: () => ({
              revision,
              state: "ready",
              render: { mode: "hide" },
            }),
          },
        });
      },
    },
    {
      id: "b",
      activate(ctx) {
        ctx.ui.register({
          id: "wrap",
          slot: "render",
          surfaces: ["AssistantMessage"],
          scope: "conversation",
          title: "B",
          order: 20,
          source: source("OUTER"),
        });
      },
    },
  ]);
  const controller = new TuiController(root);
  controller.append("Содержательный ответ", "assistant");
  controller.append("HIDDEN INFORMATION", "info");
  controller.append("VISIBLE FAILURE", "error");
  const commands = new WorkspaceCommands(host);
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <OpenTuiSpike controller={controller} commandActions={commands} />,
      { width: 100, height: 40, exitOnCtrlC: false },
    );
  });
  async function until(check: () => boolean) {
    const deadline = Date.now() + 4000;
    while (!check()) {
      if (Date.now() > deadline) throw Error(setup.captureCharFrame());
      await act(async () => {
        await Bun.sleep(10);
        await setup.renderOnce();
      });
    }
  }
  try {
    await until(() => setup.captureCharFrame().includes("OUTER:1"));
    const frame = setup.captureCharFrame();
    expect(frame.indexOf("OUTER:1")).toBeLessThan(frame.indexOf("INNER:1"));
    expect(frame).toContain("Содержательный ответ");
    expect(frame).not.toContain("HIDDEN INFORMATION");
    expect(frame).toContain("VISIBLE FAILURE");
    await act(async () => {
      await setup.mockInput.typeText("Черновик сохраняется");
      setup.mockInput.pressArrow("left");
    });
    const editor = setup.renderer.currentFocusedEditor;
    const cursor = (editor as unknown as { cursorOffset: number }).cursorOffset;
    revision++;
    await act(async () => {
      for (const changed of listeners) changed();
    });
    await until(() => setup.captureCharFrame().includes("OUTER:2"));
    expect(setup.renderer.currentFocusedEditor).toBe(editor);
    expect((editor as unknown as { cursorOffset: number }).cursorOffset).toBe(
      cursor,
    );
    expect(controller.snapshot.draft).toBe("Черновик сохраняется");
    revision++;
    await act(async () => {
      for (const changed of listeners) changed();
    });
    await until(() => setup.captureCharFrame().includes("OUTER:3"));
    expect(
      (
        setup.renderer.currentFocusedEditor as unknown as {
          cursorOffset: number;
        }
      ).cursorOffset,
    ).toBe(cursor);
    expect(controller.snapshot.draft).toBe("Черновик сохраняется");
  } finally {
    await act(async () => setup.renderer.destroy());
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid recursive trees, foreign actions and failed render sources restore the native surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-composition-fault-"));
  let context!: ExtensionContext;
  const host = new ExtensionHost([
    {
      id: "bad",
      activate(ctx) {
        context = ctx;
        ctx.ui.register({
          id: "fault",
          slot: "render",
          surfaces: ["AssistantMessage"],
          scope: "conversation",
          title: "Bad",
          source: {
            snapshot() {
              throw Error("private-error-token=secret");
            },
          },
        });
        ctx.ui.register({
          id: "foreign",
          slot: "render",
          surfaces: ["Composer"],
          scope: "conversation",
          title: "Bad action",
          source: {
            snapshot: () => ({
              revision: 1,
              state: "ready",
              render: {
                mode: "replace",
                content: {
                  type: "button",
                  label: "Foreign",
                  action: { id: "foreign" },
                },
              },
            }),
          },
        });
        const deep: { type: "box"; children: unknown[] } = {
          type: "box",
          children: [],
        };
        deep.children.push(deep);
        ctx.ui.register({
          id: "recursive",
          slot: "render",
          surfaces: ["Composer"],
          scope: "conversation",
          title: "Bad tree",
          source: {
            snapshot: () => ({
              revision: 1,
              state: "ready",
              render: { mode: "replace", content: deep as never },
            }),
          },
        });
      },
    },
  ]);
  const controller = new TuiController(root);
  controller.append("Native response retained", "assistant");
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <OpenTuiSpike
        controller={controller}
        commandActions={new WorkspaceCommands(host)}
      />,
      { width: 90, height: 35, exitOnCtrlC: false },
    );
  });
  try {
    const deadline = Date.now() + 4000;
    while (
      !controller.snapshot.uiContributions?.every(
        (item) => item.snapshot.state === "unavailable",
      ) ||
      !controller.snapshot.uiContributions?.length
    ) {
      if (Date.now() > deadline) throw Error("Sources did not fail closed");
      await act(async () => {
        await Bun.sleep(10);
        await setup.renderOnce();
      });
    }
    await act(async () => {
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("Native response retained");
    expect(setup.captureCharFrame()).toContain("сохранён стандартный вид");
    expect(setup.captureCharFrame()).not.toContain("private-error-token");
    expect(
      setup.renderer.root.findDescendantById("prompt-editor"),
    ).toBeDefined();
    expect(() => context.ui.register({} as never)).toThrow(
      "registrations are closed",
    );
  } finally {
    await act(async () => setup.renderer.destroy());
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
