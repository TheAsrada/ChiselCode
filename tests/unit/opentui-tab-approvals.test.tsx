/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { OpenTuiSpike } from "../../src/ui/opentui-spike.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

for (const [width, height] of [
  [80, 24],
  [120, 36],
]) {
  test(`tab switching displays only the selected approval and Ctrl+C cancels its owner at ${width}x${height}`, async () => {
    const workspace = new TuiWorkspace(process.cwd());
    const first = workspace.newTab();
    first.setSessionTitle("First tab");
    first.startRequest();
    const second = workspace.newTab();
    second.setSessionTitle("Second tab");
    second.startRequest();
    const a = workspace.execution(first);
    const b = workspace.execution(second);
    a.abort = new AbortController();
    b.abort = new AbortController();
    const setup = await testRender(
      <OpenTuiSpike
        workspace={workspace}
        onExit={() => {}}
        onCancel={() => workspace.execution().cancel()}
      />,
      { width, height, exitOnCtrlC: false },
    );
    async function frame() {
      await act(async () => {
        await setup.renderOnce();
      });
      await act(async () => {
        await setup.renderOnce();
      });
    }
    const firstRequest = { tool: "write_file", preview: "FIRST ONLY" };
    const secondRequest = { tool: "run_shell", preview: "SECOND ONLY" };
    let firstPending!: ReturnType<typeof a.approvalResolver.requestApproval>;
    let secondPending!: typeof firstPending;
    try {
      await frame();
      await act(async () => {
        firstPending = a.approvalResolver.requestApproval(firstRequest);
        secondPending = b.approvalResolver.requestApproval(secondRequest);
      });
      await frame();
      expect(setup.captureCharFrame()).toContain("SECOND ONLY");
      expect(setup.captureCharFrame()).not.toContain("FIRST ONLY");
      await act(async () =>
        setup.mockInput.pressKey("ARROW_LEFT", { meta: true }),
      );
      await frame();
      expect(workspace.controller).toBe(first);
      expect(setup.captureCharFrame()).toContain("FIRST ONLY");
      expect(setup.captureCharFrame()).not.toContain("SECOND ONLY");
      await act(async () => setup.mockInput.pressKey("y", { ctrl: true }));
      expect(first.snapshot.awaitingApproval).toBe(true);
      await act(async () => setup.mockInput.pressKey("y"));
      expect(await firstPending).toBe("approved");
      expect(second.snapshot.awaitingApproval).toBe(true);
      await act(async () =>
        setup.mockInput.pressKey("ARROW_RIGHT", { meta: true }),
      );
      await frame();
      expect(setup.captureCharFrame()).toContain("SECOND ONLY");
      await act(async () => setup.mockInput.pressCtrlC());
      expect(await secondPending).toBe("unavailable");
      expect(b.abort.signal.aborted).toBe(true);
      expect(a.abort.signal.aborted).toBe(false);
      await frame();
      expect(
        setup.renderer.root.findDescendantById("approval-popup"),
      ).toBeFalsy();
      let nextPending!: typeof firstPending;
      await act(async () => {
        nextPending = b.approvalResolver.requestApproval(secondRequest);
      });
      await frame();
      await act(async () => {
        setup.mockInput.pressEscape();
        await Bun.sleep(120);
      });
      expect(second.snapshot.awaitingApproval).toBe(false);
      expect(await nextPending).toBe("denied");
      expect(first.snapshot.awaitingApproval).toBe(false);
      expect(second.snapshot.awaitingApproval).toBe(false);
    } finally {
      act(() => {
        setup.renderer.destroy();
        workspace.dispose();
      });
    }
  });
}
