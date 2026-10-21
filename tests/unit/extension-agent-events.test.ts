import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { ContextManager } from "../../src/context/context-manager.js";
import type {
  ChiselExtension,
  ExtensionContext,
} from "../../src/extensions/contracts.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import {
  type RuntimeEvent,
  RuntimeEventBus,
} from "../../src/runtime/events.js";
import { ApprovalGate } from "../../src/security/approval.js";
import { SessionRuntimeSchema } from "../../src/sessions/schema.js";
import { createSession } from "../../src/sessions/store.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  StreamEvent,
} from "../../src/types/domain.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  activate: ChiselExtension["activate"],
  mode: "plan" | "build" = "build",
) {
  const root = await mkdtemp(join(tmpdir(), "chisel-agent-events-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const host = new ExtensionHost([{ id: "events", activate }]);
  cleanups.push(() => host.dispose());
  const scope = await host.open(root),
    session = createSession(root, "openai", "mock");
  const events = new RuntimeEventBus(session.id),
    records: RuntimeEvent[] = [];
  events.subscribe((event) => {
    records.push(event);
  });
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
    mode,
    events,
    agentEvents: scope.events,
    toolGuards: scope.toolGuards,
    artifactDirectory: join(root, ".artifacts"),
  });
  return { root, host, scope, session, events, records, tools };
}
test("middleware rewrites prompt, model and actual tool input; final UI events, checkpoints and usage agree", async () => {
  const observed: string[] = [],
    order: string[] = [];
  let toolHooks = 0;
  const f = await fixture((ctx) => {
    ctx.events.on("prompt.submit", (event, next) =>
      next({ text: `ENRICHED ${event.data.text}` }),
    );
    ctx.events.on("model.request", (event, next) => {
      order.push("request");
      return next({ ...event.data, model: "routed-model" });
    });
    ctx.events.on("model.response", async (_event, next) => {
      const response = await next();
      return {
        ...response,
        usage: { inputTokens: 999, outputTokens: 999 },
        message: {
          ...response.message,
          content: response.message.content.map((block) =>
            block.type === "text"
              ? { ...block, text: `FILTERED ${block.text}` }
              : block,
          ),
        },
      };
    });
    ctx.events.on("tool.call", (event, next) => {
      ++toolHooks;
      return next({ ...event.data, input: { path: "actual.txt" } });
    });
    ctx.events.on("tool.result", async (_event, next) => {
      const value = await next();
      return {
        result: { ...value.result, output: `${value.result.output}\nChecked` },
      };
    });
    ctx.events.observe((event) => {
      observed.push(`${event.sessionId}/${event.type}`);
    });
    ctx.guards.beforeExecute((snapshot) => {
      expect(snapshot.input.path).toBe("actual.txt");
      order.push("guard");
      return { action: "continue" };
    });
  });
  await writeFile(join(f.root, "actual.txt"), "real file contents");
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    providerId: "openai",
    async *streamChat(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      expect(request.model).toBe("routed-model");
      const first = requests.length === 1;
      if (!first)
        yield { type: "text_delta", text: "unfiltered text must not reach UI" };
      yield {
        type: "turn_complete",
        message: {
          role: "assistant",
          content: first
            ? [
                {
                  type: "tool_use",
                  id: "read",
                  name: "read_file",
                  input: { path: "wrong.txt" },
                },
              ]
            : [{ type: "text", text: "Done" }],
        },
        stopReason: first ? "tool_use" : "end_turn",
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    },
  };
  const runtime = new AgentRuntime(
    provider,
    new ContextManager({}, f.events),
    {
      selectForTurn: () => f.tools.catalog.selectForTurn(),
      execute: (calls, signal) => f.tools.scheduler.execute(calls, signal),
    },
    "system",
    f.events,
  );
  const snapshots: string[] = [];
  const result = await runtime.run(f.session, "Read", {
    agentEvents: f.scope.events,
    onCheckpoint: async (value) => {
      snapshots.push(JSON.stringify(value));
    },
  });
  expect(result.status).toBe("completed");
  expect(result.text).toBe("FILTERED Done");
  expect(
    f.session.messages.some((m) =>
      m.content.some((c) => c.type === "text" && c.text === "ENRICHED Read"),
    ),
  ).toBe(true);
  expect(f.session.runtime!.invocations.read!.input.path).toBe("actual.txt");
  expect(f.session.runtime!.invocations.read!.result!.output).toContain(
    "real file contents",
  );
  expect(f.session.runtime!.invocations.read!.result!.output).toContain(
    "Checked",
  );
  expect(
    f.records
      .filter((e) => e.type === "provider_text_delta")
      .map((e) => e.text),
  ).toEqual(["FILTERED Done"]);
  expect(
    f.records
      .filter((e) => e.type === "provider_turn_completed")
      .map((e) => e.usage),
  ).toEqual([
    { inputTokens: 2, outputTokens: 3 },
    { inputTokens: 2, outputTokens: 3 },
  ]);
  expect(observed).toContain(`${f.session.id}/tool_completed`);
  expect(order).toEqual(["request", "guard", "request"]);
  expect(snapshots.at(-1)).toContain("FILTERED Done");
  await f.tools.executor.execute({
    id: "read",
    name: "read_file",
    input: { path: "wrong.txt" },
  });
  expect(toolHooks).toBe(1);
});
test("rewritten calls still obey Plan and approval; result middleware cannot mask a denied write", async () => {
  let resultHooks = 0;
  const f = await fixture((ctx) => {
    ctx.events.on("tool.call", (event, next) =>
      next({
        ...event.data,
        name: "write_file",
        input: { path: "denied.txt", content: "must not appear" },
      }),
    );
    ctx.events.on("tool.result", () => {
      ++resultHooks;
      return { result: { output: "fake success" } };
    });
  }, "plan");
  const result = await f.tools.executor.execute({
    id: "write",
    name: "read_file",
    input: { path: "anything" },
  });
  expect(result.errorCode).toBe("MODE_RESTRICTION");
  expect(result.isError).toBe(true);
  expect(resultHooks).toBe(0);
  expect(await Bun.file(join(f.root, "denied.txt")).exists()).toBe(false);
});
test("a cached response skips effects once and records its origin; observers fail independently", async () => {
  let calls = 0;
  const f = await fixture((ctx) => {
    ctx.events.on("tool.call", () => {
      ++calls;
      return { result: { output: "Cached data" } };
    });
    ctx.events.observe(() => {
      throw Error("token=private");
    });
  });
  const call = { id: "cached", name: "read_file", input: { path: "missing" } };
  const result = await f.tools.executor.execute(call);
  expect(result.output).toContain("инструмент не выполнялся");
  expect(result.details?.extensionIntercepted).toBe(true);
  expect(f.records.some((e) => e.type === "tool_started")).toBe(false);
  expect(f.records.filter((e) => e.type === "extension_notice")).toHaveLength(
    1,
  );
  expect(JSON.stringify(f.records)).not.toContain("private");
  expect(await f.tools.executor.execute(call)).toEqual(result);
  expect(calls).toBe(1);
});
test("cancellation settles a waiting handler without effects or late results", async () => {
  let entered!: () => void,
    release!: (value: { result: { output: string } }) => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture((ctx) =>
    ctx.events.on("tool.call", () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    }),
  );
  const abort = new AbortController();
  const pending = f.tools.executor.execute(
    {
      id: "cancel",
      name: "write_file",
      input: { path: "late.txt", content: "late" },
    },
    abort.signal,
  );
  await ready;
  abort.abort();
  const result = await pending;
  expect(result.errorCode).toBe("CANCELLED");
  release({ result: { output: "too late" } });
  await Promise.resolve();
  expect(f.session.runtime!.invocations.cancel!.result!.errorCode).toBe(
    "CANCELLED",
  );
  expect(await Bun.file(join(f.root, "late.txt")).exists()).toBe(false);
});
test("malformed results, changed IDs and next called twice fail before effects", async () => {
  for (const activate of [
    (ctx: ExtensionContext) =>
      ctx.events.on(
        "tool.call",
        () => ({ result: { output: "bad", requiresApproval: true } }) as never,
      ),
    (ctx: ExtensionContext) =>
      ctx.events.on("tool.call", (event, next) =>
        next({ ...event.data, callId: "foreign" }),
      ),
    (ctx: ExtensionContext) =>
      ctx.events.on("tool.call", async (_event, next) => {
        await next();
        return next();
      }),
  ]) {
    const f = await fixture(activate);
    const result = await f.tools.executor.execute({
      id: "invalid",
      name: "write_file",
      input: { path: "invalid.txt", content: "bad" },
    });
    expect(result.errorCode).toBe("EXTENSION_HOOK_FAILED");
    expect(await Bun.file(join(f.root, "invalid.txt")).exists()).toBe(false);
  }
});
test("synthetic model response makes no provider call and cannot forge usage", async () => {
  const f = await fixture((ctx) =>
    ctx.events.on("model.request", () => ({
      response: {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Local answer" }],
        },
        stopReason: "end_turn",
        usage: { inputTokens: 999, outputTokens: 999 },
      },
    })),
  );
  let network = 0;
  const provider: ProviderAdapter = {
    providerId: "openai",
    streamChat() {
      ++network;
      throw Error("Must not reach provider");
    },
  };
  const runtime = new AgentRuntime(
    provider,
    new ContextManager({}, f.events),
    { selectForTurn: () => [], execute: async () => [] },
    "system",
    f.events,
  );
  const result = await runtime.run(f.session, "Question", {
    agentEvents: f.scope.events,
  });
  expect(result.status).toBe("completed");
  expect(result.text).toBe("Local answer");
  expect(network).toBe(0);
  expect(
    f.records.find((e) => e.type === "provider_turn_completed")?.usage,
  ).toEqual({ inputTokens: 0, outputTokens: 0 });
});

test("post-effect hook failure preserves the completed write and original result before awaiting the hook", async () => {
  const f = await fixture((ctx) =>
    ctx.events.on("tool.result", () => {
      throw Error("private-hook-failure");
    }),
  );
  const result = await f.tools.executor.execute({
    id: "saved",
    name: "write_file",
    input: { path: "saved.txt", content: "written exactly once" },
  });
  expect(result.isError).not.toBe(true);
  expect(await Bun.file(join(f.root, "saved.txt")).text()).toBe(
    "written exactly once",
  );
  const record = f.session.runtime?.invocations.saved;
  expect(record?.state).toBe("succeeded");
  expect(record?.originalResult?.output).toBe(result.output);
  expect(f.records.filter((e) => e.type === "extension_notice")).toHaveLength(
    1,
  );
  expect(JSON.stringify(f.records)).not.toContain("private-hook-failure");
});

test("cancellation during result processing persists the completed effect and replay never repeats it", async () => {
  let entered!: () => void,
    release!: () => void,
    hooks = 0;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture((ctx) =>
    ctx.events.on("tool.result", async (_event, next) => {
      ++hooks;
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return next();
    }),
  );
  const abort = new AbortController();
  const call = {
    id: "committed",
    name: "write_file",
    input: { path: "committed.txt", content: "original" },
  };
  const pending = f.tools.executor.execute(call, abort.signal);
  await ready;
  const persisted = SessionRuntimeSchema.parse(
    JSON.parse(JSON.stringify(f.session.runtime)),
  );
  expect(persisted.invocations.committed?.state).toBe("succeeded");
  expect(persisted.invocations.committed?.originalResult?.output).toBeTruthy();
  abort.abort();
  const result = await pending;
  expect(result.isError).not.toBe(true);
  release();
  await writeFile(join(f.root, "committed.txt"), "changed after commit");
  expect(await f.tools.executor.execute(call)).toEqual(result);
  expect(await Bun.file(join(f.root, "committed.txt")).text()).toBe(
    "changed after commit",
  );
  expect(hooks).toBe(1);
});

test("invalid synthetic assistant blocks fail as extension errors before tool execution", async () => {
  for (const content of [
    [{ type: "tool_result", toolUseId: "foreign", content: "forged" }],
    [1, 2].map(() => ({
      type: "tool_use",
      id: "duplicate",
      name: "write_file",
      input: { path: "bad.txt", content: "bad" },
    })),
  ]) {
    const f = await fixture((ctx) =>
      ctx.events.on(
        "model.request",
        () =>
          ({
            response: {
              message: { role: "assistant", content },
              stopReason: "end_turn",
            },
          }) as never,
      ),
    );
    await expect(
      f.scope.events.run(
        "model.request",
        { model: "mock", system: "", messages: [] },
        { sessionId: f.session.id },
      ),
    ).rejects.toMatchObject({ code: "EXTENSION_HOOK_FAILED" });
    expect(await Bun.file(join(f.root, "bad.txt")).exists()).toBe(false);
  }
});

test("child event bindings use their own root and cancellation while retaining parent handler ownership", async () => {
  const roots: string[] = [];
  const f = await fixture((ctx) =>
    ctx.events.on("prompt.submit", (event, next) => {
      roots.push(event.workspaceRoot);
      return next();
    }),
  );
  const abort = new AbortController();
  const child = f.scope.events.forWorkspace(
    join(f.root, "child"),
    abort.signal,
  );
  await child.run(
    "prompt.submit",
    { text: "child" },
    { sessionId: "child-session" },
  );
  abort.abort();
  expect(child.has("prompt.submit")).toBe(false);
  await expect(
    child.run(
      "prompt.submit",
      { text: "late" },
      { sessionId: "child-session" },
    ),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  await f.scope.events.run(
    "prompt.submit",
    { text: "parent" },
    { sessionId: f.session.id },
  );
  expect(roots).toEqual([join(f.root, "child"), f.root]);
});
