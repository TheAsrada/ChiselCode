import { expect, mock } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import type { RunOptions } from "../../src/commands/run.js";
import * as run from "../../src/commands/run.js";
import * as config from "../../src/config/load.js";
import type { AgentEventHandlers } from "../../src/core/agent-loop.js";
import type { AgentMode } from "../../src/runtime/agent-mode.js";
import * as projects from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { stripActiveSkillsBlock } from "../../src/skills/skills.js";

// This fixture runs in a child process so module mocks cannot affect other tests.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const setup = await createTestRenderer({ width: 80, height: 24 });
async function frame() {
  await act(async () => {
    await setup.renderOnce();
  });
}
async function waitForFrame(ready: () => boolean) {
  for (let i = 0; i < 200; i++) {
    await act(async () => {
      await Bun.sleep(10);
      await setup.renderOnce();
    });
    if (ready()) return;
  }
  throw new Error(`Frame did not settle:\n${setup.captureCharFrame()}`);
}
mock.module("@opentui/core", () => ({
  ...core,
  createCliRenderer: async () => setup.renderer,
}));
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
    },
    providers: {},
  }),
  saveGlobalConfig: async () => {},
}));
const storedModes: AgentMode[] = [];
mock.module("../../src/sessions/project-store.js", () => ({
  ...projects,
  projectSessionStore: async () => ({
    list: async () => [],
    setMode: async (_id: string, mode: AgentMode) => {
      storedModes.push(mode);
    },
  }),
  SessionProjectRegistry: class {
    async list() {
      return [];
    }
  },
}));
let releaseFirst: (() => void) | undefined;
let calls = 0;
const prompts: string[] = [];
const modes: Array<AgentMode | undefined> = [];
mock.module("../../src/commands/run.js", () => ({
  ...run,
  hasApiKey: async () => true,
  checkProviderConnection: async () => ({ ok: true }),
  listProviderModels: async () => ({ ok: true, models: [] }),
  runPrompt: async (
    prompt: string,
    options: RunOptions,
    _approval: unknown,
    callbacks: AgentEventHandlers,
  ) => {
    calls++;
    prompts.push(prompt);
    modes.push(options.mode);
    const task = stripActiveSkillsBlock(prompt);
    if (calls === 1)
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    callbacks.onText?.(`answer: ${task}`);
    const session = createSession(
      options.cwd ?? process.cwd(),
      "anthropic",
      "test-model",
    );
    session.title = task;
    session.mode = options.mode;
    return { result: { session, text: `answer: ${task}` } };
  },
}));
const { runOpenTuiAgent } = await import("../../src/ui/opentui-agent.js");
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
  expect(prompts[0]).toContain("code-review");
  await frame();
  expect(setup.renderer.root.findDescendantById("welcome")).toBeFalsy();
  await act(async () => {
    setup.mockInput.pressTab({ shift: true });
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
  expect(
    setup.renderer.root
      .findDescendantById("session-tabs")
      ?.getChildren()
      .filter((item) => item.id.startsWith("session-tab-")).length,
  ).toBe(1);
  await act(async () => {
    await setup.mockInput.pasteBracketedText("second task");
    setup.mockInput.pressEnter();
  });
  expect(calls).toBe(1);
  await waitForFrame(() => setup.captureCharFrame().includes("В очереди: 1"));
  expect(
    setup.renderer.root
      .findDescendantById("session-tabs")
      ?.getChildren()
      .filter((item) => item.id.startsWith("session-tab-")).length,
  ).toBe(2);
  expect(setup.captureCharFrame()).toContain("В очереди: 1");
  await act(async () => {
    setup.mockInput.pressTab({ shift: true });
  });
  await act(async () => {
    releaseFirst?.();
  });
  await waitForFrame(() =>
    setup.captureCharFrame().includes("answer: second task"),
  );
  expect(calls).toBe(2);
  expect(prompts[1]).toBe("second task");
  expect(modes).toEqual(["plan", "build"]);
  expect(setup.captureCharFrame()).toContain("Plan");
  expect(setup.captureCharFrame()).toContain("answer: second task");
  expect(setup.captureCharFrame()).not.toContain("answer: first task");
  await act(async () => {
    setup.mockInput.pressKey("ARROW_LEFT", { meta: true });
  });
  await frame();
  expect(setup.captureCharFrame()).toContain("answer: first task");
  expect(setup.captureCharFrame()).not.toContain("answer: second task");
  await act(async () => {
    setup.mockInput.pressCtrlC();
  });
  await running;
  expect(storedModes).toContain("plan");
  process.stdout.write("Agent navigation and queued output verified\n");
} finally {
  setup.renderer.destroy();
}
