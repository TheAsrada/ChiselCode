/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";

for (const [width, height] of [
  [60, 15],
  [80, 24],
  [120, 30],
  [160, 40],
]) {
  test(`OpenTUI probe at ${width}×${height}: resize preserves draft and controls`, async () => {
    let exited = 0;
    const setup = await testRender(<OpenTuiSpike onExit={() => exited++} />, {
      width,
      height,
    });
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("ChiselCode");
      expect(setup.captureCharFrame().includes("Контекст")).toBe(width >= 120);

      await act(async () => {
        setup.mockInput.pasteBracketedText("первая строка\nвторая строка");
      });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Черновик");
      expect(setup.captureCharFrame()).not.toContain("❯ первая строка");

      await act(async () => {
        setup.resize(90, 22);
      });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Черновик");

      await act(async () => {
        setup.mockInput.pressKey("b", { ctrl: true });
      });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Контекст");
      await act(async () => {
        setup.mockInput.pressEscape();
        await new Promise((resolve) => setTimeout(resolve, 120));
      });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Черновик");

      await act(async () => {
        setup.mockInput.pressKey("d", { ctrl: true });
      });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Привет");
      setup.mockInput.pressCtrlC();
      expect(exited).toBe(1);
    } finally {
      act(() => {
        setup.renderer.destroy();
      });
    }
  });
}
