/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { useTerminalDimensions } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { themePalette } from "../../src/themes/palettes.js";
import { OpenTuiWorktrees } from "../../src/ui/opentui-worktrees.js";
import { useOverlayInputOwner } from "../../src/ui/overlay-input.js";
import type { WorktreeManagerActions } from "../../src/ui/worktree-actions.js";
import type { WorktreeDescriptor } from "../../src/worktrees/service.js";

const origin: WorktreeDescriptor = {
  kind: "origin",
  label: "Основной",
  path: "/project",
  state: "external",
  readOnly: true,
};
const managed: WorktreeDescriptor = {
  kind: "managed",
  label: "Отдельная задача",
  id: "owned",
  path: "/tree",
  origin: "/project",
  base: "a".repeat(40),
  state: "ready",
  readOnly: false,
  activeUsers: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  ignored: 0,
  conflicted: 0,
};
function Wrapper({
  actions,
  paper = false,
  active = true,
}: {
  actions: WorktreeManagerActions;
  width: number;
  height: number;
  paper?: boolean;
  active?: boolean;
}) {
  const dimensions = useTerminalDimensions();
  useOverlayInputOwner(active ? "dialog" : "approval");
  return (
    <OpenTuiWorktrees
      actions={actions}
      width={dimensions.width}
      height={dimensions.height}
      palette={themePalette(paper ? "paper" : "obsidian")}
      active={active}
      onClose={() => {}}
    />
  );
}
type Setup = Awaited<ReturnType<typeof testRender>>;
async function renderUi(
  node: Parameters<typeof testRender>[0],
  options: Parameters<typeof testRender>[1],
) {
  let setup!: Setup;
  await act(async () => {
    setup = await testRender(node, options);
  });
  return setup;
}

const frame = async (setup: Setup) => {
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
};
const key = async (setup: Setup, name: string) => {
  await act(async () => {
    setup.mockInput.pressKey(name);
    if (name === "ESCAPE") await Bun.sleep(120);
  });
  await frame(setup);
};
const click = async (setup: Setup, id: string) => {
  const item = setup.renderer.root.findDescendantById(id);
  if (!item) throw new Error(`Missing ${id}\n${setup.captureCharFrame()}`);
  await act(async () => {
    await setup.mockMouse.click(item.x + 1, item.y);
  });
  await frame(setup);
};
function fixture(items = [origin, managed]) {
  const calls: { action: string; input: unknown }[] = [];
  const actions: WorktreeManagerActions = {
    root: "/project",
    owner: "owner",
    mode: "build",
    tabs: () => [],
    closeTab: () => false,
    run: async (action, input) => {
      calls.push({ action, input });
      return action === "list"
        ? {
            output: "list",
            details: { worktrees: JSON.parse(JSON.stringify(items)) },
          }
        : { output: "OK" };
    },
  };
  return { actions, calls };
}
for (const paper of [false, true])
  test(`native worktree manager distinguishes origin and preserves a form across resize (${paper ? "Paper" : "Obsidian"})`, async () => {
    const f = fixture();
    const setup = await renderUi(
      <Wrapper actions={f.actions} width={120} height={36} paper={paper} />,
      { width: 120, height: 36 },
    );
    try {
      await frame(setup);
      expect(setup.captureCharFrame()).toContain("Основной проект");
      expect(setup.captureCharFrame()).not.toContain(
        "Внешняя (только просмотр)",
      );
      await key(setup, "n");
      await act(async () => {
        await setup.mockInput.pasteBracketedText("Новая задача");
      });
      await frame(setup);
      expect(setup.captureCharFrame()).toContain("Новая задача");
      await act(async () => {
        setup.resize(40, 20);
      });
      await frame(setup);
      expect(setup.captureCharFrame()).toContain("Новая задача");
      const popup = setup.renderer.root.findDescendantById("worktrees-popup");
      expect(
        popup &&
          popup.x >= 0 &&
          popup.y >= 0 &&
          popup.x + popup.width <= 40 &&
          popup.y + popup.height <= 20,
      ).toBe(true);
      expect(f.calls.map((call) => call.action)).toEqual(["list"]);
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

test("a blocked removal explains ignored files and never dispatches a mutation", async () => {
  const f = fixture([origin, { ...managed, ignored: 1 }]);
  const setup = await renderUi(
    <Wrapper actions={f.actions} width={120} height={36} />,
    { width: 120, height: 36 },
  );
  try {
    await frame(setup);
    await click(setup, "worktree-select-owned");
    await click(setup, "worktree-action-2");
    expect(setup.captureCharFrame()).toContain("игнорируемые");
    expect(f.calls.some((call) => call.action === "remove")).toBe(false);
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("removal starts with Cancel selected and cannot be confirmed by the opening Enter", async () => {
  const f = fixture();
  const setup = await renderUi(
    <Wrapper actions={f.actions} width={120} height={36} />,
    { width: 120, height: 36 },
  );
  try {
    await frame(setup);
    await click(setup, "worktree-select-owned");
    await click(setup, "worktree-action-2");
    expect(setup.captureCharFrame()).toContain("Удалить папку отдельной копии");
    await key(setup, "RETURN");
    expect(f.calls.some((call) => call.action === "remove")).toBe(false);
    expect(setup.captureCharFrame()).toContain("Основной проект");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("refresh failure remains readable and an absent selection never redirects a pending action", async () => {
  const f = fixture();
  let fail = false;
  let removed = false;
  const run = f.actions.run;
  f.actions.run = async (action, input) => {
    if (action === "list" && fail)
      throw new Error("WORKTREE_GIT_ERROR: Git временно недоступен");
    if (action === "list" && removed)
      return {
        output: "list",
        details: { worktrees: JSON.parse(JSON.stringify([origin])) },
      };
    return run(action, input);
  };
  const setup = await renderUi(
    <Wrapper actions={f.actions} width={120} height={36} />,
    { width: 120, height: 36 },
  );
  try {
    await frame(setup);
    await key(setup, "ARROW_DOWN");
    fail = true;
    await key(setup, "r");
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("Git временно недоступен");
    await key(setup, "r");
    await frame(setup);
    await key(setup, "ESCAPE");
    expect(setup.captureCharFrame()).toContain("Отдельная задача");
    fail = false;
    removed = true;
    await key(setup, "r");
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("исчезла");
    await key(setup, "RETURN");
    expect(
      f.calls.some(
        (call) => call.action === "open" || call.action === "origin",
      ),
    ).toBe(false);
  } finally {
    act(() => setup.renderer.destroy());
  }
});
