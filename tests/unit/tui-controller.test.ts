import { expect, test } from "bun:test";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { attachSessionRecorder } from "../../src/sessions/checkpoints.js";
import { createSession } from "../../src/sessions/store.js";
import { subagentDescriptor } from "../../src/subagents/service.js";
import type { TuiTranscript } from "../../src/ui/tui-contract.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";
import { childFixture } from "../helpers/subagent.js";

test("request timing excludes the queue, flushes the answer and completes only once", () => {
  let now = 0;
  const controller = new TuiController(
    "/project",
    "build",
    "default",
    () => now,
  );
  controller.setBusy(true);
  now = 10_000;
  expect(controller.snapshot.requestStartedAt).toBeUndefined();
  expect(controller.requestElapsedMs).toBe(0);
  controller.startRequest();
  controller.appendToLast("Привет!\n\nЯ помогу.");
  now = 12_345;
  expect(controller.requestElapsedMs).toBe(2345);
  controller.finishRequest("completed");
  controller.finishRequest("completed");
  expect(controller.snapshot.transcript.map((entry) => entry.text)).toEqual([
    "Привет!\n\nЯ помогу.",
    "Завершено за 2,3 с",
  ]);
  expect(controller.snapshot.streaming).toBe("");
  expect(controller.snapshot.requestStartedAt).toBeUndefined();
  controller.startRequest();
  now += 1000;
  controller.finishRequest("failed");
  expect(controller.snapshot.transcript.at(-1)?.text).toBe(
    "Завершено с ошибкой · 1 с",
  );
  controller.startRequest();
  controller.finishRequest("approval_required", 2500);
  expect(controller.snapshot.transcript.at(-1)?.text).toBe(
    "Нужно подтверждение · 2,5 с",
  );
  controller.startRequest();
  controller.finishRequest("cancelled", 500);
  expect(controller.snapshot.transcript.at(-1)?.text).toBe(
    "Остановлено · 0,5 с",
  );
  controller.dispose();
});

test("request timing follows its tab and is invalidated on session replacement", () => {
  const workspace = new TuiWorkspace("/project");
  const tab = workspace.newTab();
  tab.startRequest();
  const startedAt = tab.snapshot.requestStartedAt;
  workspace.newDraft();
  expect(workspace.controller.snapshot.requestStartedAt).toBeUndefined();
  workspace.select(workspace.tabs[0]?.key);
  expect(workspace.controller.snapshot.requestStartedAt).toBe(startedAt);
  tab.switchSession(undefined);
  tab.finishRequest("completed");
  expect(tab.snapshot.transcript).toHaveLength(0);
  workspace.dispose();
});

test("selected model exists before a session, survives old request completion and passes to new drafts", () => {
  const workspace = new TuiWorkspace("/project");
  workspace.home.setActiveModel("openai", "next-model", "work");
  expect(workspace.home.snapshot.usage).toBeUndefined();
  const tab = workspace.newTab();
  const session = createSession("/project", "anthropic", "old-model");
  session.totalTokens.inputTokens = 42;
  session.contextSnapshot = {
    model: "old-model",
    observedInputTokens: 42,
    observedAt: new Date().toISOString(),
    source: "provider_usage",
    status: "observed",
  };
  tab.setSessionUsage(session);
  expect(tab.snapshot.modelSelection).toMatchObject({
    provider: "openai",
    model: "next-model",
    profileId: "work",
  });
  expect(tab.snapshot.usage).toMatchObject({
    model: "next-model",
    totalTokens: { inputTokens: 42 },
  });
  expect(tab.snapshot.usage?.contextSnapshot).toBeUndefined();
  workspace.newDraft();
  expect(workspace.home.snapshot.modelSelection).toEqual(
    tab.snapshot.modelSelection,
  );
  workspace.openSession({ ...session, id: "other" });
  expect(workspace.controller.snapshot.modelSelection?.model).toBe("old-model");
  workspace.dispose();
});

test("live usage merges with a child receipt in the originating tab only", async () => {
  const workspace = new TuiWorkspace("/project");
  try {
    const session = createSession("/project", "openai", "model");
    const owner = workspace.openSession(session);
    const child = childFixture(session.id, session.projectPath);
    owner.acceptSubagent({
      type: "changed",
      ownerId: session.id,
      child: subagentDescriptor({
        ...child,
        spend: { ...child.spend, usage: { inputTokens: 40, outputTokens: 5 } },
      }),
    });
    const other = createSession("/project", "openai", "model");
    const visible = workspace.openSession(other);
    const events = new RuntimeEventBus(session.id);
    attachSessionRecorder(session, events, (updated) => {
      owner.setSessionUsage(updated);
      visible.setSessionUsage(updated); // Session ID rejects a misrouted snapshot.
    });

    await events.emit({
      type: "provider_turn_completed",
      usage: { inputTokens: 100, outputTokens: 15, cacheReadTokens: 0 },
      message: { role: "assistant", content: [{ type: "text", text: "OK" }] },
    });
    expect(workspace.controller).toBe(visible);
    expect(visible.snapshot.usage?.totalTokens).toEqual(other.totalTokens);
    const total = { inputTokens: 140, outputTokens: 20, cacheReadTokens: 0 };
    expect(owner.snapshot.usage?.totalTokens).toEqual(total);
    owner.setSessionUsage(session);
    expect(owner.snapshot.usage?.totalTokens).toEqual(total);
    expect(session.totalTokens.inputTokens).toBe(100);
  } finally {
    workspace.dispose();
  }
});

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
