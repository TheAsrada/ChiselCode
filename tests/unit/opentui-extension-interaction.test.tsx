/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { ExtensionHost } from "../../src/extensions/host.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";
import { WorkspaceCommands } from "../../src/ui/workspace-commands.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
test("extension forms accept input, select and local actions without editing or submitting the chat draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-form-"));
  let revision = 1,
    submitted = "",
    selected = "a",
    presses = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    ++revision;
    for (const listener of listeners) listener();
  };
  const host = new ExtensionHost([
    {
      id: "forms",
      activate(ctx) {
        ctx.ui.on("submit", (_binding, event) => {
          if (event.type === "submit") {
            submitted = event.value;
            changed();
          }
        });
        ctx.ui.on("select", (_binding, event) => {
          if (event.type === "select") {
            selected = event.value;
            changed();
          }
        });
        ctx.ui.on("press", () => {
          ++presses;
          changed();
        });
        ctx.ui.register({
          id: "form",
          slot: "render",
          surfaces: ["AbovePrompt"],
          scope: "conversation",
          title: "Форма",
          actions: [
            { id: "press", label: "Считать", type: "event", eventId: "press" },
          ],
          source: {
            snapshot: () => ({
              revision,
              state: "ready",
              render: {
                mode: "replace",
                content: {
                  type: "box",
                  children: [
                    {
                      type: "input",
                      key: "query",
                      label: "Поиск",
                      value: submitted,
                      onSubmit: { id: "submit" },
                    },
                    {
                      type: "select",
                      key: "scope",
                      label: "Область",
                      value: selected,
                      options: [
                        { value: "a", label: "Проект" },
                        { value: "b", label: "Файл" },
                      ],
                      onSelect: { id: "select" },
                    },
                    {
                      type: "button",
                      key: "counter",
                      label: `Считать ${presses}`,
                      action: { id: "press" },
                      hotkey: "ctrl+k",
                    },
                  ],
                },
              },
            }),
            subscribe(_binding, listener) {
              listeners.add(listener);
              return {
                dispose() {
                  listeners.delete(listener);
                },
              };
            },
          },
        });
        ctx.ui.register({
          id: "composer",
          slot: "render",
          surfaces: ["Composer"],
          scope: "conversation",
          title: "Оформление",
          source: {
            snapshot: () => ({
              revision: 1,
              state: "ready",
              render: {
                mode: "replace",
                content: {
                  type: "native",
                  props: {
                    borderStyle: "double",
                    title: "Мой ввод",
                    placeholder: "Новая задача",
                    bg: "raised",
                  },
                },
              },
            }),
          },
        });
      },
    },
  ]);
  const controller = new TuiController(root);
  controller.append("Ответ", "assistant");
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <OpenTuiSpike
        controller={controller}
        commandActions={new WorkspaceCommands(host)}
      />,
      { width: 90, height: 40, exitOnCtrlC: false },
    );
  });
  async function until(check: () => boolean) {
    const deadline = Date.now() + 4000;
    await act(async () => {
      await setup.renderOnce();
    });
    while (!check()) {
      if (Date.now() > deadline) throw Error(setup.captureCharFrame());
      await act(async () => {
        await Bun.sleep(10);
        await setup.renderOnce();
      });
    }
  }
  try {
    await until(
      () =>
        setup.captureCharFrame().includes("Мой ввод") &&
        setup.captureCharFrame().includes("Считать 0"),
    );
    await act(async () => {
      await setup.mockInput.typeText("Черновик");
    });
    const field = setup.renderer.root.findDescendantById(
      "extension-forms/form-query",
    )!;
    expect(field).toBeDefined();
    await act(async () => {
      await setup.mockMouse.click(field.x + 1, field.y);
    });
    await act(async () => {
      await setup.mockInput.typeText("needle");
      setup.mockInput.pressKey("RETURN");
    });
    await until(() => submitted === "needle");
    expect(controller.snapshot.draft).toBe("Черновик");
    await act(async () => {
      setup.mockInput.pressKey("TAB");
    });
    await act(async () => {
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressKey("RETURN");
    });
    await until(() => selected === "b");
    await act(async () => {
      setup.mockInput.pressKey("TAB");
    });
    await act(async () => {
      setup.mockInput.pressKey("k", { ctrl: true });
    });
    await until(() => presses === 1);
    await act(async () => {
      setup.mockInput.pressKey("ESCAPE");
    });
    await until(
      () => setup.renderer.currentFocusedEditor?.id === "prompt-editor",
    );
    await act(async () => {
      await setup.mockInput.typeText("!");
    });
    expect(controller.snapshot.draft).toBe("Черновик!");
    expect(controller.snapshot.busy).toBeFalsy();
  } finally {
    await act(async () => setup.renderer.destroy());
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated message fields have independent focus, presentation context and conversation drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-form-owner-"));
  const events: { text?: string | number; instance?: string; value: string }[] =
    [];
  const host = new ExtensionHost([
    {
      id: "repeat",
      activate(ctx) {
        ctx.ui.on("tag", (binding, event) => {
          if (event.type === "submit")
            events.push({
              text: binding.presentation?.values?.text,
              instance: binding.presentation?.instance,
              value: event.value,
            });
        });
        ctx.ui.register({
          id: "form",
          slot: "render",
          surfaces: ["AssistantMessage"],
          scope: "conversation",
          title: "Метки",
          source: {
            snapshot: () => ({
              revision: 1,
              state: "ready",
              render: {
                mode: "replace",
                content: {
                  type: "box",
                  children: [
                    { type: "native" },
                    {
                      type: "input",
                      key: "tag",
                      label: "Метка",
                      value: "",
                      onSubmit: { id: "tag" },
                    },
                  ],
                },
              },
            }),
          },
        });
      },
    },
  ]);
  const workspace = new TuiWorkspace(root);
  const first = workspace.newTab(root),
    firstKey = workspace.activeKey;
  first.append("Row one", "assistant");
  first.append("Row two", "assistant");
  const firstId = first.snapshot.transcript[0]!.id,
    secondId = first.snapshot.transcript[1]!.id;
  const second = workspace.newTab(root),
    secondKey = workspace.activeKey;
  second.append("Other conversation", "assistant");
  workspace.select(firstKey);
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <OpenTuiSpike
        workspace={workspace}
        commandActions={new WorkspaceCommands(host)}
      />,
      { width: 90, height: 36, exitOnCtrlC: false },
    );
  });
  const field = (id: number) =>
    setup.renderer.root.findDescendantById(
      `extension-repeat/form-tag/AssistantMessage:${id}`,
    ) as InputRenderable | undefined;
  async function until(check: () => boolean) {
    const deadline = Date.now() + 4000;
    await act(async () => {
      await setup.renderOnce();
    });
    while (!check()) {
      if (Date.now() > deadline) throw Error(setup.captureCharFrame());
      await act(async () => {
        await Bun.sleep(10);
        await setup.renderOnce();
      });
    }
  }
  try {
    await until(() => {
      const target = field(secondId);
      return !!target && target.width > 1 && target.height > 0 && target.y > 3;
    });
    const target = field(secondId)!;
    await act(async () => {
      await setup.mockMouse.click(target.x + 1, target.y);
    });
    await until(() => setup.renderer.currentFocusedEditor?.id === target.id);
    await act(async () => {
      await setup.mockInput.typeText("second draft");
      setup.mockInput.pressKey("RETURN");
    });
    await until(() => events.length === 1);
    expect(field(firstId)?.value).toBe("");
    expect(events[0]).toEqual({
      text: "Row two",
      instance: `AssistantMessage:${secondId}`,
      value: "second draft",
    });
    await act(async () => {
      workspace.select(secondKey);
    });
    await until(
      () =>
        setup.captureCharFrame().includes("Other conversation") &&
        !!field(second.snapshot.transcript[0]!.id),
    );
    expect(field(second.snapshot.transcript[0]!.id)?.value).toBe("");
    await act(async () => {
      workspace.select(firstKey);
    });
    await until(() => field(secondId)?.value === "second draft");
    expect(first.snapshot.draft).toBe("");
    expect(second.snapshot.draft).toBe("");
  } finally {
    await act(async () => setup.renderer.destroy());
    await host.dispose();
    workspace.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
