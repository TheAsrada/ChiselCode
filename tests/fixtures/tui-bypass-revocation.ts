import { expect, mock } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import type { RunOptions } from "../../src/commands/run.js";
import * as run from "../../src/commands/run.js";
import * as config from "../../src/config/load.js";
import * as projects from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import type { GlobalConfig } from "../../src/types/domain.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const setup = await createTestRenderer({
  width: 80,
  height: 24,
  exitOnCtrlC: false,
});
async function frame() {
  await act(async () => {
    await setup.renderOnce();
    await setup.renderOnce();
  });
}
async function settled(ready: () => boolean) {
  for (let i = 0; i < 200; i++) {
    await act(async () => {
      await Bun.sleep(10);
      await setup.renderOnce();
    });
    if (ready()) return;
  }
  throw new Error(`Frame did not settle:\n${setup.captureCharFrame()}`);
}
async function click(id: string) {
  const target = setup.renderer.root.findDescendantById(id);
  if (!target) throw new Error(`Missing ${id}`);
  await act(async () => setup.mockMouse.click(target.x + 1, target.y));
  await frame();
}
async function command(text: string) {
  await act(async () => {
    await setup.mockInput.pasteBracketedText(text);
    setup.mockInput.pressEnter();
  });
  await frame();
}
mock.module("@opentui/core", () => ({
  ...core,
  createCliRenderer: async () => setup.renderer,
}));
let current: GlobalConfig = {
  schemaVersion: 2,
  defaultProfileId: "work",
  profiles: { work: { providerId: "anthropic", defaultModel: "test-model" } },
  providers: {},
};
const settingsSaves: boolean[] = [];
mock.module("../../src/config/load.js", () => ({
  ...config,
  loadGlobalConfig: async () => structuredClone(current),
  saveGlobalConfig: async (next: GlobalConfig) => {
    current = structuredClone(next);
    settingsSaves.push(next.permissions?.allowBypassPermissions === true);
  },
}));
const storedModes: string[] = [];
mock.module("../../src/sessions/project-store.js", () => ({
  ...projects,
  projectSessionStore: async () => ({
    setPreferences: async (_id: string, values: { approvalMode?: string }) => {
      if (values.approvalMode) storedModes.push(values.approvalMode);
    },
  }),
}));
const requests: RunOptions[] = [];
let release: (() => void) | undefined;
let releaseOther: (() => void) | undefined;
mock.module("../../src/commands/run.js", () => ({
  ...run,
  hasApiKey: async () => true,
  runPrompt: async (prompt: string, options: RunOptions) => {
    requests.push(options);
    if (prompt === "first task")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (prompt === "other tab task")
      await new Promise<void>((resolve) => {
        releaseOther = resolve;
      });
    const session = createSession(
      options.cwd ?? process.cwd(),
      "anthropic",
      "test-model",
    );
    session.profileId = "work";
    session.approvalMode =
      options.approvalMode === "bypassPermissions"
        ? "bypassPermissions"
        : "default";
    return {
      result: { session, text: `answer: ${prompt}`, status: "completed" },
    };
  },
}));
const { runOpenTuiAgent } = await import("../../src/ui/opentui-agent.js");
const running = runOpenTuiAgent({});
try {
  await settled(() => !!setup.renderer.currentFocusedEditor);
  await act(async () => setup.mockInput.pressKey("\u001b[44;5u"));
  await settled(
    () => !!setup.renderer.root.findDescendantById("settings-permissions"),
  );
  await click("settings-permissions");
  await settled(
    () => !!setup.renderer.root.findDescendantById("settings-bypass-toggle"),
  );
  await click("settings-bypass-toggle");
  await settled(() => current.permissions?.allowBypassPermissions === true);
  await click("settings-close");
  await command("/permissions bypassPermissions");
  await command("first task");
  await settled(() => requests.length === 1);
  expect(requests[0]?.approvalMode).toBe("bypassPermissions");
  expect(requests[0]?.isBypassAllowed?.()).toBe(true);
  await command("queued task");
  await settled(() => setup.captureCharFrame().includes("В очереди: 1"));
  expect(requests).toHaveLength(1);
  await command("/new");
  await command("other tab task");
  await settled(() => requests.length === 2);
  expect(requests[1]?.approvalMode).toBe("bypassPermissions");
  await command("other queued task");
  await settled(() => setup.captureCharFrame().includes("В очереди: 1"));
  expect(requests).toHaveLength(2);
  await act(async () => setup.mockInput.pressKey("\u001b[44;5u"));
  await settled(
    () => !!setup.renderer.root.findDescendantById("settings-permissions"),
  );
  await click("settings-permissions");
  await click("settings-bypass-toggle");
  await settled(() => current.permissions?.allowBypassPermissions === false);
  expect(requests[0]?.isBypassAllowed?.()).toBe(false);
  expect(requests[1]?.isBypassAllowed?.()).toBe(false);
  await click("settings-close");
  await act(async () => releaseOther?.());
  await settled(
    () =>
      requests.length === 3 &&
      setup.captureCharFrame().includes("answer: other queued task"),
  );
  expect(requests[2]?.approvalMode).toBe("default");
  expect(requests[2]?.isBypassAllowed?.()).toBe(false);
  await act(async () => setup.mockInput.pressKey("ARROW_LEFT", { meta: true }));
  await frame();
  await act(async () => release?.());
  await settled(
    () =>
      requests.length === 4 &&
      setup.captureCharFrame().includes("answer: queued task"),
  );
  expect(requests[3]?.approvalMode).toBe("default");
  expect(requests[3]?.isBypassAllowed?.()).toBe(false);
  expect(settingsSaves).toEqual([true, false]);
  expect(current.profiles.work?.defaultModel).toBe("test-model");
  await command("/exit");
  await running;
  expect(storedModes.at(-1)).toBe("default");
  process.stdout.write(
    "Bypass availability, live revocation and queued fallback verified\n",
  );
} finally {
  release?.();
  releaseOther?.();
  setup.renderer.destroy();
}
