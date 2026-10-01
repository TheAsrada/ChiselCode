import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { ContextManager } from "../../src/context/context-manager.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { createSession } from "../../src/sessions/store.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "../../src/types/domain.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chisel-provider-recovery-"));
  roots.push(root);
  const session = createSession(root, "openai-compatible", "mock");
  const events = new RuntimeEventBus(session.id);
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    {
      approvalMode: "bypassPermissions",
      allowBypassPermissions: true,
      autoApprove: false,
      allowedTools: new Set(),
      nonInteractive: true,
    },
    { requestApproval: async () => "unavailable" },
  );
  const tools = createLocalToolRuntime(root, [], gate, session, [], {
    events,
    artifactDirectory: join(root, ".artifacts"),
  });
  return {
    root,
    session,
    events,
    tools,
    run(provider: ProviderAdapter, signal?: AbortSignal) {
      return new AgentRuntime(
        provider,
        new ContextManager({ maxOutputTokens: 4096 }, events),
        {
          selectForTurn: () => tools.catalog.selectForTurn(),
          execute: (calls, abort) => tools.scheduler.execute(calls, abort),
        },
        "system",
        events,
      ).run(session, "Create a landing page", { signal });
    },
  };
}
function completed(text = "Готово"): StreamEvent {
  return {
    type: "turn_complete",
    message: { role: "assistant", content: [{ type: "text", text }] },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}
for (const failure of ["invalid_tool_arguments", "output_truncated"] as const)
  test(`${failure}: regenerate without executing the rejected call or saving its prose`, async () => {
    const setup = await fixture();
    const requests: ProviderRequest[] = [];
    let recoveries = 0;
    setup.events.subscribe((event) => {
      if (event.type === "provider_response_recovery") recoveries++;
    });
    const content =
      '<h1>Привет!</h1>\n<script>const x = "C:\\\\tmp";</script>\n';
    const provider: ProviderAdapter = {
      providerId: "openai-compatible",
      async *streamChat(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "text_delta", text: "Rejected partial prose" };
          if (failure === "invalid_tool_arguments")
            yield { type: "error", code: failure, message: "Malformed JSON" };
          else
            yield {
              type: "turn_complete",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "rejected",
                    name: "write_file",
                    input: { path: "must-not-exist", content: "partial" },
                  },
                ],
              },
              stopReason: "length",
              usage: { inputTokens: 1, outputTokens: 4096 },
            };
        } else if (requests.length === 2) {
          yield {
            type: "turn_complete",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "valid",
                  name: "write_file",
                  input: { path: "landing.html", content },
                },
              ],
            },
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else yield completed();
      },
    };
    const result = await setup.run(provider);
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Готово");
    expect(await readFile(join(setup.root, "landing.html"), "utf8")).toBe(
      content,
    );
    expect(await readdir(setup.root)).not.toContain("must-not-exist");
    expect(requests).toHaveLength(3);
    expect(requests[1]?.system).toContain("valid JSON objects");
    expect(requests[1]?.system).toContain("small complete tool calls");
    expect(requests.every((request) => request.maxTokens === 4096)).toBe(true);
    expect(recoveries).toBe(1);
    expect(JSON.stringify(setup.session.messages)).not.toContain(
      "Rejected partial prose",
    );
    expect(setup.session.runtime?.invocations.rejected).toBeUndefined();
    expect(setup.session.runtime?.invocations.valid?.state).toBe("succeeded");
  });

test("recovery has a fixed limit and never executes malformed tool arguments", async () => {
  const setup = await fixture();
  let attempts = 0;
  const provider: ProviderAdapter = {
    providerId: "mock",
    async *streamChat() {
      attempts++;
      yield {
        type: "error",
        code: "invalid_tool_arguments",
        message: "Malformed JSON",
      };
    },
  };
  const result = await setup.run(provider);
  expect(attempts).toBe(3);
  expect(result).toMatchObject({
    status: "failed",
    errorCode: "invalid_tool_arguments",
  });
  expect(Object.keys(setup.session.runtime?.invocations ?? {})).toHaveLength(0);
  expect(await readdir(setup.root)).toEqual([]);
});

test("cancellation during recovery prevents a second provider call", async () => {
  const setup = await fixture();
  const abort = new AbortController();
  let attempts = 0;
  setup.events.subscribe((event) => {
    if (event.type === "provider_response_recovery") abort.abort();
  });
  const provider: ProviderAdapter = {
    providerId: "mock",
    async *streamChat() {
      attempts++;
      yield {
        type: "error",
        code: "output_truncated",
        message: "Limit reached",
      };
    },
  };
  const result = await setup.run(provider, abort.signal);
  expect(attempts).toBe(1);
  expect(result.status).toBe("cancelled");
  expect(await readdir(setup.root)).toEqual([]);
});

test("every registered tool rejects non-object input before preparing or executing", async () => {
  const setup = await fixture();
  const specs = setup.tools.catalog.selectForTurn();
  expect(specs.length).toBeGreaterThan(14);
  const events: string[] = [];
  setup.events.subscribe((event) => {
    events.push(event.type);
  });
  for (const [index, spec] of specs.entries()) {
    const result = await setup.tools.scheduler.execute([
      {
        id: `invalid-${index}`,
        name: spec.name,
        input: null as unknown as Record<string, unknown>,
      },
    ]);
    expect(result[0]).toMatchObject({
      isError: true,
      errorCode: "INVALID_TOOL_INPUT",
    });
  }
  expect(events).not.toContain("tool_prepared");
  expect(events).not.toContain("tool_started");
  expect(await readdir(setup.root)).toEqual([]);
});
