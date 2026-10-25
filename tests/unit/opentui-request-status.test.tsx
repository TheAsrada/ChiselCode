/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { RuntimeEvent } from "../../src/runtime/events.js";
import { THEMES } from "../../src/ui/appearance.js";
import type { MotionClock } from "../../src/ui/motion.js";
import { OpenTuiMotion, useMotion } from "../../src/ui/opentui-motion.js";
import { OpenTuiRequestStatus } from "../../src/ui/opentui-request-status.js";
import { requestActivity } from "../../src/ui/request-activity.js";
import { activityFrame } from "../../src/ui/request-activity-frame.js";
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
    expect(setup.captureCharFrame()).toMatch(/Думаю\s+· 0 с/);
    const row = setup.renderer.root.findDescendantById("request-status");
    now += 2000;
    await act(async () => {
      await Bun.sleep(1100);
    });
    await act(async () => {
      await setup.renderOnce();
      await setup.renderOnce();
    });
    expect(setup.captureCharFrame()).toMatch(/Думаю\s+· 2 с/);
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
    expect(remount.captureCharFrame()).toMatch(/Ожидаю подтверждения\s+· 5 с/);
  } finally {
    act(() => remount.renderer.destroy());
    controller.dispose();
  }
});

for (const theme of ["obsidian", "paper"] as const) {
  test(`spark animation, real tool states and reduced/paused clocks in ${theme}`, async () => {
    let now = 0;
    const controller = new TuiController(
      "/project",
      "build",
      "default",
      () => now,
    );
    controller.startRequest();
    let clock: MotionClock | undefined;
    let change: ((value: "full" | "reduced") => Promise<void>) | undefined;
    function Probe() {
      const motion = useMotion();
      clock = motion.clock;
      change = motion.change;
      return null;
    }
    const setup = await testRender(
      <OpenTuiMotion>
        <Probe />
        <OpenTuiRequestStatus
          controller={controller}
          palette={THEMES[theme]}
          width={80}
        />
      </OpenTuiMotion>,
      { width: 80, height: 8 },
    );
    const frame = () =>
      act(async () => {
        await setup.renderOnce();
      });
    const send = async (
      type: RuntimeEvent["type"],
      fields: Partial<RuntimeEvent> = {},
    ) => {
      await act(async () =>
        controller.trackToolEvent({
          id: "event",
          sessionId: "session",
          timestamp: new Date(0).toISOString(),
          type,
          ...fields,
        }),
      );
      await frame();
    };
    try {
      await frame();
      const node = setup.renderer.root.findDescendantById("request-status");
      const snapshot = controller.snapshot;
      const colors = new Set<string>();
      for (const offset of [200, 400, 700]) {
        await act(async () => {
          clock?.step(performance.now() + offset);
          await setup.renderOnce();
        });
        colors.add(
          JSON.stringify(
            setup
              .captureSpans()
              .lines.find((line) =>
                line.spans
                  .map((span) => span.text)
                  .join("")
                  .includes("Думаю"),
              )
              ?.spans.map((span) => [span.text, span.fg.toInts()]),
          ),
        );
        expect(setup.renderer.root.findDescendantById("request-status")).toBe(
          node,
        );
        expect(controller.snapshot).toBe(snapshot);
      }
      expect(colors.size).toBeGreaterThan(1);
      expect(setup.captureCharFrame()).toContain("<");
      await send("tool_started", { name: "read_file", invocationId: "a" });
      await send("tool_started", { name: "grep", invocationId: "b" });
      expect(setup.captureCharFrame()).toContain("Выполняю 2 действия");
      await send("tool_completed", { name: "grep", invocationId: "b" });
      expect(setup.captureCharFrame()).toContain("Читаю файлы");
      await act(async () => controller.setAwaitingApproval(true));
      await frame();
      expect(setup.captureCharFrame()).toContain("Ожидаю подтверждения");
      expect(clock?.activeTasks).toBe(0);
      await act(async () => controller.setAwaitingApproval(false));
      await act(async () => {
        await change?.("reduced");
      });
      await frame();
      expect(clock?.activeTasks).toBe(0);
      await act(async () => {
        await change?.("full");
      });
      await frame();
      expect(clock?.activeTasks).toBe(1);
      await send("provider_failed");
      expect(setup.captureCharFrame()).toContain("Ошибка запроса");
      expect(clock?.activeTasks).toBe(0);
      await send("provider_request_started");
      await send("tool_completed", { name: "read_file", invocationId: "a" });
      await send("provider_text_delta", { text: "Ответ" });
      expect(setup.captureCharFrame()).toContain("Отвечаю");
      await act(async () => controller.stopRequestActivity());
      await frame();
      expect(setup.captureCharFrame()).toContain("Останавливаю");
      expect(clock?.activeTasks).toBe(0);
      now = 2300;
      await act(async () => controller.finishRequest("cancelled"));
      await frame();
      expect(
        setup.renderer.root.findDescendantById("request-status"),
      ).toBeUndefined();
      expect(clock?.activeTasks).toBe(0);
    } finally {
      act(() => setup.renderer.destroy());
      controller.dispose();
    }
    expect(clock?.running).toBe(false);
  });
}

test("every status fits tiny widths and keeps text readable without motion", () => {
  for (const width of [1, 3, 10, 17, 23, 39, 79]) {
    for (const kind of [
      "thinking",
      "reading",
      "editing",
      "approval",
      "checking",
      "stopping",
    ] as const) {
      const text = activityFrame({
        activity: requestActivity(kind),
        palette: THEMES.obsidian,
        width,
        enabled: false,
      });
      expect(
        text.chunks.map((chunk) => chunk.text).join("").length,
      ).toBeLessThanOrEqual(width);
    }
  }
});

test("destroying a running request releases its clock without a completion event", async () => {
  const controller = new TuiController("/project");
  controller.startRequest();
  let clock: MotionClock | undefined;
  function Probe() {
    clock = useMotion().clock;
    return null;
  }
  const setup = await testRender(
    <OpenTuiMotion>
      <Probe />
      <OpenTuiRequestStatus
        controller={controller}
        palette={THEMES.obsidian}
        width={40}
      />
    </OpenTuiMotion>,
    { width: 40, height: 8 },
  );
  await act(async () => {
    await setup.renderOnce();
  });
  expect(clock?.activeTasks).toBe(1);
  act(() => setup.renderer.destroy());
  expect(clock?.activeTasks).toBe(0);
  expect(clock?.running).toBe(false);
  controller.dispose();
});
