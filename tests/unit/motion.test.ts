import { expect, test } from "bun:test";
import { GlobalConfigV2Schema } from "../../src/config/schema.js";
import { MotionClock } from "../../src/ui/motion.js";

test("motion clock stops when idle, respects cancellation within a frame and refuses work after disposal", () => {
  const clock = new MotionClock();
  let cancelledCalls = 0;
  let remove = () => {};
  clock.add(() => {
    remove();
    return false;
  });
  remove = clock.add(() => {
    cancelledCalls++;
    return true;
  });
  expect(clock.running).toBe(true);
  clock.step(100);
  expect(cancelledCalls).toBe(0);
  expect(clock.activeTasks).toBe(0);
  expect(clock.running).toBe(false);
  clock.add(() => true);
  clock.dispose();
  clock.add(() => {
    throw Error("Disposed renderer must not repaint");
  });
  clock.step(200);
  expect(clock.activeTasks).toBe(0);
  expect(clock.running).toBe(false);
});

test("motion preferences reject invalid values and preserve theme, accent and future settings", () => {
  for (const motion of ["full", "reduced"] as const) {
    const ui = {
      motion,
      theme: "paper",
      accent: "#405fb6",
      future: "retained",
    };
    expect(
      GlobalConfigV2Schema.parse({ schemaVersion: 2, profiles: {}, ui }).ui,
    ).toEqual(ui);
  }
  expect(
    GlobalConfigV2Schema.safeParse({
      schemaVersion: 2,
      profiles: {},
      ui: { motion: "fastest" },
    }).success,
  ).toBe(false);
});
