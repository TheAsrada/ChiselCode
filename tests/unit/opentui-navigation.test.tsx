/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { THEMES } from "../../src/ui/appearance.js";
import { LOGO_WIDTH, renderLogoRows } from "../../src/ui/logo.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
async function frame(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
  });
}
async function click(setup: Setup, id: string) {
  const target = setup.renderer.root.findDescendantById(id);
  if (!target) throw new Error(`Missing ${id}`);
  await act(async () => {
    await setup.mockMouse.click(
      target.x + Math.floor(target.width / 2),
      target.y + 1,
    );
  });
  await frame(setup);
}

for (const [width, height] of [
  [40, 12],
  [60, 15],
  [80, 24],
  [120, 36],
]) {
  test(`welcome, first prompt, plus and existing tabs at ${width}×${height}`, async () => {
    const workspace = new TuiWorkspace(process.cwd());
    const submitted: string[] = [];
    const setup = await testRender(
      <OpenTuiSpike
        workspace={workspace}
        onExit={() => {}}
        onSubmit={async (input) => {
          submitted.push(input);
          const controller = workspace.activeKey
            ? workspace.controller
            : workspace.newTab();
          controller.setSessionTitle(input);
          controller.append(input, "user");
        }}
      />,
      { width, height },
    );
    try {
      await frame(setup);
      expect(workspace.tabs).toHaveLength(0);
      expect(
        setup.renderer.root.findDescendantById("session-tabs"),
      ).toBeFalsy();
      expect(setup.renderer.root.findDescendantById("welcome")).toBeTruthy();
      for (const removed of [
        "Главная",
        "Недавние сессии",
        "Настройки /settings",
        "Тема",
        "История /sessions",
        "Скиллы /skills",
      ])
        expect(setup.captureCharFrame()).not.toContain(removed);
      const logo = setup.renderer.root.findDescendantById("welcome-logo");
      const prompt = setup.renderer.root.findDescendantById("prompt");
      expect(prompt?.y).toBe((logo?.y ?? 0) + (logo?.height ?? 0) + 1);
      if (width >= LOGO_WIDTH + 4 && height >= 18)
        expect(setup.captureCharFrame()).toContain(renderLogoRows()[2]);
      else expect(setup.captureCharFrame()).toContain("<i> ChiselCode");
      await act(async () => {
        await setup.mockInput.pasteBracketedText("Первая задача");
        setup.mockInput.pressEnter();
      });
      await frame(setup);
      expect(submitted).toEqual(["Первая задача"]);
      expect(workspace.tabs).toHaveLength(1);
      expect(workspace.activeKey).toBeDefined();
      expect(setup.renderer.root.findDescendantById("welcome")).toBeFalsy();
      const first = workspace.controller,
        firstKey = workspace.activeKey;
      const tab = setup.renderer.root.findDescendantById(`session-${firstKey}`);
      const plus = setup.renderer.root.findDescendantById("new-session");
      expect(plus?.x).toBe((tab?.x ?? 0) + (tab?.width ?? 0));
      await act(async () => {
        await setup.mockInput.pasteBracketedText("черновик\nвторой строки");
      });
      await click(setup, "new-session");
      expect(workspace.tabs).toHaveLength(1);
      expect(workspace.activeKey).toBeUndefined();
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
      expect(setup.renderer.root.findDescendantById("welcome")).toBeTruthy();
      act(() => first.appendToLast("фоновый ответ"));
      await frame(setup);
      expect(setup.captureCharFrame()).not.toContain("фоновый ответ");
      await click(setup, `session-${firstKey}`);
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
        "черновик\nвторой строки",
      );
      expect(setup.captureCharFrame()).toContain("фоновый ответ");
      await act(async () => {
        setup.mockInput.pressKey("w", { ctrl: true });
      });
      await frame(setup);
      expect(workspace.tabs).toHaveLength(0);
      expect(setup.renderer.root.findDescendantById("welcome")).toBeTruthy();
      expect(
        setup.renderer.root.findDescendantById("session-tabs"),
      ).toBeFalsy();
    } finally {
      act(() => setup.renderer.destroy());
      workspace.dispose();
    }
  });
}

test("native multiline input survives resize and clicking send creates only one conversation", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  const submitted: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      onExit={() => {}}
      onSubmit={async (input) => {
        submitted.push(input);
        workspace.newTab().append(input, "user");
      }}
    />,
    { width: 120, height: 36 },
  );
  try {
    await frame(setup);
    await act(async () => {
      await setup.mockInput.pasteBracketedText(
        "Проверь API\nи обработку ошибок",
      );
      setup.resize(40, 12);
    });
    await frame(setup);
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
      "Проверь API\nи обработку ошибок",
    );
    const prompt = setup.renderer.root.findDescendantById("prompt");
    expect((prompt?.y ?? 0) + (prompt?.height ?? 0)).toBeLessThanOrEqual(12);
    const lines = setup.captureCharFrame().split("\n"),
      y = lines.findIndex(
        (line) => line.includes("Chisel") && line.includes("↵"),
      );
    const sendColumn = lines[y]?.lastIndexOf("↵");
    if (sendColumn === undefined || sendColumn < 0)
      throw new Error("Send action is missing");
    await act(async () => {
      await setup.mockMouse.click(sendColumn, y);
    });
    await frame(setup);
    expect(submitted).toEqual(["Проверь API\nи обработку ошибок"]);
    expect(workspace.tabs).toHaveLength(1);
  } finally {
    act(() => setup.renderer.destroy());
    workspace.dispose();
  }
});

test("overflow keeps the active tab and plus visible; close buttons belong to their tab", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  for (let i = 0; i < 9; i++) {
    const tab = workspace.newTab();
    tab.setSessionTitle(`Разговор ${i}`);
  }
  const setup = await testRender(
    <OpenTuiSpike workspace={workspace} onExit={() => {}} />,
    { width: 40, height: 12 },
  );
  try {
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("Разговор 8");
    const key = workspace.activeKey;
    const tab = setup.renderer.root.findDescendantById(`session-${key}`);
    const plus = setup.renderer.root.findDescendantById("new-session");
    if (!tab || !plus) throw new Error("Tab controls are missing");
    expect(plus.x).toBe(tab.x + tab.width);
    expect(plus.x + plus.width).toBeLessThanOrEqual(40);
    act(() => workspace.controller.setBusy(true));
    await frame(setup);
    await act(async () => {
      await setup.mockMouse.click(tab.x + tab.width - 3, tab.y + 1);
    });
    expect(workspace.tabs).toHaveLength(9);
    act(() => workspace.controller.setBusy(false));
    await frame(setup);
    await act(async () => {
      await setup.mockMouse.click(tab.x + tab.width - 3, tab.y + 1);
    });
    await frame(setup);
    expect(workspace.tabs).toHaveLength(8);
    expect(setup.captureCharFrame()).toContain("Разговор 7");
  } finally {
    act(() => setup.renderer.destroy());
    workspace.dispose();
  }
});

test("command feedback and suggestions fit the welcome screen without creating a tab", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      onExit={() => {}}
      onSubmit={async (input) =>
        workspace.home.append(`Ответ на ${input}`, "info")
      }
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    await act(async () => {
      await setup.mockInput.typeText("/status");
      setup.mockInput.pressEnter();
    });
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("Ответ на /status");
    expect(workspace.tabs).toHaveLength(0);
    await act(async () => {
      setup.resize(40, 12);
    });
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("Ответ на /status");
    await act(async () => {
      await setup.mockInput.typeText("/se");
    });
    await frame(setup);
    const prompt = setup.renderer.root.findDescendantById("prompt");
    if (!prompt) throw new Error("Prompt is missing");
    expect(prompt.y + prompt.height).toBeLessThanOrEqual(12);
    expect(setup.captureCharFrame()).toContain("/settings");
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("/se");
  } finally {
    act(() => setup.renderer.destroy());
    workspace.dispose();
  }
});

for (const [theme, palette] of Object.entries(THEMES)) {
  test(`welcome and prompt use the ${theme} palette`, async () => {
    const workspace = new TuiWorkspace(process.cwd());
    const setup = await testRender(
      <OpenTuiSpike
        workspace={workspace}
        onExit={() => {}}
        initialTheme={theme as keyof typeof THEMES}
      />,
      { width: 100, height: 30 },
    );
    try {
      await frame(setup);
      expect(setup.captureCharFrame()).toContain(renderLogoRows()[2]);
      const accent = RGBA.fromHex(palette.accent).toInts();
      expect(
        setup
          .captureSpans()
          .lines.flatMap((line) => line.spans)
          .some(
            (span) =>
              JSON.stringify(span.fg.toInts()) === JSON.stringify(accent),
          ),
      ).toBe(true);
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
    } finally {
      act(() => setup.renderer.destroy());
      workspace.dispose();
    }
  });
}
