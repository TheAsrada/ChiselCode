import { expect, test } from "bun:test";
import { ConversationSourceBridge } from "../../src/app/conversation-source.js";
import { captureConversation } from "../../src/models/context.js";
import { createSession } from "../../src/sessions/store.js";

test("submit-time bridge captures accepted prompt while allocation is pending without mutating frozen history", () => {
  const bridge = new ConversationSourceBridge();
  const session = createSession("/workspace", "openai", "fixture");
  bridge.begin("Accepted before model bootstrap");
  const first = bridge.capture();
  expect(first.text).toContain("Accepted before model bootstrap");
  expect(bridge.capture().text).toBe(first.text);
  session.messages.push({
    role: "user",
    content: [{ type: "text", text: "Accepted before model bootstrap" }],
  });
  bridge.bind({
    sessionId: session.id,
    capture: () => captureConversation(session),
  });
  session.messages.push({
    role: "assistant",
    content: [{ type: "text", text: "Later completed result" }],
  });
  expect(first.text).not.toContain("Later completed result");
  expect(bridge.capture().text).toContain("Later completed result");
  bridge.dispose();
  expect(bridge.capture().text).toBe("");
  expect(bridge.pendingSession()).toBeUndefined();
});

test("late allocation of a disposed conversation cannot replace a new owner", async () => {
  const bridge = new ConversationSourceBridge();
  const oldSession = createSession("/workspace/old", "openai", "fixture");
  const currentSession = createSession(
    "/workspace/current",
    "openai",
    "fixture",
  );
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let allocations = 0;
  const old = bridge.allocate(async () => {
    allocations++;
    await barrier;
    return oldSession;
  });
  expect(
    bridge.allocate(async () => {
      allocations++;
      return oldSession;
    }),
  ).toBe(old);
  bridge.dispose();
  bridge.restore(currentSession);
  release();
  await expect(old).rejects.toThrow();
  await Promise.resolve();
  expect(await bridge.pendingSession()).toBe(currentSession.id);
  expect(allocations).toBe(1);
});
