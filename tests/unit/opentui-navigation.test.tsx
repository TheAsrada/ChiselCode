/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { COMPACT_LOGO } from "../../src/ui/logo.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

for (const [width, height] of [
  [40, 12],
  [60, 15],
  [80, 24],
  [120, 30],
]) {
  test(`home, plus and tab navigation at ${width}×${height}`, async () => {
    const workspace = new TuiWorkspace(process.cwd());
    const setup = await testRender(
      <OpenTuiSpike workspace={workspace} onExit={() => {}} />,
      { width, height },
    );
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Главная");
      expect(setup.captureCharFrame()).toContain("ChiselCode");
      const nav = setup.captureCharFrame().split("\n")[0] ?? "";
      const plus = nav.indexOf(" + ");
      expect(plus).toBeGreaterThan(0);
      await act(async () => {
        await setup.mockMouse.click(plus + 1, 0);
      });
      await setup.renderOnce();
      expect(workspace.tabs).toHaveLength(1);
      expect(workspace.activeKey).toBeDefined();
      expect(setup.captureCharFrame()).not.toContain(COMPACT_LOGO[0]);
      const first = workspace.controller;
      const firstKey = workspace.activeKey;
      await act(async () => {
        await setup.mockInput.pasteBracketedText("черновик");
      });
      act(() => workspace.newTab());
      await setup.renderOnce();
      act(() => first.appendToLast("ответ в первой вкладке"));
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("ответ в первой вкладке");
      act(() => workspace.select(firstKey));
      await setup.renderOnce();
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("черновик");
      expect(setup.captureCharFrame()).toContain("ответ в первой вкладке");
      act(() => setup.mockInput.pressKey("g", { ctrl: true }));
      await setup.renderOnce();
      expect(workspace.activeKey).toBeUndefined();
      expect(setup.captureCharFrame()).toContain("ChiselCode");
      act(() => workspace.select(firstKey));
      await setup.renderOnce();
      act(() => setup.mockInput.pressKey("w", { ctrl: true }));
      await setup.renderOnce();
      expect(workspace.tabs).toHaveLength(1);
    } finally {
      act(() => setup.renderer.destroy());
      workspace.dispose();
    }
  });
}
