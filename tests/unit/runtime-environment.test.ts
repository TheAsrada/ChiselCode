import { expect, test } from "bun:test";
import { ContextManager } from "../../src/context/context-manager.js";
import type { TokenCountRequest } from "../../src/providers/capabilities.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { observeUi } from "../../src/runtime/environment.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { createSession } from "../../src/sessions/store.js";
import type {
  ProviderAdapter,
  ProviderRequest,
} from "../../src/types/domain.js";
import { VERSION } from "../../src/version.js";

test("headless and hidden-owner UI observations cannot expose another conversation", () => {
  expect(observeUi()).toMatchObject({ available: false });
  const snapshot = observeUi({
    observe: () => ({
      ownerVisible: false,
      foreignDraft: "private",
      nextModel: { model: "foreign" },
    }),
  });
  expect(snapshot).toMatchObject({ available: true, ownerVisible: false });
  expect(JSON.stringify(snapshot)).not.toContain("foreign");
});

test("one snapshot per provider attempt is counted and sent without entering history or checkpoints", async () => {
  const session = createSession(process.cwd(), "openai", "captured-model");
  session.profileId = "captured-profile";
  let observations = 0,
    executions = 0;
  const counted: TokenCountRequest[] = [],
    sent: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    providerId: "openai",
    getCapabilities: async () => ({ tokenCounting: "provider" }),
    countTokens: async (input) => {
      counted.push(structuredClone({ ...input, signal: undefined }));
      return 200;
    },
    async *streamChat(input) {
      sent.push(structuredClone({ ...input, signal: undefined }));
      const final = sent.length > 1;
      yield {
        type: "turn_complete",
        message: {
          role: "assistant",
          content: final
            ? [{ type: "text", text: "answer" }]
            : [{ type: "tool_use", id: "read", name: "read_file", input: {} }],
        },
        stopReason: final ? "end_turn" : "tool_use",
        usage: { inputTokens: 200, outputTokens: 10 },
      };
    },
  };
  const runtime = new AgentRuntime(
    provider,
    new ContextManager(),
    {
      selectForTurn: () => [
        {
          name: "read_file",
          description: "fixture",
          requiresApproval: false,
          inputSchema: { type: "object", properties: {} },
        },
      ],
      execute: async () => {
        executions++;
        return [{ output: "evidence" }];
      },
    },
    "system",
    new RuntimeEventBus(session.id),
  );
  const result = await runtime.run(session, "version/model/UI?", {
    client: "opentui",
    mode: "plan",
    approvalMode: "default",
    uiSnapshot: {
      observe: () => {
        observations++;
        return observations === 1
          ? {
              ownerVisible: true,
              route: "conversation",
              focus: "composer",
              nextModel: { provider: "openai", model: "next-model" },
            }
          : { ownerVisible: false };
      },
    },
  });
  expect(result.status).toBe("completed");
  expect(executions).toBe(1);
  expect(observations).toBe(2);
  expect(sent).toHaveLength(2);
  for (const request of sent) {
    expect(request.model).toBe("captured-model");
    expect(request.system).toContain(VERSION);
    expect(request.system).toContain("captured-profile");
    expect(request.system).toContain('"agentMode":"plan"');
    const uiText = request.messages[0]?.content[0];
    expect(uiText?.type).toBe("text");
    expect(
      counted.some(
        (count) =>
          JSON.stringify(count.messages) === JSON.stringify(request.messages),
      ),
    ).toBe(true);
  }
  expect(JSON.stringify(sent[0]?.messages)).toContain("next-model");
  expect(JSON.stringify(sent[1]?.messages)).not.toContain("next-model");
  expect(JSON.stringify(session)).not.toContain("ui_snapshot");
});
