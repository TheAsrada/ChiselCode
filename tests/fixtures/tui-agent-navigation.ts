import { expect, mock } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import type { RunOptions } from "../../src/commands/run.js";
import * as run from "../../src/commands/run.js";
import * as config from "../../src/config/load.js";
import type { AgentEventHandlers } from "../../src/core/agent-loop.js";
import * as projects from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";

// This fixture runs in a child process so module mocks cannot affect other tests.
const setup = await createTestRenderer({ width: 80, height: 24 });
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
mock.module("../../src/sessions/project-store.js", () => ({
  ...projects,
  projectSessionStore: async () => ({ list: async () => [] }),
  SessionProjectRegistry: class {
    async list() {
      return [];
    }
  },
}));
let releaseFirst: (() => void) | undefined;
let calls = 0;
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
    if (calls === 1)
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    callbacks.onText?.(`answer: ${prompt}`);
    const session = createSession(
      options.cwd ?? process.cwd(),
      "anthropic",
      "test-model",
    );
    session.title = prompt;
    return { result: { session, text: `answer: ${prompt}` } };
  },
}));
const { runOpenTuiAgent } = await import("../../src/ui/opentui-agent.js");
let running: Promise<void> | undefined;
try {
  await act(async () => {
    running = runOpenTuiAgent({ cwd: process.cwd() });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("ChiselCode");
  await act(async () => {
    await setup.mockInput.pasteBracketedText("first task");
    setup.mockInput.pressEnter();
  });
  expect(calls).toBe(1);
  await act(async () => {
    setup.mockInput.pressKey("n", { meta: true });
  });
  await setup.renderOnce();
  await act(async () => {
    await setup.mockInput.pasteBracketedText("second task");
    setup.mockInput.pressEnter();
  });
  expect(calls).toBe(1);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("В очереди: 1");
  await act(async () => {
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await setup.renderOnce();
  expect(calls).toBe(2);
  expect(setup.captureCharFrame()).toContain("answer: second task");
  expect(setup.captureCharFrame()).not.toContain("answer: first task");
  await act(async () => {
    setup.mockInput.pressKey("ARROW_LEFT", { meta: true });
  });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("answer: first task");
  expect(setup.captureCharFrame()).not.toContain("answer: second task");
  await act(async () => {
    setup.mockInput.pressCtrlC();
  });
  await running;
  process.stdout.write("Agent navigation and queued output verified\n");
} finally {
  setup.renderer.destroy();
}
