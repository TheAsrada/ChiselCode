/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { THEMES } from "../../src/ui/appearance.js";
import type { MotionClock, MotionPreference } from "../../src/ui/motion.js";
import {
  ActivityIndicator,
  OpenTuiMotion,
  useMotion,
} from "../../src/ui/opentui-motion.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

test("active motion belongs to the renderer and is completely disposed at unmount", async () => {
  let clock: MotionClock | undefined;
  let change: ((preference: MotionPreference) => Promise<void>) | undefined;
  function Probe() {
    clock = useMotion().clock;
    change = useMotion().change;
    return <ActivityIndicator palette={THEMES.obsidian} />;
  }
  let setup: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <OpenTuiMotion>
        <Probe />
      </OpenTuiMotion>,
      { width: 40, height: 10 },
    );
  });
  expect(clock?.activeTasks).toBe(1);
  expect(clock?.running).toBe(true);
  await act(async () => {
    await change?.("reduced");
  });
  expect(clock?.activeTasks).toBe(0);
  expect(clock?.running).toBe(false);
  await act(async () => {
    await change?.("full");
  });
  expect(clock?.activeTasks).toBe(1);
  act(() => setup.renderer.destroy());
  expect(clock?.activeTasks).toBe(0);
  expect(clock?.running).toBe(false);
});

test("reduced motion has no animation timer and a rejected preference write leaves the saved state", async () => {
  let clock: MotionClock | undefined;
  function Probe() {
    clock = useMotion().clock;
    return <ActivityIndicator palette={THEMES.paper} />;
  }
  let setup: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <OpenTuiMotion preference="reduced">
        <Probe />
      </OpenTuiMotion>,
      { width: 40, height: 10 },
    );
  });
  try {
    expect(clock?.activeTasks).toBe(0);
    expect(clock?.running).toBe(false);
  } finally {
    act(() => setup.renderer.destroy());
  }
  const workspace = new TuiWorkspace(process.cwd());
  await act(async () => {
    setup = await testRender(
      <OpenTuiSpike
        workspace={workspace}
        onExit={() => {}}
        onMotionChange={async () => {
          throw Error("write refused");
        }}
      />,
      { width: 120, height: 36 },
    );
  });
  try {
    await act(async () => {
      setup.mockInput.pressKey("t", { ctrl: true });
      await setup.renderOnce();
      await setup.renderOnce();
    });
    await act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });
    const toggle = setup.renderer.root.findDescendantById("settings-motion");
    if (!toggle) throw Error("Missing motion control");
    await act(async () => {
      await setup.mockMouse.click(toggle.x + 1, toggle.y);
      await setup.renderOnce();
      await setup.renderOnce();
    });
    await act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("Анимации: плавные");
    expect(setup.captureCharFrame()).toContain("write refused");
  } finally {
    act(() => setup.renderer.destroy());
    workspace.dispose();
  }
});

test("menu search owns digits and Enter opens only the selected screen without sending the draft", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  let submissions = 0;
  let setup: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(
      <OpenTuiSpike
        workspace={workspace}
        onExit={() => {}}
        onSubmit={async () => {
          submissions++;
        }}
      />,
      { width: 120, height: 36 },
    );
  });
  const frame = async () =>
    act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });
  const key = async (name: string, ctrl = false) => {
    await act(async () => {
      setup.mockInput.pressKey(name, { ctrl });
      if (name === "ESCAPE") await Bun.sleep(120);
    });
    await frame();
  };
  try {
    await act(async () => {
      await setup.mockInput.pasteBracketedText("Сохранённый черновик");
    });
    await key("b", true);
    const menu = setup.renderer.root.findDescendantById("sidebar-tab-menu");
    if (!menu) throw Error("Missing sidebar");
    await act(async () => {
      await setup.mockMouse.click(menu.x + 1, menu.y);
    });
    await frame();
    await key("/");
    expect(setup.renderer.currentFocusedRenderable?.id).toBe(
      "sidebar-menu-search",
    );
    for (const digit of ["1", "2", "3"]) await key(digit);
    expect(workspace.controller.snapshot.agentTree?.view).toBe("menu");
    expect(setup.captureCharFrame()).toContain("123");
    expect(setup.captureCharFrame()).toContain("Ничего не найдено");
    await key("ESCAPE");
    await key("/");
    await act(async () => {
      await setup.mockInput.pasteBracketedText("Внешний вид");
    });
    await frame();
    await key("RETURN");
    expect(workspace.controller.snapshot.overlay).toBe("settings");
    expect(
      setup.renderer.root.findDescendantById("settings-motion"),
    ).toBeDefined();
    expect(submissions).toBe(0);
    expect(workspace.controller.snapshot.draft).toBe("Сохранённый черновик");
  } finally {
    act(() => setup.renderer.destroy());
    workspace.dispose();
  }
});
