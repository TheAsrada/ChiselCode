/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { createTuiApprovalResolver } from "../../src/ui/tui.js";
import { TuiController } from "../../src/ui/tui-controller.js";

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

test("large transcript pages backwards and returns to newest messages", async () => {
  const controller = new TuiController(process.cwd());
  controller.replace(
    Array.from({ length: 10_000 }, (_, id) => ({ text: `line ${id}` })),
  );
  const setup = await testRender(
    <OpenTuiSpike onExit={() => {}} controller={controller} />,
    { width: 80, height: 24 },
  );
  try {
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("line 9999");
    await act(async () => {
      setup.mockInput.pressKey("\u001b[5~");
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("line 9879");
    await act(async () => {
      setup.mockInput.pressKey("END");
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("line 9999");
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    controller.dispose();
  }
});

test("approval stays keyboard accessible at narrow width and restores the composer", async () => {
  const approvalResolver = createTuiApprovalResolver();
  const setup = await testRender(
    <OpenTuiSpike onExit={() => {}} approvalResolver={approvalResolver} />,
    { width: 60, height: 15 },
  );
  try {
    await setup.renderOnce();
    let decision: Promise<string> | undefined;
    await act(async () => {
      decision = approvalResolver.requestApproval({
        tool: "run_shell",
        preview: "Опасная команда\n\u001b[31mподробности",
      });
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Опасная команда");
    expect(setup.captureCharFrame()).not.toContain("[31m");
    await act(async () => {
      setup.mockInput.pressEscape();
      expect(await decision).toBe("denied");
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Напишите сообщение");
    await act(async () => {
      decision = approvalResolver.requestApproval({
        tool: "write_file",
        preview: "new file",
      });
    });
    await act(async () => {
      setup.mockInput.pressKey("y");
      expect(await decision).toBe("approved");
    });
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
    approvalResolver.dispose();
  }
});

test("developer agent callback receives one multiline pasted prompt", async () => {
  const submitted: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      onExit={() => {}}
      onSubmit={async (prompt) => {
        submitted.push(prompt);
      }}
    />,
    { width: 80, height: 24 },
  );
  try {
    await setup.renderOnce();
    await act(async () => {
      await setup.mockInput.pasteBracketedText("первая строка\nвторая строка");
    });
    expect(submitted).toEqual([]);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    expect(submitted).toEqual(["первая строка\nвторая строка"]);
  } finally {
    act(() => {
      setup.renderer.destroy();
    });
  }
});

test("composer history restores the unsent draft after browsing sent prompts", async () => {
  const submitted: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      onExit={() => {}}
      onSubmit={async (text) => {
        submitted.push(text);
      }}
    />,
    { width: 80, height: 24 },
  );
  try {
    await setup.renderOnce();
    for (const prompt of ["первый", "второй"]) {
      await act(async () => {
        await setup.mockInput.pasteBracketedText(prompt);
        setup.mockInput.pressEnter();
      });
    }
    await act(async () => {
      await setup.mockInput.pasteBracketedText("черновик");
      setup.mockInput.pressArrow("up");
    });
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("второй");
    act(() => setup.mockInput.pressKey("p", { ctrl: true }));
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("первый");
    act(() => setup.mockInput.pressKey("n", { ctrl: true }));
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("второй");
    act(() => setup.mockInput.pressArrow("down"));
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("черновик");
    expect(submitted).toEqual(["первый", "второй"]);
  } finally {
    act(() => setup.renderer.destroy());
  }
});
