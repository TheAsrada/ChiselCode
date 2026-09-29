import { expect, test } from "bun:test";
import { createSession } from "../../src/sessions/store.js";
import type { TuiTranscript } from "../../src/ui/tui-contract.js";
import { TuiController } from "../../src/ui/tui-controller.js";

test("controller delivers agent callbacks to a fake renderer and replays after replacement", () => {
  const calls: string[] = [];
  const fake: TuiTranscript = {
    append: (text) => calls.push(`append:${text}`),
    appendToLast: (text) => calls.push(`stream:${text}`),
    setToolActivity: (text) => calls.push(`activity:${text ?? ""}`),
    clear: () => calls.push("clear"),
  };
  const controller = new TuiController("/project");
  controller.bind(fake);
  controller.append("❯ task", "user");
  controller.appendToLast("hello ");
  controller.appendToLast("world");
  controller.setToolActivity("writing");
  controller.append("done", "success");
  expect(calls).toEqual([
    "append:❯ task",
    "stream:hello ",
    "stream:world",
    "activity:writing",
    "append:done",
  ]);
  expect(controller.snapshot.transcript.map((entry) => entry.text)).toEqual([
    "❯ task",
    "hello world",
    "done",
  ]);
  calls.length = 0;
  controller.bind(fake);
  expect(calls).toEqual([
    "clear",
    "append:❯ task",
    "append:hello world",
    "append:done",
    "activity:writing",
  ]);
  controller.dispose();
});

test("switching sessions clears stale data and invalidates asynchronous reads", () => {
  const controller = new TuiController("/old");
  let observed = 0;
  const stop = controller.subscribe(() => observed++);
  controller.setDraft("unfinished");
  controller.setFocus("sidebar");
  controller.setOverlay("approval");
  controller.append("old", "tool");
  const oldGeneration = controller.currentGeneration;
  controller.switchSession({ id: "new", projectPath: "/new" });
  expect(controller.isCurrent(oldGeneration)).toBe(false);
  expect(controller.snapshot).toMatchObject({
    sessionId: "new",
    projectPath: "/new",
    transcript: [],
    draft: "",
    focus: "composer",
  });
  expect(controller.snapshot.overlay).toBeUndefined();
  const oldSession = createSession("/old", "anthropic", "model");
  controller.setSessionUsage(oldSession);
  expect(controller.snapshot.usage).toBeUndefined();
  expect(observed).toBeGreaterThan(4);
  stop();
  controller.dispose();
});
