/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createSession } from "../../src/sessions/store.js";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { createTuiApprovalResolver } from "../../src/ui/tui-contract.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

type Setup = Awaited<ReturnType<typeof testRender>>;
async function frame(setup: Setup) {
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
}
async function click(setup: Setup, id: string) {
  const target = setup.renderer.root.findDescendantById(id);
  if (!target) throw new Error(`Missing ${id}`);
  await act(async () => setup.mockMouse.click(target.x + 1, target.y));
  await frame(setup);
}
async function command(setup: Setup, text: string) {
  await act(async () => {
    await setup.mockInput.pasteBracketedText(text);
    setup.mockInput.pressEnter();
  });
  await frame(setup);
}

for (const [width, height] of [
  [40, 12],
  [80, 24],
  [120, 36],
]) {
  test(`Bypass availability gates picker, commands and F4 and disabling resets tabs at ${width}×${height}`, async () => {
    const workspace = new TuiWorkspace(process.cwd());
    const saved: boolean[] = [];
    let failSave = false;
    const setup = await testRender(
      <OpenTuiSpike
        workspace={workspace}
        onExit={() => {}}
        getDefaultModel={() => "test-model"}
        onBypassAvailabilityChange={async (allowed) => {
          if (failSave) throw new Error("Cannot save settings");
          saved.push(allowed);
        }}
      />,
      { width, height },
    );
    try {
      await frame(setup);
      await command(setup, "/permissions bypassPermissions");
      expect(workspace.controller.snapshot.approvalMode).toBe("default");
      expect(saved).toEqual([]);
      for (const expected of ["acceptEdits", "dontAsk", "default"]) {
        await act(async () => setup.mockInput.pressKey("F4"));
        await frame(setup);
        expect(workspace.controller.snapshot.approvalMode).toBe(expected);
      }
      await act(async () => setup.mockInput.pasteBracketedText("draft"));
      await frame(setup);
      await click(setup, "prompt-permissions");
      expect(
        setup.renderer.root.findDescendantById(
          "permissions-mode-bypassPermissions",
        ),
      ).toBeFalsy();
      await click(setup, "permissions-settings");
      expect(
        setup.renderer.root.findDescendantById("settings-bypass-toggle"),
      ).toBeTruthy();
      expect(setup.captureCharFrame()).toContain("Доступ к Bypass");
      failSave = true;
      await click(setup, "settings-bypass-toggle");
      expect(setup.captureCharFrame()).toContain("Cannot save settings");
      failSave = false;
      await click(setup, "settings-bypass-toggle");
      expect(saved).toEqual([true]);
      expect(workspace.controller.snapshot.approvalMode).toBe("default");
      await click(setup, "settings-close");
      expect(setup.renderer.currentFocusedEditor?.plainText).toBe("draft");
      await click(setup, "prompt-permissions");
      const bypass = setup.renderer.root.findDescendantById(
        "permissions-mode-bypassPermissions",
      );
      expect(bypass).toBeTruthy();
      if (!bypass) throw new Error("Bypass option is missing");
      expect(bypass.y).toBeGreaterThanOrEqual(0);
      expect(bypass.y + bypass.height).toBeLessThanOrEqual(height);
      await click(setup, "permissions-mode-bypassPermissions");
      expect(workspace.controller.snapshot.approvalMode).toBe(
        "bypassPermissions",
      );
      const session = createSession(process.cwd(), "anthropic", "test-model");
      session.approvalMode = "bypassPermissions";
      act(() => {
        workspace.openSession(session);
        workspace.select();
      });
      await frame(setup);
      await click(setup, "prompt-permissions");
      await click(setup, "permissions-settings");
      await click(setup, "settings-bypass-toggle");
      expect(saved).toEqual([true, false]);
      expect(workspace.home.snapshot.approvalMode).toBe("default");
      expect(workspace.tabs[0]?.controller.snapshot.approvalMode).toBe(
        "default",
      );
      await click(setup, "settings-close");
      await click(setup, "prompt-permissions");
      expect(
        setup.renderer.root.findDescendantById(
          "permissions-mode-bypassPermissions",
        ),
      ).toBeFalsy();
    } finally {
      act(() => {
        setup.renderer.destroy();
        workspace.dispose();
      });
    }
  });
}

test("/permissions stays local, keyboard selects a mode and an approval temporarily takes priority", async () => {
  const workspace = new TuiWorkspace(process.cwd());
  const resolver = createTuiApprovalResolver();
  const prompts: string[] = [];
  const setup = await testRender(
    <OpenTuiSpike
      workspace={workspace}
      approvalResolver={resolver}
      onExit={() => {}}
      onSubmit={async (text) => {
        prompts.push(text);
      }}
    />,
    { width: 80, height: 24 },
  );
  try {
    await frame(setup);
    await command(setup, "/permissions");
    expect(
      setup.renderer.root.findDescendantById("permissions-popup"),
    ).toBeTruthy();
    let answer: Promise<string> | undefined;
    act(() => {
      answer = resolver.requestApproval({
        tool: "write_file",
        preview: "pending",
      });
    });
    await frame(setup);
    expect(
      setup.renderer.root.findDescendantById("permissions-popup"),
    ).toBeFalsy();
    await act(async () => {
      setup.mockInput.pressEscape();
      await Bun.sleep(120);
    });
    expect(await answer).toBe("denied");
    await frame(setup);
    await act(async () => {
      setup.mockInput.pressKey("ARROW_DOWN");
      setup.mockInput.pressEnter();
    });
    await frame(setup);
    expect(workspace.controller.snapshot.approvalMode).toBe("acceptEdits");
    expect(workspace.controller.snapshot.agentMode).toBe("build");
    expect(prompts).toEqual([]);
    expect(setup.renderer.currentFocusedEditor?.plainText).toBe("");
  } finally {
    act(() => {
      resolver.dispose();
      setup.renderer.destroy();
      workspace.dispose();
    });
  }
});
