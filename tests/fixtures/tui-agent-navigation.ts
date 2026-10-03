import { expect, mock } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import type { RunEventHandlers } from "../../src/app/run-prompt.js";
import type { RunOptions } from "../../src/commands/run.js";
import * as run from "../../src/commands/run.js";
import * as config from "../../src/config/load.js";
import type { AgentMode } from "../../src/runtime/agent-mode.js";
import {
  type ApprovalMode,
  resolveApprovalMode,
} from "../../src/security/approval-mode.js";
import * as projects from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { stripActiveSkillsBlock } from "../../src/skills/skills.js";
import type { Session } from "../../src/types/domain.js";

// This fixture runs in a child process so module mocks cannot affect other tests.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const setup = await createTestRenderer({
  width: 80,
  height: 24,
  exitOnCtrlC: false,
});
async function frame() {
  await act(async () => {
    await setup.renderOnce();
  });
}
async function waitForFrame(ready: () => boolean) {
  const caller = new Error().stack;
  for (let i = 0; i < 200; i++) {
    await act(async () => {
      await Bun.sleep(10);
      await setup.renderOnce();
    });
    if (ready()) return;
  }
  throw new Error(
    `Frame did not settle (calls: ${calls}):\n${setup.captureCharFrame()}\n${caller}`,
  );
}
mock.module("@opentui/core", () => ({
  ...core,
  createCliRenderer: async () => setup.renderer,
}));
let globalSaves = 0;
mock.module("../../src/config/load.js", () => ({
  ...config,
  loadGlobalConfig: async () => ({
    schemaVersion: 2,
    defaultProfileId: "anthropic-default",
    profiles: {
      "anthropic-default": {
        providerId: "anthropic",
        defaultModel: "test-model",
      },
      personal: {
        providerId: "openai",
        defaultModel: "other-model",
        baseUrl: "https://api.example.test/v1",
      },
    },
    providers: {},
  }),
  saveGlobalConfig: async () => {
    globalSaves++;
  },
}));
const storedModes: AgentMode[] = [];
const storedApprovals: ApprovalMode[] = [];
const storedModels: string[] = [];
mock.module("../../src/sessions/project-store.js", () => ({
  ...projects,
  projectSessionStore: async () => ({
    list: async () => [],
    setPreferences: async (
      _id: string,
      modes: { mode?: AgentMode; approvalMode?: ApprovalMode; model?: string },
    ) => {
      if (modes.mode) storedModes.push(modes.mode);
      if (modes.approvalMode) storedApprovals.push(modes.approvalMode);
      if (modes.model) storedModels.push(modes.model);
    },
  }),
  SessionProjectRegistry: class {
    async list() {
      return [];
    }
  },
}));
let releaseFirst: (() => void) | undefined;
let releaseSecond: (() => void) | undefined;
const sessions = new Map<string, Session>();
const signals: Array<AbortSignal | undefined> = [];
let calls = 0;
const prompts: string[] = [];
const modes: Array<AgentMode | undefined> = [];
const approvals: Array<ApprovalMode | undefined> = [];
const requestedModels: Array<string | undefined> = [];
const requestedConnections: RunOptions[] = [];
const catalogProfiles: Array<string | undefined> = [];
mock.module("../../src/commands/run.js", () => ({
  ...run,
  hasApiKey: async () => true,
  checkProviderConnection: async () => ({ ok: true }),
  listProviderModels: async (selection: { profileId?: string }) => {
    catalogProfiles.push(selection.profileId);
    return { ok: true, models: [] };
  },
  runPrompt: async (
    prompt: string,
    options: RunOptions,
    _approval: unknown,
    callbacks: RunEventHandlers,
    signal?: AbortSignal,
  ) => {
    calls++;
    prompts.push(prompt);
    modes.push(options.mode);
    approvals.push(resolveApprovalMode(options));
    requestedModels.push(options.model);
    requestedConnections.push({ ...options });
    signals.push(signal);
    const task = stripActiveSkillsBlock(prompt);
    const session =
      (options.resume ? sessions.get(options.resume) : undefined) ??
      createSession(
        options.cwd ?? process.cwd(),
        options.provider ?? "anthropic",
        options.model ?? "test-model",
      );
    sessions.set(session.id, session);
    await callbacks.onEvent?.({
      id: `saved-${calls}`,
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      type: "checkpoint_saved",
    });
    if (calls === 1) {
      callbacks.onText?.("Rejected partial prose");
      await callbacks.onEvent?.({
        id: "recovery",
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        type: "provider_response_recovery",
        errorCode: "invalid_tool_arguments",
      });
    }
    callbacks.onThinking?.("Internal reasoning must stay hidden");
    if (calls === 1)
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    if (task === "second task")
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
    if (task === "third task" || task === "parallel survivor")
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    callbacks.onText?.(`answer: ${task}`);
    session.title = task;
    session.profileId = options.profile ?? session.profileId;
    session.mode = options.mode;
    session.approvalMode = resolveApprovalMode(options);
    return {
      result: {
        session,
        text: `answer: ${task}`,
        status: signal?.aborted ? "cancelled" : "completed",
      },
    };
  },
}));
const { runOpenTuiAgent } = await import("../../src/ui/opentui-agent.js");
async function chooseModel(id: string, profileId?: string) {
  await act(async () => {
    await setup.mockInput.pasteBracketedText("/model");
    setup.mockInput.pressEnter();
  });
  await waitForFrame(
    () => !!setup.renderer.root.findDescendantById("models-search"),
  );
  if (profileId) {
    await act(async () => setup.mockInput.pressTab());
    await frame();
    await act(async () => {
      await setup.mockInput.pasteBracketedText(profileId);
      setup.mockInput.pressEnter();
    });
    await frame();
  }
  await act(async () => setup.mockInput.pressKey("n", { ctrl: true }));
  await frame();
  await act(async () => {
    setup.mockInput.pressKey("a", { ctrl: true });
    setup.mockInput.pressKey("k", { ctrl: true });
    await setup.mockInput.pasteBracketedText(id);
    setup.mockInput.pressEnter();
  });
  await waitForFrame(
    () => !setup.renderer.root.findDescendantById("models-popup"),
  );
}
let running: Promise<void> | undefined;
try {
  act(() => {
    running = runOpenTuiAgent({ cwd: process.cwd() });
  });
  await waitForFrame(() => !!setup.renderer.root.findDescendantById("welcome"));
  await frame();
  expect(setup.captureCharFrame()).toContain("ChiselCode");
  expect(setup.captureCharFrame()).toContain("Build");
  expect(setup.captureCharFrame()).toContain("test-model");
  expect(setup.captureCharFrame()).toContain("Shift+Tab режим");
  expect(setup.renderer.root.findDescendantById("session-tabs")).toBeFalsy();
  expect(setup.renderer.root.findDescendantById("welcome")).toBeTruthy();
  await act(async () => {
    setup.mockInput.pressKey("s", { ctrl: true });
  });
  await frame();
  expect(setup.captureCharFrame()).toContain("/code-review");
  await act(async () => {
    setup.mockInput.pressTab();
  });
  await frame();
  await act(async () => {
    setup.mockInput.pressEnter();
  });
  await frame();
  await act(async () => {
    setup.mockInput.pressEscape();
    await Bun.sleep(120);
  });
  await act(async () => {
    setup.mockInput.pressTab({ shift: true });
    await setup.mockInput.pasteBracketedText("first task");
    setup.mockInput.pressEnter();
  });
  expect(calls).toBe(1);
  expect(modes).toEqual(["plan"]);
  expect(approvals).toEqual(["default"]);
  expect(prompts[0]).toContain("code-review");
  await frame();
  expect(setup.renderer.root.findDescendantById("welcome")).toBeFalsy();
  expect(setup.captureCharFrame()).toContain("Думаю ·");
  expect(setup.captureCharFrame()).not.toContain("Internal reasoning");
  expect(setup.captureCharFrame()).not.toContain("Rejected partial prose");
  expect(setup.captureCharFrame()).not.toContain("Размышление");
  await act(async () => {
    setup.mockInput.pressTab({ shift: true });
    setup.mockInput.pressKey("F4");
  });
  await frame();
  expect(setup.captureCharFrame()).toContain("сейчас Plan");
  await act(async () => {
    setup.mockInput.pressKey("p", { ctrl: true });
  });
  expect(setup.renderer.currentFocusedEditor?.plainText).toBe("first task");
  await act(async () => {
    setup.mockInput.pressKey("n", { ctrl: true });
  });
  await act(async () => {
    setup.mockInput.pressKey("n", { meta: true });
  });
  await frame();
  expect(setup.renderer.root.findDescendantById("welcome")).toBeTruthy();
  expect(setup.captureCharFrame()).toContain("Build");
  expect(setup.captureCharFrame()).toContain("test-model");
  expect(approvals).toEqual(["default"]);
  expect(
    setup.renderer.root
      .findDescendantById("session-tabs")
      ?.getChildren()
      .filter((item) => item.id.startsWith("session-tab-")).length,
  ).toBe(1);
  await chooseModel("queued-model", "personal");
  await act(async () => {
    await setup.mockInput.pasteBracketedText("second task");
    setup.mockInput.pressEnter();
  });
  await waitForFrame(() => calls === 2);
  expect(
    setup.renderer.root
      .findDescendantById("session-tabs")
      ?.getChildren()
      .filter((item) => item.id.startsWith("session-tab-")).length,
  ).toBe(2);
  expect(setup.captureCharFrame()).toContain("Думаю ·");
  expect(setup.renderer.root.findDescendantById("request-status")).toBeTruthy();
  await act(async () => {
    await setup.mockInput.pasteBracketedText("second follow-up");
    setup.mockInput.pressEnter();
  });
  await waitForFrame(() => setup.captureCharFrame().includes("В очереди: 1"));
  expect(calls).toBe(2);
  expect(setup.captureCharFrame()).toContain("В очереди: 1 | Build");
  expect(setup.captureCharFrame()).toContain(
    "В очереди: 1 | Build | Accept edits",
  );
  await chooseModel("later-model", "anthropic-default");
  await act(async () => {
    setup.mockInput.pressTab({ shift: true });
    setup.mockInput.pressKey("F4");
  });
  await act(async () => {
    releaseSecond?.();
  });
  await waitForFrame(() =>
    setup.captureCharFrame().includes("answer: second follow-up"),
  );
  expect(calls).toBe(3);
  expect(prompts[1]).toBe("second task");
  expect(prompts[2]).toBe("second follow-up");
  expect(modes).toEqual(["plan", "build", "build"]);
  expect(approvals).toEqual(["default", "acceptEdits", "acceptEdits"]);
  expect(requestedModels).toEqual([
    "test-model",
    "queued-model",
    "queued-model",
  ]);
  expect(requestedConnections[2]?.resume).toBe([...sessions.keys()][1]);
  expect(signals[0]?.aborted).toBe(false);
  expect(requestedConnections[1]).toMatchObject({
    profile: "personal",
    provider: "openai",
    baseUrl: "https://api.example.test/v1",
  });
  expect(setup.captureCharFrame()).toContain("later-model");
  expect(setup.captureCharFrame()).toContain("Plan");
  expect(setup.captureCharFrame()).toContain("answer: second task");
  expect(setup.captureCharFrame()).toContain("Завершено за");
  expect(setup.renderer.root.findDescendantById("request-status")).toBeFalsy();
  expect(setup.captureCharFrame()).not.toContain("answer: first task");
  await chooseModel("idle-model");
  expect(storedModels).toContain("idle-model");
  expect(setup.captureCharFrame()).toContain("idle-model");
  await act(async () => releaseFirst?.());
  await act(async () => {
    setup.mockInput.pressKey("ARROW_LEFT", { meta: true });
  });
  await frame();
  expect(setup.captureCharFrame()).toContain("answer: first task");
  expect(setup.captureCharFrame()).not.toContain("answer: second task");
  await act(async () => {
    await setup.mockInput.pasteBracketedText("third task");
    setup.mockInput.pressEnter();
  });
  await waitForFrame(() => calls === 4);
  await act(async () => setup.mockInput.pressKey("F4"));
  await frame();
  await act(async () => {
    await setup.mockInput.pasteBracketedText("cancelled queued task");
    setup.mockInput.pressEnter();
  });
  await waitForFrame(() =>
    setup.captureCharFrame().includes("cancelled queued task"),
  );
  await act(async () =>
    setup.mockInput.pressKey("ARROW_RIGHT", { meta: true }),
  );
  await frame();
  await act(async () => {
    await setup.mockInput.pasteBracketedText("parallel survivor");
    setup.mockInput.pressEnter();
  });
  await waitForFrame(() => calls === 5);
  await act(async () => setup.mockInput.pressKey("ARROW_LEFT", { meta: true }));
  await frame();
  expect(setup.captureCharFrame()).toContain("Ctrl+C остановить");
  await act(async () => setup.mockInput.pressCtrlC());
  await waitForFrame(() => setup.captureCharFrame().includes("Остановлено"));
  expect(signals[3]?.aborted).toBe(true);
  expect(signals[4]?.aborted).toBe(false);
  expect(calls).toBe(5);
  expect(setup.captureCharFrame()).not.toContain("answer: third task");
  await act(async () => {
    await setup.mockInput.pasteBracketedText("after cancel");
    setup.mockInput.pressEnter();
  });
  await waitForFrame(() =>
    setup.captureCharFrame().includes("answer: after cancel"),
  );
  expect(calls).toBe(6);
  expect(requestedConnections[5]?.resume).toBe(requestedConnections[3]?.resume);
  await act(async () => {
    await setup.mockInput.pasteBracketedText("/exit");
    setup.mockInput.pressEnter();
  });
  await running;
  expect(calls).toBe(6);
  expect(signals[4]?.aborted).toBe(true);
  expect(storedApprovals).toContain("dontAsk");
  expect(storedModes).toContain("plan");
  expect(storedApprovals).toContain("acceptEdits");
  expect(globalSaves).toBe(0);
  expect(catalogProfiles).toEqual(["anthropic-default", "personal"]);
  process.stdout.write(
    "Parallel tabs, sequential follow-ups and independent cancellation verified\n",
  );
} finally {
  releaseFirst?.();
  releaseSecond?.();
  setup.renderer.destroy();
}
