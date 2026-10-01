/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { createTuiApprovalResolver } from "../../src/ui/tui-contract.js";
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

test("assistant formatting renders visible headings, lists and inline code", async () => {
  const controller = new TuiController(process.cwd());
  controller.append("## План\n- **Шаг**: `bun test`", "assistant");
  const setup = await testRender(
    <OpenTuiSpike onExit={() => {}} controller={controller} />,
    { width: 80, height: 24 },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("План");
    expect(frame).toContain("Шаг");
    expect(frame).toContain("bun test");
    expect(frame).not.toContain("**Шаг**");
  } finally {
    act(() => setup.renderer.destroy());
    controller.dispose();
  }
});

test("resuming another session resets the transcript window to its latest entry", async () => {
  const controller = new TuiController(process.cwd());
  controller.switchSession({ id: "old", projectPath: process.cwd() });
  controller.replace(
    Array.from({ length: 10_000 }, (_, index) => ({ text: `old ${index}` })),
  );
  const setup = await testRender(
    <OpenTuiSpike onExit={() => {}} controller={controller} />,
    { width: 80, height: 24 },
  );
  try {
    await setup.renderOnce();
    act(() => setup.mockInput.pressKey("\u001b[5~"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("old 9879");
    act(() => {
      controller.switchSession({ id: "new", projectPath: process.cwd() });
      controller.replace(
        Array.from({ length: 7_000 }, (_, index) => ({
          text: `new ${index}`,
        })),
      );
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("new 6999");
  } finally {
    act(() => setup.renderer.destroy());
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
    expect(setup.captureCharFrame()).toContain("Опишите задачу");
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

test("slash completion accepts a prefix before submitting the command", async () => {
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
    await act(async () => setup.mockInput.pasteBracketedText("/he"));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("/help");
    act(() => setup.mockInput.pressEnter());
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("/help");
    expect(submitted).toEqual([]);
    act(() => setup.mockInput.pressEnter());
    expect(submitted).toEqual(["/help"]);
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("slash suggestions keep the selected command visible past the first page", async () => {
  const setup = await testRender(<OpenTuiSpike onExit={() => {}} />, {
    width: 80,
    height: 24,
  });
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pasteBracketedText("/"));
    act(() => {
      for (let index = 0; index < 7; index++)
        setup.mockInput.pressArrow("down");
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("> /sessions");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("Ctrl+D exits the developer composer when the draft is empty", async () => {
  let exits = 0;
  const setup = await testRender(
    <OpenTuiSpike onExit={() => exits++} onSubmit={async () => {}} />,
    { width: 80, height: 24 },
  );
  try {
    await setup.renderOnce();
    act(() => setup.mockInput.pressKey("d", { ctrl: true }));
    expect(exits).toBe(1);
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("Ctrl+C remains available while an approval owns keyboard focus", async () => {
  const resolver = createTuiApprovalResolver();
  let exits = 0;
  const setup = await testRender(
    <OpenTuiSpike onExit={() => exits++} approvalResolver={resolver} />,
    { width: 80, height: 24 },
  );
  try {
    await act(async () => {
      void resolver.requestApproval({ tool: "run_shell", preview: "command" });
    });
    act(() => setup.mockInput.pressCtrlC());
    expect(exits).toBe(1);
  } finally {
    resolver.dispose();
    act(() => setup.renderer.destroy());
  }
});

test("Tab reaches the inline sidebar and Esc restores composer focus", async () => {
  const controller = new TuiController(process.cwd());
  const setup = await testRender(
    <OpenTuiSpike onExit={() => {}} controller={controller} />,
    { width: 120, height: 30 },
  );
  try {
    await setup.renderOnce();
    await act(async () => setup.mockInput.pasteBracketedText("черновик"));
    act(() => setup.mockInput.pressTab());
    expect(controller.snapshot.focus).toBe("transcript");
    act(() => setup.mockInput.pressTab());
    await setup.renderOnce();
    expect(controller.snapshot.focus).toBe("sidebar");
    expect(setup.captureCharFrame()).toContain("> Контекст");
    await act(async () => {
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(controller.snapshot.focus).toBe("composer");
    await act(async () => setup.resize(80, 24));
    await setup.renderOnce();
    expect(controller.snapshot.draft).toBe("черновик");
  } finally {
    act(() => setup.renderer.destroy());
    controller.dispose();
  }
});
