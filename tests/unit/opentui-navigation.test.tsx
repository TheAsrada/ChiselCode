/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createSession } from "../../src/sessions/store.js";
import { buildFileDiff } from "../../src/tools/file-diff.js";
import { THEMES } from "../../src/ui/appearance.js";
import { LOGO_WIDTH, renderLogoRows } from "../../src/ui/logo.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { createTuiApprovalResolver } from "../../src/ui/tui-contract.js";
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
  [80, 24],
  [120, 36],
]) {
  test(`Shift+Tab and mode badge preserve draft, model and focus at ${width}×${height}`, async () => {
    const workspace = new TuiWorkspace(process.cwd());
    let submitted = false;
    const setup = await testRender(
      <OpenTuiSpike
        workspace={workspace}
        onExit={() => {}}
        onSubmit={async () => {
          submitted = true;
        }}
        getDefaultModel={() => "test-model"}
      />,
      { width, height },
    );
    try {
      await frame(setup);
      expect(setup.captureCharFrame()).toContain("Shift+Tab режим");
      expect(setup.captureCharFrame()).toContain("F4");
      await act(async () => {
        await setup.mockInput.pasteBracketedText("/bu");
        setup.mockInput.pressTab({ shift: true });
      });
      await frame(setup);
      expect(workspace.controller.snapshot.agentMode).toBe("plan");
      await act(async () => setup.mockInput.pressKey("F4"));
      await frame(setup);
      expect(workspace.controller.snapshot.approvalMode).toBe("acceptEdits");
      expect(workspace.controller.snapshot.agentMode).toBe("plan");
      const confirm =
        setup.renderer.root.findDescendantById("prompt-permissions");
      if (!confirm) throw new Error("Permission selector is missing");
      await act(async () => setup.mockMouse.click(confirm.x + 2, confirm.y));
      await frame(setup);
      expect(
        setup.renderer.root.findDescendantById("permissions-popup"),
      ).toBeTruthy();
      const manual = setup.renderer.root.findDescendantById(
        "permissions-mode-default",
      );
      if (!manual) throw new Error("Manual option is missing");
      await act(async () => setup.mockMouse.click(manual.x + 2, manual.y));
      await frame(setup);
      expect(workspace.controller.snapshot.approvalMode).toBe("default");
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("/bu");
      const automatic =
        setup.renderer.root.findDescendantById("prompt-permissions");
      if (!automatic) throw new Error("Auto option is missing");
      await act(async () =>
        setup.mockMouse.click(automatic.x + 2, automatic.y),
      );
      await frame(setup);
      const edits = setup.renderer.root.findDescendantById(
        "permissions-mode-acceptEdits",
      );
      if (!edits) throw new Error("Accept edits option is missing");
      await act(async () => setup.mockMouse.click(edits.x + 2, edits.y));
      await frame(setup);
      expect(workspace.controller.snapshot.approvalMode).toBe("acceptEdits");
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("/bu");
      expect(setup.captureCharFrame()).toContain("test-model");
      expect(submitted).toBe(false);
      const badge = setup.renderer.root.findDescendantById("prompt-agent-mode");
      if (!badge) throw new Error("Mode badge is missing");
      await act(async () => {
        await setup.mockMouse.click(badge.x + 2, badge.y);
      });
      await frame(setup);
      expect(workspace.controller.snapshot.agentMode).toBe("build");
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("/bu");
      expect(workspace.tabs).toHaveLength(0);
    } finally {
      act(() => {
        setup.renderer.destroy();
        workspace.dispose();
      });
    }
  });
}

test("mode commands stay local; modes belong to tabs, resume restores them and a new draft inherits the selection", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  const submitted: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      onExit={() => {}}
      onSubmit={async (input) => {
        submitted.push(input);
      }}
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    for (const [command, expected] of [
      ["/plan", "plan"],
      ["/build", "build"],
      ["/mode plan", "plan"],
    ]) {
      await act(async () => {
        await setup.mockInput.pasteBracketedText(command ?? "");
        setup.mockInput.pressEnter();
      });
      await frame(setup);
      expect(workspace.controller.snapshot.agentMode).toBe(expected);
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
    }
    expect(submitted).toEqual([]);
    expect(workspace.tabs).toHaveLength(0);
    for (const [command, expected] of [
      ["/auto", "acceptEdits"],
      ["/ask", "default"],
      ["/permissions auto", "acceptEdits"],
    ]) {
      await act(async () => {
        await setup.mockInput.pasteBracketedText(command ?? "");
        setup.mockInput.pressEnter();
      });
      await frame(setup);
      expect(workspace.controller.snapshot.approvalMode).toBe(expected);
      expect(workspace.controller.snapshot.agentMode).toBe("plan");
    }
    expect(submitted).toEqual([]);
    expect(workspace.tabs).toHaveLength(0);
    let firstKey: string | undefined;
    act(() => {
      workspace.newTab();
      firstKey = workspace.activeKey;
      workspace.controller.setAgentMode("build");
      workspace.newDraft();
    });
    await frame(setup);
    expect(workspace.home.snapshot.agentMode).toBe("build");
    expect(workspace.home.snapshot.approvalMode).toBe("acceptEdits");
    const session = createSession(process.cwd(), "anthropic", "test-model");
    session.mode = "plan";
    session.approvalMode = "default";
    act(() => {
      workspace.openSession(session);
    });
    await frame(setup);
    expect(workspace.controller.snapshot.agentMode).toBe("plan");
    expect(workspace.controller.snapshot.approvalMode).toBe("default");
    act(() => {
      workspace.select(firstKey);
    });
    await frame(setup);
    expect(workspace.controller.snapshot.agentMode).toBe("build");
    expect(workspace.controller.snapshot.approvalMode).toBe("acceptEdits");
    const legacy = createSession(process.cwd(), "anthropic", "test-model");
    act(() => {
      workspace.openSession(legacy);
    });
    await frame(setup);
    expect(workspace.controller.snapshot.agentMode).toBe("build");
  } finally {
    act(() => {
      setup.renderer.destroy();
      workspace.dispose();
    });
  }
});

test("Shift+Tab belongs to the open popup and does not change the agent mode", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      onExit={() => {}}
      skillsActions={{
        load: () => [],
        activeNames: () => [],
        toggle: () => {},
      }}
      settingsActions={{
        load: async () => ({
          values: { provider: "anthropic", model: "test-model" },
          hasKey: true,
        }),
        hasKey: async () => true,
        save: async () => "saved",
        check: async () => "ok",
        models: async () => ({ ok: true, models: [] }),
      }}
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    await act(async () => {
      await setup.mockInput.pasteBracketedText("Keep my draft");
    });
    for (const shortcut of ["s", "t"]) {
      await act(async () => {
        setup.mockInput.pressKey(shortcut, { ctrl: true });
      });
      await frame(setup);
      expect(workspace.controller.snapshot.focus).toBe("modal");
      await act(async () => {
        setup.mockInput.pressTab({ shift: true });
        setup.mockInput.pressKey("F4");
      });
      await frame(setup);
      expect(workspace.controller.snapshot.agentMode).toBe("build");
      expect(workspace.controller.snapshot.approvalMode).toBe("default");
      await act(async () => {
        setup.mockInput.pressEscape();
        await Bun.sleep(120);
      });
      await frame(setup);
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
        "Keep my draft",
      );
    }
  } finally {
    act(() => {
      setup.renderer.destroy();
      workspace.dispose();
    });
  }
});

test("a pending approval survives a screen remount and a second request cannot replace its decision", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  const resolver = createTuiApprovalResolver();
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      onExit={() => {}}
      approvalResolver={resolver}
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    let pending: Promise<string> | undefined;
    await act(async () => {
      pending = resolver.requestApproval({
        tool: "write_file",
        preview: "Original pending action",
      });
    });
    await frame(setup);
    // An asynchronous resume can complete after a background action asks for permission.
    act(() => workspace.newTab());
    await frame(setup);
    expect(
      setup.renderer.root.findDescendantById("approval-popup"),
    ).toBeTruthy();
    expect(setup.captureCharFrame()).toContain("Original pending action");
    expect(
      await resolver.requestApproval({
        tool: "run_shell",
        preview: "Second action",
      }),
    ).toBe("unavailable");
    expect(setup.captureCharFrame()).not.toContain("Second action");
    await act(async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(120);
    });
    expect(await pending).toBe("denied");
    await frame(setup);
    expect(
      setup.renderer.root.findDescendantById("approval-popup"),
    ).toBeFalsy();
  } finally {
    act(() => {
      resolver.dispose();
      setup.renderer.destroy();
      workspace.dispose();
    });
  }
});

test("approval shows every file in an atomic patch and scrolls beyond 200 lines", async () => {
  const resolver = createTuiApprovalResolver();
  const setup = await testRender(
    <OpenTuiSpike onExit={() => {}} approvalResolver={resolver} />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    const diffs = [
      buildFileDiff("first.txt", null, "first change\n"),
      buildFileDiff(
        "second.txt",
        null,
        Array.from({ length: 230 }, (_, i) => `change ${i}`).join("\n"),
      ),
    ];
    let pending: Promise<string> | undefined;
    await act(async () => {
      pending = resolver.requestApproval({
        tool: "apply_patch",
        preview: diffs.map((diff) => diff.patch).join("\n"),
        fileDiff: diffs[0],
        diffs,
      });
    });
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("файлов: 2");
    expect(setup.captureCharFrame()).toContain("first.txt");
    expect(setup.captureCharFrame()).toContain("second.txt");
    await act(async () => setup.mockInput.pressKey("END"));
    await frame(setup);
    expect(setup.captureCharFrame()).toContain("change 229");
    await act(async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(120);
    });
    expect(await pending).toBe("denied");
  } finally {
    act(() => {
      resolver.dispose();
      setup.renderer.destroy();
    });
  }
});

test("approval takes priority over skills, settings and session picker; Escape cannot approve a background action", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  const resolver = createTuiApprovalResolver();
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      onExit={() => {}}
      approvalResolver={resolver}
      skillsActions={{
        load: () => [],
        activeNames: () => [],
        toggle: () => {},
      }}
      settingsActions={{
        load: async () => ({
          values: { provider: "anthropic", model: "test-model" },
          hasKey: true,
        }),
        hasKey: async () => true,
        save: async () => "saved",
        check: async () => "ok",
        models: async () => ({ ok: true, models: [] }),
      }}
      sessionPicker={{
        load: async () => [],
        preview: async () =>
          createSession(process.cwd(), "anthropic", "test-model"),
        resume: async () => {},
        rename: async () => {},
        delete: async () => {},
        activeId: () => undefined,
      }}
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    for (const command of ["/skills", "/settings", "/sessions"]) {
      await act(async () => {
        await setup.mockInput.pasteBracketedText(command);
        setup.mockInput.pressEnter();
      });
      await frame(setup);
      expect(workspace.controller.snapshot.focus).toBe("modal");
      let pending: Promise<string> | undefined;
      await act(async () => {
        pending = resolver.requestApproval({
          tool: "run_shell",
          preview: "Background command",
        });
      });
      await frame(setup);
      expect(
        setup.renderer.root.findDescendantById("approval-popup"),
      ).toBeTruthy();
      expect(setup.captureCharFrame()).toContain("Background command");
      expect(
        setup.renderer.root.findDescendantById("settings-popup"),
      ).toBeFalsy();
      expect(
        setup.renderer.root.findDescendantById("skills-popup"),
      ).toBeFalsy();
      await act(async () => {
        setup.mockInput.pressEscape();
        await Bun.sleep(120);
      });
      expect(await pending).toBe("denied");
      await frame(setup);
      expect(workspace.controller.snapshot.focus).toBe("modal");
      await act(async () => {
        setup.mockInput.pressEscape();
        await Bun.sleep(120);
      });
      await frame(setup);
      expect(workspace.controller.snapshot.focus).toBe("composer");
    }
  } finally {
    act(() => {
      resolver.dispose();
      setup.renderer.destroy();
      workspace.dispose();
    });
  }
});

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
        (line) => line.includes("Build") && line.includes("↵"),
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

for (const [width, height] of [
  [40, 12],
  [80, 24],
]) {
  test(`approval popup supports mouse, preview scrolling and fail-closed dismissal at ${width}×${height}`, async () => {
    const workspace = new TuiWorkspace(process.cwd());
    const resolver = createTuiApprovalResolver();
    const setup = await testRender(
      <OpenTuiSpike
        workspace={workspace}
        onExit={() => {}}
        approvalResolver={resolver}
        getDefaultModel={() => "test-model"}
      />,
      { width, height },
    );
    try {
      await frame(setup);
      await act(async () =>
        setup.mockInput.pasteBracketedText("Keep my draft"),
      );
      for (const action of ["approve", "deny", "escape", "backdrop"] as const) {
        let pending: Promise<string> | undefined;
        await act(async () => {
          pending = resolver.requestApproval({
            tool: "write_file",
            preview: Array.from(
              { length: 60 },
              (_, i) => `preview line ${i}`,
            ).join("\n"),
          });
        });
        await frame(setup);
        const popup = setup.renderer.root.findDescendantById("approval-popup");
        expect(popup).toBeTruthy();
        expect((popup?.y ?? 0) + (popup?.height ?? 0)).toBeLessThanOrEqual(
          height,
        );
        await act(async () => {
          setup.mockInput.pressKey("F4");
          setup.mockInput.pressTab({ shift: true });
          setup.mockInput.pressKey("END");
        });
        await frame(setup);
        expect(workspace.controller.snapshot.approvalMode).toBe("default");
        expect(workspace.controller.snapshot.agentMode).toBe("build");
        expect(setup.captureCharFrame()).toContain("preview line 59");
        await act(async () => {
          if (action === "escape") {
            setup.mockInput.pressEscape();
            await Bun.sleep(120);
          } else if (action === "backdrop") await setup.mockMouse.click(0, 0);
          else {
            const button = setup.renderer.root.findDescendantById(
              `approval-${action}`,
            );
            if (!button) throw new Error("Approval button is missing");
            await setup.mockMouse.click(button.x + 2, button.y);
          }
        });
        expect(await pending).toBe(
          action === "approve" ? "approved" : "denied",
        );
        await frame(setup);
        expect(setup.renderer.currentFocusedEditor?.plainText).toBe(
          "Keep my draft",
        );
      }
    } finally {
      act(() => {
        resolver.dispose();
        setup.renderer.destroy();
        workspace.dispose();
      });
    }
  });
}

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
