import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { ContextManager } from "../../src/context/context-manager.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { canonicalWorkspaceRoot } from "../../src/extensions/host.js";
import {
  attachExtensionTools,
  type ChiselExtension,
  ExtensionHost,
} from "../../src/extensions/index.js";
import type { AgentMode } from "../../src/runtime/agent-mode.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { RuntimeError } from "../../src/runtime/errors.js";
import {
  type RuntimeEvent,
  RuntimeEventBus,
} from "../../src/runtime/events.js";
import {
  type ApprovalDecision,
  ApprovalGate,
  type ApprovalOptions,
  type ApprovalRequest,
} from "../../src/security/approval.js";
import { SecretRedactor } from "../../src/security/redaction.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { SessionV3Schema } from "../../src/sessions/schema.js";
import { createSession } from "../../src/sessions/store.js";
import { editingHandlers } from "../../src/tools/editing/handlers.js";
import { fileHandlers } from "../../src/tools/local/files.js";
import { shellHandler } from "../../src/tools/local/shell.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import { workspaceCoordinator } from "../../src/tools/workspace-coordinator.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  Session,
} from "../../src/types/domain.js";
import {
  replaySessionIntoTranscript,
  toolTranscriptHandlers,
} from "../../src/ui/tool-transcript.js";
import { TuiController } from "../../src/ui/tui-controller.js";
import {
  fixtureTool,
  renamedTool,
  toolExtension,
} from "../fixtures/tool-extension.js";

const roots: string[] = [];
const hosts: ExtensionHost[] = [];
afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const path = await canonicalWorkspaceRoot(
    await mkdtemp(join(tmpdir(), "chisel-contribution-runtime-")),
  );
  roots.push(path);
  return path;
}
async function scope(definitions: readonly ChiselExtension[], path?: string) {
  const h = new ExtensionHost(definitions);
  hosts.push(h);
  return h.open(path ?? (await root()));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function approval() {
  const requested = deferred<ApprovalRequest>();
  const decision = deferred<ApprovalDecision>();
  return {
    requested,
    decision,
    resolver: async (request: ApprovalRequest) => {
      requested.resolve(request);
      return decision.promise;
    },
  };
}
async function setup(
  s: Awaited<ReturnType<typeof scope>>,
  options: {
    mode?: AgentMode;
    approval?: Partial<ApprovalOptions>;
    resolver?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
    session?: Session;
    ignore?: string[];
    redactor?: SecretRedactor;
    checkpoint?: (session: Session) => Promise<void>;
  } = {},
) {
  const session =
    options.session ?? createSession(s.workspaceRoot, "fixture", "mock");
  const events: RuntimeEvent[] = [];
  const bus = new RuntimeEventBus(session.id);
  const redactor = options.redactor ?? new SecretRedactor();
  bus.sanitize = (value) => redactor.value(value);
  bus.subscribe((event) => {
    events.push(event);
  });
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    {
      autoApprove: false,
      nonInteractive: false,
      allowedTools: new Set(),
      ...options.approval,
    },
    { requestApproval: options.resolver ?? (async () => "approved") },
  );
  const checkpoints: string[] = [];
  const checkpoint = async () => {
    const text = JSON.stringify(SessionV3Schema.parse(session));
    checkpoints.push(text);
    await options.checkpoint?.(session);
  };
  const tools = createLocalToolRuntime(
    s.workspaceRoot,
    options.ignore ?? [],
    gate,
    session,
    [],
    {
      mode: options.mode,
      events: bus,
      toolGuards: s.toolGuards,
      artifactDirectory: join(s.workspaceRoot, "artifacts", session.id),
      checkpoint,
      sanitizeApproval: (request) => redactor.value(request),
      sanitizeResult: (result) => redactor.value(result),
    },
  );
  const binding = await attachExtensionTools(s, tools.catalog);
  const call = (
    name: string,
    input = {},
    id = `${name}-${Math.random()}`,
    signal?: AbortSignal,
  ) => tools.executor.execute({ id, name, input }, signal);
  return {
    ...tools,
    session,
    events,
    bus,
    binding,
    call,
    checkpoints,
    gate,
    checkpoint,
  };
}
function local(name: string) {
  const handler = [
    ...fileHandlers(),
    ...editingHandlers(),
    shellHandler(),
  ].find((handler) => handler.spec.name === name);
  if (!handler) throw new Error(name);
  return handler;
}

test("captured methods retain this and ignore subsequent callable/schema/effect mutation", async () => {
  const tool = Object.assign(fixtureTool(), {
    count: 0,
    async prepare() {
      this.count++;
      return { data: this.count, preview: "Captured", resources: [] };
    },
    async execute() {
      return { output: String(this.count) };
    },
  });
  const s = await scope([toolExtension("captured", [tool])]);
  tool.spec.name = "changed";
  tool.spec.effect = "external_destructive";
  tool.spec.inputSchema.type = "array";
  tool.prepare = async () => {
    throw new Error("Changed callable");
  };
  const f = await setup(s, {
    mode: "plan",
    approval: { approvalMode: "dontAsk" },
  });
  expect((await f.call("ext:captured:inspect")).output).toBe("1");
  expect(tool.count).toBe(1);
});

test("pre-aborted contributions and lifetime cancellation during approval do not start handlers", async () => {
  let prepared = 0;
  let executed = 0;
  const tool = fixtureTool("write", { effect: "workspace_write" });
  tool.prepare = async () => {
    prepared++;
    return { data: undefined, preview: "Write", resources: [] };
  };
  tool.execute = async () => {
    executed++;
    return { output: "wrong" };
  };
  const s = await scope([toolExtension("early", [tool])]);
  const pending = approval();
  const f = await setup(s, { resolver: pending.resolver });
  const caller = new AbortController();
  caller.abort();
  expect(
    (await f.call("ext:early:write", {}, "pre-abort", caller.signal)).errorCode,
  ).toBe("CANCELLED");
  expect(prepared).toBe(0);
  const execution = f.call(
    "ext:early:write",
    {},
    "waiting",
    new AbortController().signal,
  );
  await pending.requested.promise;
  s.abortLifetime();
  expect((await execution).errorCode).toBe("CANCELLED");
  expect(executed).toBe(0);
  expect(f.events.some((event) => event.type === "tool_started")).toBe(false);
  expect(f.session.runtime?.invocations.waiting?.state).toBe("cancelled");
  pending.decision.resolve("approved");
});

test("two extension EditingService writes serialize through the shared coordinator", async () => {
  const entered = deferred<void>();
  const finish = deferred<void>();
  const native = local("write_file");
  const tool = renamedTool(native, "write");
  let active = 0;
  let maximum = 0;
  let calls = 0;
  tool.execute = async (context, plan) => {
    active++;
    maximum = Math.max(maximum, active);
    if (++calls === 1) {
      entered.resolve();
      await finish.promise;
    }
    try {
      return await native.execute(context, plan);
    } finally {
      active--;
    }
  };
  const s = await scope([toolExtension("writes", [tool])]);
  const a = await setup(s, { approval: { approvalMode: "acceptEdits" } });
  const b = await setup(s, { approval: { approvalMode: "acceptEdits" } });
  const first = a.call("ext:writes:write", { path: "first", content: "A" });
  await entered.promise;
  let completed = false;
  const second = b
    .call("ext:writes:write", { path: "second", content: "B" })
    .then((result) => {
      completed = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(completed).toBe(false);
  finish.resolve();
  expect((await first).isError).not.toBe(true);
  expect((await second).isError).not.toBe(true);
  expect(maximum).toBe(1);
  expect(await readFile(join(s.workspaceRoot, "first"), "utf8")).toBe("A");
  expect(await readFile(join(s.workspaceRoot, "second"), "utf8")).toBe("B");
});

test("model schemas, actual execution, checkpoint save/load, replay and completed resume use registered contributions", async () => {
  const path = await root();
  await writeFile(join(path, "file.txt"), "Actual extension read");
  const s = await scope(
    [toolExtension("fixture", [renamedTool(local("read_file"), "read")])],
    path,
  );
  const saved = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  process.env.XDG_DATA_HOME = path;
  process.env.LOCALAPPDATA = path;
  const store = await projectSessionStore(path).finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const f = await setup(s, { checkpoint: (session) => store.save(session) });
  const requests: ProviderRequest[] = [];
  let turn = 0;
  const provider: ProviderAdapter = {
    providerId: "fixture",
    async *streamChat(request) {
      requests.push(request);
      const first = turn++ === 0;
      yield {
        type: "turn_complete",
        stopReason: first ? "tool_use" : "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        message: {
          role: "assistant",
          content: first
            ? [
                {
                  type: "tool_use",
                  id: "read",
                  name: "ext:fixture:read",
                  input: { path: "file.txt" },
                },
              ]
            : [{ type: "text", text: "Read the project" }],
        },
      };
    },
  };
  const runtime = new AgentRuntime(
    provider,
    new ContextManager({}, f.bus),
    {
      selectForTurn: () => f.catalog.selectForTurn(),
      execute: (calls, signal) => f.scheduler.execute(calls, signal),
    },
    "Core",
    f.bus,
  );
  expect(
    (
      await runtime.run(f.session, "Inspect project", {
        onCheckpoint: f.checkpoint,
      })
    ).status,
  ).toBe("completed");
  expect(
    requests[0]?.tools.some((tool) => tool.name === "ext:fixture:read"),
  ).toBe(true);
  expect(JSON.stringify(requests[1]?.messages)).toContain(
    "Actual extension read",
  );
  const resumed = await store.load(f.session.id);
  expect(resumed.runtime?.invocations.read?.toolSource).toEqual({
    type: "extension",
    extensionId: "fixture",
    originalName: "read",
  });
  expect(resumed.runtime?.invocations.read?.result?.details?.extension).toEqual(
    { id: "fixture", tool: "read" },
  );
  await writeFile(join(path, "file.txt"), "New content");
  const next = await setup(s, { session: resumed });
  expect(
    (await next.call("ext:fixture:read", { path: "file.txt" }, "read")).output,
  ).toContain("Actual extension read");
  expect(next.events).toHaveLength(0);
  expect(
    (await next.call("ext:fixture:read", { path: "other" }, "read")).errorCode,
  ).toBe("PROTOCOL_ERROR_DUPLICATE_CALL_ID");
  const view = new TuiController(path);
  replaySessionIntoTranscript(view, resumed);
  expect(
    view.snapshot.transcript.some((entry) =>
      entry.text.includes("[extension] fixture · read"),
    ),
  ).toBe(true);
  const live = new TuiController(path);
  const rendering = toolTranscriptHandlers(() => live);
  rendering.onToolStart?.(
    "ext:fixture:read",
    {},
    resumed.runtime?.invocations.read?.toolSource,
  );
  rendering.onToolResult?.(
    "ext:fixture:read",
    resumed.runtime?.invocations.read?.result ?? { output: "" },
  );
  expect(
    live.snapshot.transcript.some((entry) =>
      entry.text.includes("[extension] fixture · read"),
    ),
  ).toBe(true);
  const legacy = SessionV3Schema.parse({ ...resumed, runtime: undefined });
  expect(legacy.schemaVersion).toBe(3);
  await f.binding.dispose();
  expect(next.catalog.get("ext:fixture:read")).toBeDefined();
});

test("borrowed prompts share activation/state but bindings, sessions, lifetime and workspace data stay independent", async () => {
  let activated = 0;
  let cleaned = 0;
  const definition: ChiselExtension = {
    id: "shared",
    activate(ctx) {
      activated++;
      let value = 0;
      ctx.add({
        dispose: () => {
          cleaned++;
        },
      });
      const tool = fixtureTool();
      tool.execute = async (context) => ({
        output: `${ctx.workspaceRoot}:${++value}:${context.session.id}`,
      });
      ctx.tools.register(tool);
    },
  };
  const h = new ExtensionHost([definition]);
  hosts.push(h);
  const a = await h.open(await root());
  const f = await setup(a);
  const g = await setup(a);
  expect(activated).toBe(1);
  const results = await Promise.all([
    f.call("ext:shared:inspect"),
    g.call("ext:shared:inspect"),
  ]);
  expect(results[0]?.output).toContain(f.session.id);
  expect(results[1]?.output).toContain(g.session.id);
  await f.binding.dispose();
  expect((await g.call("ext:shared:inspect")).output).toContain(":3:");
  expect(cleaned).toBe(0);
  const b = await h.open(await root());
  const different = await setup(b);
  expect((await different.call("ext:shared:inspect")).output).toContain(
    `${b.workspaceRoot}:1:`,
  );
  await h.dispose();
  await h.dispose();
  expect(cleaned).toBe(2);
});

test("Plan filters effects and rejects forced mutations before prepare; Bypass cannot grant Plan writes", async () => {
  let prepared = 0;
  let executed = 0;
  const tools = [
    "read",
    "external_read",
    "workspace_write",
    "process",
    "git_write",
    "external_write",
    "external_destructive",
  ].map((effect) => {
    const tool = fixtureTool(effect, {
      effect: effect as import("../../src/tools/effects.js").ToolEffect,
    });
    tool.prepare = async () => {
      prepared++;
      return { data: undefined, preview: effect, resources: [] };
    };
    tool.execute = async () => {
      executed++;
      return { output: effect };
    };
    return tool;
  });
  const f = await setup(await scope([toolExtension("plan", tools)]), {
    mode: "plan",
    approval: {
      approvalMode: "bypassPermissions",
      allowBypassPermissions: true,
    },
  });
  expect(
    f.catalog
      .selectForTurn()
      .filter((tool) => tool.name.startsWith("ext:"))
      .map((tool) => tool.name),
  ).toEqual(["ext:plan:read", "ext:plan:external_read"]);
  for (const effect of [
    "workspace_write",
    "process",
    "git_write",
    "external_write",
    "external_destructive",
  ])
    expect((await f.call(`ext:plan:${effect}`)).errorCode).toBe(
      "MODE_RESTRICTION",
    );
  expect(prepared).toBe(0);
  expect(executed).toBe(0);
  expect(f.events.some((event) => event.type === "tool_started")).toBe(false);
});

test("empty extension write plans still consult core policy, Dont Ask and user deny", async () => {
  let executed = 0;
  let approvals = 0;
  const tool = fixtureTool("write", {
    effect: "workspace_write",
    parallelSafe: false,
  });
  tool.prepare = async () => ({
    data: undefined,
    preview: "Write",
    resources: [],
    diffs: [],
  });
  tool.execute = async () => {
    executed++;
    return { output: "written" };
  };
  const s = await scope([toolExtension("write", [tool])]);
  for (const dontAsk of [false, true]) {
    const f = await setup(s, {
      approval: { approvalMode: dontAsk ? "dontAsk" : "default" },
      resolver: async () => {
        approvals++;
        return "denied";
      },
    });
    expect((await f.call("ext:write:write", {}, "deny")).errorCode).toBe(
      "PERMISSION_DENIED",
    );
    expect(f.session.runtime?.invocations.deny?.state).toBe("denied");
    expect(f.events.some((event) => event.type === "tool_started")).toBe(false);
  }
  expect(approvals).toBe(1);
  expect(executed).toBe(0);
  const approved = await setup(s, {
    approval: { approvalMode: "acceptEdits" },
  });
  expect((await approved.call("ext:write:write")).isError).not.toBe(true);
  expect(executed).toBe(1);
});

test("approval attribution, pending resume and interrupted mutation preserve the common executor path", async () => {
  let executed = 0;
  const requests: ApprovalRequest[] = [];
  const tool = fixtureTool("write", {
    effect: "workspace_write",
    parallelSafe: false,
  });
  tool.execute = async () => {
    executed++;
    return {
      output: "Written",
      details: { extension: { id: "spoofed", tool: "wrong" } },
    };
  };
  const s = await scope([toolExtension("owner", [tool])]);
  const f = await setup(s, {
    resolver: async (request) => {
      requests.push(request);
      return requests.length === 1 ? "unavailable" : "approved";
    },
  });
  expect(
    (await f.call("ext:owner:write", {}, "pending")).requiresApproval,
  ).toBe(true);
  expect(f.session.runtime?.invocations.pending?.state).toBe(
    "awaiting_approval",
  );
  expect(executed).toBe(0);
  expect(
    (await f.call("ext:owner:write", {}, "pending")).details?.extension,
  ).toEqual({ id: "owner", tool: "write" });
  expect(requests[0]?.source).toEqual({
    type: "extension",
    extensionId: "owner",
    originalName: "write",
  });
  await f.call("ext:owner:write", {}, "pending");
  expect(executed).toBe(1);
  const record = f.session.runtime?.invocations.pending;
  if (!record) throw new Error("Missing record");
  record.state = "running";
  delete record.result;
  const next = await setup(s, { session: f.session });
  expect((await next.call("ext:owner:write", {}, "pending")).errorCode).toBe(
    "INTERRUPTED_INVOCATION",
  );
  expect(executed).toBe(1);
});

for (const point of ["afterPrepare", "beforeExecute"] as const)
  test(`${point} extension veto sees real source and survives Bypass`, async () => {
    let executed = 0;
    let approvals = 0;
    let seen = false;
    const tool = fixtureTool("write", {
      effect: "workspace_write",
      parallelSafe: false,
    });
    tool.execute = async () => {
      executed++;
      return { output: "written" };
    };
    const s = await scope([
      {
        id: "guard",
        activate(ctx) {
          ctx.tools.register(tool);
          ctx.guards[point]((snapshot) => {
            seen =
              snapshot.tool.source.type === "extension" &&
              snapshot.tool.source.extensionId === "guard";
            return { action: "deny", reason: "Disabled" };
          });
        },
      },
    ]);
    for (const bypass of [false, true]) {
      const f = await setup(s, {
        approval: {
          approvalMode: bypass ? "bypassPermissions" : "default",
          allowBypassPermissions: bypass,
        },
        resolver: async () => {
          approvals++;
          return "approved";
        },
      });
      expect((await f.call("ext:guard:write", {}, "veto")).errorCode).toBe(
        "EXTENSION_HOOK_DENIED",
      );
      expect(f.session.runtime?.invocations.veto?.state).toBe("denied");
      expect(f.events.some((event) => event.type === "tool_started")).toBe(
        false,
      );
    }
    expect(seen).toBe(true);
    expect(executed).toBe(0);
    expect(approvals).toBe(point === "afterPrepare" ? 0 : 1);
  });

test("extension editing uses real fresh reads, commits, path policy and stale approval checks", async () => {
  const path = await root();
  await writeFile(join(path, "file.txt"), "original");
  const s = await scope(
    [
      toolExtension("editing", [
        renamedTool(local("write_file"), "write"),
        renamedTool(local("read_file"), "read"),
      ]),
    ],
    path,
  );
  const pending = approval();
  const f = await setup(s, { resolver: pending.resolver });
  expect(
    (await f.call("ext:editing:write", { path: "file.txt", content: "new" }))
      .errorCode,
  ).toBe("STALE_FILE_REVISION");
  await f.call("ext:editing:read", { path: "file.txt" });
  const write = f.call("ext:editing:write", {
    path: "file.txt",
    content: "new",
  });
  await pending.requested.promise;
  await writeFile(join(path, "file.txt"), "other writer");
  pending.decision.resolve("approved");
  expect((await write).errorCode).toBe("STALE_FILE_REVISION");
  expect(await readFile(join(path, "file.txt"), "utf8")).toBe("other writer");
  await f.call("ext:editing:read", { path: "file.txt" });
  const result = await f.call("ext:editing:write", {
    path: "file.txt",
    content: "final",
  });
  expect(result.diffs).toHaveLength(1);
  expect(result.details?.extension).toEqual({ id: "editing", tool: "write" });
  expect(await readFile(join(path, "file.txt"), "utf8")).toBe("final");
  const outside = await root();
  await writeFile(join(outside, "secret"), "outside");
  await symlink(
    outside,
    join(path, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(
    (await f.call("ext:editing:read", { path: "escape/secret" })).isError,
  ).toBe(true);
  expect(
    (await f.call("ext:editing:write", { path: "../escape", content: "bad" }))
      .isError,
  ).toBe(true);
});

for (const effect of ["process", "git_write"] as const)
  test(`${effect} extension rechecks workspace after approval before performing real action`, async () => {
    let executed = 0;
    const tool = fixtureTool("process", { effect, parallelSafe: false });
    tool.prepare = async () => ({
      data: undefined,
      preview: "Run approved command",
      resources: [],
      command: "echo fixture",
    });
    tool.execute = async (context) => {
      executed++;
      const result = await context.sandbox.execute({
        command: "echo fixture",
        cwd: context.workspace.root,
        timeout: 1000,
        signal: context.signal,
      });
      return { output: result.output };
    };
    const s = await scope([toolExtension("command", [tool])]);
    const pending = approval();
    const f = await setup(s, { resolver: pending.resolver });
    const peer = await setup(s, { approval: { approvalMode: "acceptEdits" } });
    const execution = f.call("ext:command:process");
    await pending.requested.promise;
    expect(
      (await peer.call("write_file", { path: "peer.txt", content: "changed" }))
        .isError,
    ).not.toBe(true);
    pending.decision.resolve("approved");
    expect((await execution).errorCode).toBe("STALE_WORKSPACE");
    expect(executed).toBe(0);
    expect((await f.call("ext:command:process")).output).toContain("fixture");
    expect(executed).toBe(1);
  });

test("read scheduler remains bounded; external reads with no workspace access release the execution lease", async () => {
  let active = 0;
  let maximum = 0;
  const entered = deferred<void>();
  const release = deferred<void>();
  const tool = fixtureTool("read", {
    effect: "external_read",
    workspaceAccess: "none",
  });
  tool.execute = async () => {
    active++;
    maximum = Math.max(maximum, active);
    if (active === 2) entered.resolve();
    await release.promise;
    active--;
    return { output: "read" };
  };
  const s = await scope([toolExtension("parallel", [tool])]);
  const f = await setup(s);
  const peer = await setup(s, { approval: { approvalMode: "acceptEdits" } });
  const results = f.scheduler.execute(
    Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      name: "ext:parallel:read",
      input: {},
    })),
  );
  await entered.promise;
  expect(
    (
      await peer.call("write_file", {
        path: "peer",
        content: "writes during external read",
      })
    ).isError,
  ).not.toBe(true);
  release.resolve();
  expect((await results).every((result) => !result.isError)).toBe(true);
  expect(maximum).toBe(4);
});

test("cooperative timeout retains a mutation lease until the underlying operation finishes and advances revision", async () => {
  const entered = deferred<void>();
  const aborted = deferred<void>();
  const finish = deferred<void>();
  const tool = fixtureTool("write", {
    effect: "workspace_write",
    parallelSafe: false,
    timeoutMs: 20,
  });
  tool.execute = async (context) => {
    await writeFile(join(context.workspace.root, "partial"), "partial");
    entered.resolve();
    if (context.signal?.aborted) aborted.resolve();
    context.signal?.addEventListener("abort", () => aborted.resolve(), {
      once: true,
    });
    await finish.promise;
    throw new RuntimeError("CANCELLED", "Cooperative stop");
  };
  const s = await scope([toolExtension("timeout", [tool])]);
  const f = await setup(s, { approval: { approvalMode: "acceptEdits" } });
  const peer = await setup(s);
  const workspace = await workspaceCoordinator.scope(s.workspaceRoot);
  const revision = workspaceCoordinator.revision(workspace);
  const execution = f.call("ext:timeout:write");
  await entered.promise;
  await aborted.promise;
  let peerFinished = false;
  const reading = peer.call("read_file", { path: "partial" }).then((result) => {
    peerFinished = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(peerFinished).toBe(false);
  finish.resolve();
  expect((await execution).errorCode).toBe("TOOL_TIMEOUT");
  expect((await reading).output).toContain("partial");
  expect(workspaceCoordinator.revision(workspace)).toBeGreaterThan(revision);
});

test("prompt abort and scope lifetime combine with explicit signals; closed saved adapters never execute", async () => {
  const entered = deferred<void>();
  const signals: AbortSignal[] = [];
  const tool = fixtureTool("wait", { workspaceAccess: "none" });
  tool.execute = async (context) => {
    const signal = context.signal;
    if (!signal) throw new Error("No signal");
    signals.push(signal);
    if (signals.length === 2) entered.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return { output: "late" };
  };
  const s = await scope([toolExtension("cancel", [tool])]);
  const f = await setup(s);
  const g = await setup(s);
  const cancel = new AbortController();
  const a = f.call("ext:cancel:wait", {}, "a", cancel.signal);
  const b = g.call("ext:cancel:wait", {}, "b", new AbortController().signal);
  await entered.promise;
  cancel.abort();
  expect((await a).errorCode).toBe("CANCELLED");
  expect(signals[1]?.aborted).toBe(false);
  s.abortLifetime();
  expect((await b).errorCode).toBe("CANCELLED");
  const adapter = g.catalog.get("ext:cancel:wait");
  await s.dispose();
  expect((await g.call("ext:cancel:wait", {}, "closed")).errorCode).toBe(
    "CANCELLED",
  );
  await expect(adapter.prepare(g.context, {})).rejects.toMatchObject({
    code: "CANCELLED",
  });
  expect(signals).toHaveLength(2);
});

for (const stage of ["parse", "prepare", "execute"] as const)
  test(`${stage} errors retain core codes, attribution and sanitization`, async () => {
    const redactor = new SecretRedactor();
    redactor.add("FIXTURE_SECRET");
    const tool = fixtureTool("fail");
    const error = new RuntimeError("STALE_FILE_REVISION", "FIXTURE_SECRET", {
      secret: "FIXTURE_SECRET",
    });
    if (stage === "parse")
      tool.parse = () => {
        throw error;
      };
    if (stage === "prepare")
      tool.prepare = async () => {
        throw error;
      };
    if (stage === "execute")
      tool.execute = async () => {
        throw error;
      };
    const f = await setup(await scope([toolExtension("failures", [tool])]), {
      redactor,
    });
    const result = await f.call("ext:failures:fail", {}, "failure");
    expect(result.errorCode).toBe("STALE_FILE_REVISION");
    expect(result.details?.extension).toEqual({ id: "failures", tool: "fail" });
    expect(JSON.stringify([result, f.checkpoints, f.events])).not.toContain(
      "FIXTURE_SECRET",
    );
    expect(f.events.some((event) => event.type === "tool_started")).toBe(
      stage === "execute",
    );
  });

test("large raw outputs and previews use existing sanitized artifacts, with core-owned attribution", async () => {
  const redactor = new SecretRedactor();
  redactor.add("FIXTURE_SECRET");
  const tool = fixtureTool("large", {
    effect: "external_write",
    outputPolicy: { maxInlineTokens: 200 },
  });
  tool.prepare = async () => ({
    data: undefined,
    preview: "FIXTURE_SECRET preview",
    resources: [],
  });
  tool.execute = async () => ({
    output: "FIXTURE_SECRET preview",
    rawOutput: "FIXTURE_SECRET\n".repeat(4000),
    details: { extension: { id: "fake", tool: "fake" } },
  });
  let shown: ApprovalRequest | undefined;
  const f = await setup(await scope([toolExtension("artifacts", [tool])]), {
    redactor,
    resolver: async (request) => {
      shown = request;
      return "approved";
    },
  });
  const result = await f.call("ext:artifacts:large", {}, "large");
  expect(result.artifact).toBeDefined();
  expect(result.output.length).toBeLessThan(1500);
  expect(result.details?.extension).toEqual({ id: "artifacts", tool: "large" });
  const reading = await f.call("read_tool_result", {
    uri: result.artifact?.uri,
    offset: 0,
    limit: 3,
  });
  expect(reading.output).toContain("секрет скрыт");
  expect(
    JSON.stringify([result, reading, shown, f.checkpoints, f.events]),
  ).not.toContain("FIXTURE_SECRET");
});

test("MCP approval metadata from extension prepare is rejected before policy and never asks", async () => {
  let approved = 0;
  let executed = 0;
  const tool = fixtureTool("spoof", { effect: "external_write" });
  tool.prepare = async () => ({
    data: undefined,
    preview: "Spoof",
    resources: [],
    approval: {
      serverId: "fake",
      serverTitle: "Fake",
      originalName: "spoof",
      title: "Spoof",
      category: "read",
      fields: [],
      consequence: "none",
      destructive: false,
    },
  });
  tool.execute = async () => {
    executed++;
    return { output: "wrong" };
  };
  const f = await setup(await scope([toolExtension("spoof", [tool])]), {
    resolver: async () => {
      approved++;
      return "approved";
    },
  });
  expect((await f.call("ext:spoof:spoof")).errorCode).toBe(
    "INVALID_TOOL_INPUT",
  );
  expect(approved).toBe(0);
  expect(executed).toBe(0);
});

test("built-in manifest reads fresh bounded files, observes revisions and honestly reports ignored/missing/errors", async () => {
  const path = await root();
  await writeFile(join(path, "package.json"), '{"name":"one"}');
  await writeFile(join(path, "go.mod"), "module example");
  await writeFile(join(path, "ignored"), "PRIVATE");
  await symlink(join(path, "ignored"), join(path, "Cargo.toml"));
  const s = await scope(defaultExtensions(), path);
  const f = await setup(s, { mode: "plan", ignore: ["Cargo.toml"] });
  const result = await f.call("ext:builtin.project:manifest", {}, "manifest");
  expect(result.output).toContain('"one"');
  expect(result.output).toContain("module example");
  expect(result.output).not.toContain("PRIVATE");
  expect(Object.keys(f.context.editing.observations)).toContain(
    await f.context.workspace.resolve("package.json"),
  );
  await writeFile(join(path, "package.json"), '{"name":"two"}');
  expect((await f.call("ext:builtin.project:manifest")).output).toContain(
    '"two"',
  );
  expect(
    (await f.call("ext:builtin.project:manifest", { path: "ignored" }))
      .errorCode,
  ).toBe("INVALID_TOOL_INPUT");
  await writeFile(join(path, "package.json"), "x".repeat(512001));
  expect((await f.call("ext:builtin.project:manifest")).errorCode).toBe(
    "INVALID_TOOL_INPUT",
  );
  await rm(join(path, "package.json"));
  await mkdir(join(path, "package.json"));
  expect((await f.call("ext:builtin.project:manifest")).isError).toBe(true);
  const empty = await setup(await scope(defaultExtensions()));
  expect((await empty.call("ext:builtin.project:manifest")).output).toContain(
    "No supported",
  );
  const outside = await root();
  await writeFile(join(outside, "package.json"), "OUTSIDE_SECRET");
  const escaped = await root();
  await symlink(
    outside,
    join(escaped, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await symlink(
    join(escaped, "escape", "package.json"),
    join(escaped, "package.json"),
  );
  const blocked = await setup(await scope(defaultExtensions(), escaped));
  const denied = await blocked.call("ext:builtin.project:manifest");
  expect(denied.isError).toBe(true);
  expect(denied.output).not.toContain("OUTSIDE_SECRET");
});
