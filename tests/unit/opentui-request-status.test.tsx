/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { THEMES } from "../../src/ui/appearance.js";
import { OpenTuiRequestStatus } from "../../src/ui/opentui-request-status.js";
import { TuiController } from "../../src/ui/tui-controller.js";

test("live status ticks without remounting its row and uses the controller clock after remount", async () => {
  let now = 10_000;
  const controller = new TuiController(
    "/project",
    "build",
    "default",
    () => now,
  );
  controller.startRequest();
  const setup = await testRender(
    <OpenTuiRequestStatus
      controller={controller}
      palette={THEMES.graphite}
      width={40}
    />,
    { width: 40, height: 12 },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("Думаю · 0 с");
    const row = setup.renderer.root.findDescendantById("request-status");
    now += 2000;
    await act(async () => {
      await Bun.sleep(1100);
    });
    await act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toContain("Думаю · 2 с");
    expect(setup.renderer.root.findDescendantById("request-status")).toBe(row);
  } finally {
    act(() => setup.renderer.destroy());
  }
  now += 3000;
  const remount = await testRender(
    <OpenTuiRequestStatus
      controller={controller}
      palette={THEMES.graphite}
      width={40}
      awaitingApproval
    />,
    { width: 40, height: 12 },
  );
  try {
    await act(async () => {
      await remount.renderOnce();
    });
    expect(remount.captureCharFrame()).toContain("Ожидаю подтверждения · 5 с");
  } finally {
    act(() => remount.renderer.destroy());
    controller.dispose();
  }
});
