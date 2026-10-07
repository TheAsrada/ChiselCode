import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import type {
  ExtensionContext,
  ToolGuard,
  ToolGuardSnapshot,
} from "../../src/extensions/contracts.js";
import { ExtensionHost } from "../../src/extensions/index.js";
import { RuntimeError } from "../../src/runtime/errors.js";
import {
  type RuntimeEvent,
  RuntimeEventBus,
} from "../../src/runtime/events.js";
import {
  type ApprovalDecision,
  ApprovalGate,
} from "../../src/security/approval.js";
import { SecretRedactor } from "../../src/security/redaction.js";
import { createSession } from "../../src/sessions/store.js";
import type { ToolEffect } from "../../src/tools/effects.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import type { ToolHandler, ToolPlan } from "../../src/tools/types.js";
import { workspaceCoordinator } from "../../src/tools/workspace-coordinator.js";
import { resolveWebConfig, type WebConfig } from "../../src/web/schema.js";

const roots: string[] = [];
const hosts: ExtensionHost[] = [];
afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(
  register: (ctx: ExtensionContext) => void,
  options: {
    effect?: ToolEffect;
    mode?: "plan" | "build";
    answer?: ApprovalDecision;
    approvalMode?: "default" | "bypassPermissions";
    bypass?: () => boolean;
    deniedCommands?: string[];
    networkConfig?: () => WebConfig;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "chisel-extension-guard-"));
  roots.push(root);
  const host = new ExtensionHost([{ id: "guard-test", activate: register }]);
  hosts.push(host);
  const scope = await host.open(root);
  const session = createSession(root, "openai", "mock");
  const bus = new RuntimeEventBus(session.id);
  const events: RuntimeEvent[] = [];
  const order: string[] = [];
  const checkpoints: string[] = [];
  const redactor = new SecretRedactor();
  redactor.add("private-fixture-credential");
  bus.subscribe((event) => {
    events.push(event);
  });
  const gate = new ApprovalGate(
    { ...DEFAULT_PROJECT_CONFIG, deniedCommands: options.deniedCommands ?? [] },
    {
      approvalMode: options.approvalMode ?? "default",
      allowBypassPermissions: options.bypass ?? true,
      autoApprove: false,
      allowedTools: new Set(),
      nonInteractive: false,
      network: options.networkConfig
        ? { scope: root, config: options.networkConfig }
        : undefined,
    },
    {
      requestApproval: async () => {
        order.push("approval");
        return options.answer ?? "approved";
      },
    },
  );
  const decide = gate.policy.decide.bind(gate.policy);
  gate.policy.decide = (...args) => {
    order.push("policy");
    return decide(...args);
  };
  const tools = createLocalToolRuntime(root, [], gate, session, [], {
    mode: options.mode,
    approvalMode: options.approvalMode,
    toolGuards: scope.toolGuards,
    events: bus,
    artifactDirectory: join(root, ".artifacts"),
    sanitizeResult: (result) => redactor.value(result),
    checkpoint: async () => {
      checkpoints.push(session.runtime?.invocations.call?.state ?? "none");
    },
  });
  let executed = 0;
  let executedPlan: ToolPlan | undefined;
  const plan: ToolPlan = {
    data: { private: "not exposed" },
    preview: "Real action preview",
    command: "fixture-command original",
    resources: ["file.txt"],
    diffs: [
      {
        path: "file.txt",
        kind: "edit",
        patch: "original patch",
        additions: 1,
        deletions: 0,
      },
    ],
  };
  const handler: ToolHandler = {
    spec: {
      name: "fixture_action",
      description: "Fixture",
      inputSchema: {},
      effect: options.effect ?? "process",
      permission: "fixture",
      parallelSafe: false,
    },
    parse: (input) => input,
    prepare: async () => {
      order.push("prepare");
      return plan;
    },
    execute: async (context, value) => {
      if (value.network)
        context.networkAuthorization?.assertDestination(value.network.hostname);
      order.push("execute");
      executed++;
      executedPlan = value;
      return { output: "done" };
    },
  };
  tools.catalog.register(handler);
  const call = {
    id: "call",
    name: "fixture_action",
    input: { nested: { array: [{ value: "original" }] } },
  };
  return {
    root,
    scope,
    tools,
    gate,
    session,
    bus,
    events,
    checkpoints,
    order,
    handler,
    plan,
    call,
    executed: () => executed,
    executedPlan: () => executedPlan,
  };
}

test("guards run deterministically between prepare, policy/approval and execute without exposing plan internals", async () => {
  const order: string[] = [];
  const f = await fixture((ctx) => {
    ctx.guards.afterPrepare((snapshot) => {
      order.push("after-1");
      expect(snapshot).toMatchObject({
        callId: "call",
        preview: "Real action preview",
        tool: {
          name: "fixture_action",
          source: { type: "local" },
          effect: "process",
        },
      });
      expect(snapshot).not.toHaveProperty("data");
      expect(snapshot).not.toHaveProperty("session");
      expect(snapshot).not.toHaveProperty("handler");
      return { action: "continue" };
    });
    ctx.guards.afterPrepare(() => {
      order.push("after-2");
      return { action: "continue" };
    });
    ctx.guards.beforeExecute(() => {
      order.push("before");
      return { action: "continue" };
    });
  });
  f.order.push = (...items: string[]) => {
    order.push(...items);
    return order.length;
  };
  expect((await f.tools.executor.execute(f.call)).isError).not.toBe(true);
  expect(order).toEqual([
    "prepare",
    "after-1",
    "after-2",
    "policy",
    "policy",
    "approval",
    "before",
    "execute",
  ]);
  expect(f.checkpoints).toEqual(["awaiting_approval", "running", "succeeded"]);
  expect(f.executed()).toBe(1);
});

for (const point of ["afterPrepare", "beforeExecute"] as const)
  for (const kind of ["deny", "error"] as const)
    test(`${point} ${kind} produces one terminal sanitized failure/checkpoint and never starts execution`, async () => {
      let later = false;
      const f = await fixture((ctx) => {
        ctx.guards[point](() => {
          if (kind === "error")
            throw new RuntimeError(
              "CANCELLED",
              "private-fixture-credential raw unexpected error",
            );
          return {
            action: "deny",
            reason: "private-fixture-credential blocked",
          };
        });
        ctx.guards[point](() => {
          later = true;
          return { action: "continue" };
        });
      });
      const result = await f.tools.executor.execute(f.call);
      expect(result.errorCode).toBe(
        kind === "deny" ? "EXTENSION_HOOK_DENIED" : "EXTENSION_HOOK_FAILED",
      );
      expect(result.details).toMatchObject({
        extensionId: "guard-test",
        hookPoint: `tool.${point}`,
      });
      expect(JSON.stringify(result)).not.toContain(
        "private-fixture-credential",
      );
      expect(f.session.runtime?.invocations.call?.state).toBe(
        kind === "deny" ? "denied" : "failed",
      );
      expect(f.checkpoints.at(-1)).toBe(kind === "deny" ? "denied" : "failed");
      expect(
        f.events.filter((event) => event.type === "tool_failed"),
      ).toHaveLength(1);
      expect(
        f.events.some((event) =>
          ["tool_started", "workspace_changed"].includes(event.type),
        ),
      ).toBe(false);
      expect(f.executed()).toBe(0);
      expect(later).toBe(false);
      expect(f.order.includes("approval")).toBe(point === "beforeExecute");
    });

test("continue cannot override core deny, user deny or Plan restrictions", async () => {
  for (const options of [
    { deniedCommands: ["fixture-command"] },
    { answer: "denied" as const },
    { mode: "plan" as const },
  ]) {
    let before = false;
    const f = await fixture((ctx) => {
      ctx.guards.afterPrepare(() => ({ action: "continue" }));
      ctx.guards.beforeExecute(() => {
        before = true;
        return { action: "continue" };
      });
    }, options);
    const result = await f.tools.executor.execute(f.call);
    expect(result.errorCode).toBe(
      options.mode ? "MODE_RESTRICTION" : "PERMISSION_DENIED",
    );
    expect(f.executed()).toBe(0);
    expect(before).toBe(false);
  }
});

test("deeply frozen detached snapshots cannot alter the next guard, approval or executed operation", async () => {
  let checked = 0;
  const f = await fixture((ctx) => {
    const check: ToolGuard = (snapshot) => {
      expect(Object.isFrozen(snapshot.input.nested)).toBe(true);
      expect(Object.isFrozen(snapshot.diffs?.[0])).toBe(true);
      expect(snapshot.input).toEqual({
        nested: { array: [{ value: "original" }] },
      });
      expect(snapshot.command).toBe("fixture-command original");
      expect(snapshot.diffs?.[0]?.patch).toBe("original patch");
      checked++;
      return { action: "continue" };
    };
    ctx.guards.afterPrepare((snapshot) => {
      const mutable = snapshot as unknown as {
        input: { nested: { array: { value: string }[] } };
        command: string;
        diffs: { patch: string }[];
        resources: string[];
      };
      for (const modify of [
        () => {
          if (mutable.input.nested.array[0])
            mutable.input.nested.array[0].value = "changed";
        },
        () => {
          mutable.command = "dangerous";
        },
        () => {
          if (mutable.diffs[0]) mutable.diffs[0].patch = "changed";
        },
        () => {
          mutable.resources.push("outside");
        },
      ])
        expect(modify).toThrow();
      return { action: "continue" };
    });
    ctx.guards.afterPrepare(check);
    ctx.guards.beforeExecute(check);
  });
  expect((await f.tools.executor.execute(f.call)).isError).not.toBe(true);
  expect(checked).toBe(2);
  expect(f.call.input.nested.array[0]?.value).toBe("original");
  expect(f.executedPlan()).toBe(f.plan);
  expect(f.plan.command).toBe("fixture-command original");
  expect(f.plan.resources).toEqual(["file.txt"]);
});

test("waiting guard holds no workspace lease; peer writes are detected by core stale checks", async () => {
  const waiting = deferred<void>();
  const resume = deferred<void>();
  const f = await fixture((ctx) => {
    ctx.guards.beforeExecute(async () => {
      waiting.resolve();
      await resume.promise;
      return { action: "continue" };
    });
  });
  const run = f.tools.executor.execute(f.call);
  await waiting.promise;
  const scope = await workspaceCoordinator.scope(f.root);
  await workspaceCoordinator.withAccess(scope, "write", undefined, async () => {
    await writeFile(join(f.root, "file.txt"), "peer changed");
    workspaceCoordinator.changed(scope);
  });
  resume.resolve();
  expect((await run).errorCode).toBe("STALE_WORKSPACE");
  expect(f.executed()).toBe(0);
});

test("live Bypass revocation during beforeExecute remains enforced", async () => {
  let bypass = true;
  const f = await fixture(
    (ctx) => {
      ctx.guards.beforeExecute(() => {
        bypass = false;
        return { action: "continue" };
      });
    },
    { approvalMode: "bypassPermissions", bypass: () => bypass },
  );
  expect((await f.tools.executor.execute(f.call)).errorCode).toBe(
    "PERMISSION_DENIED",
  );
  expect(f.executed()).toBe(0);
});

test("editing revisions still detect peer writes while a guard waits", async () => {
  const waiting = deferred<void>();
  const resume = deferred<void>();
  const f = await fixture((ctx) => {
    ctx.guards.beforeExecute(async (snapshot) => {
      if (snapshot.tool.name === "edit_file") {
        waiting.resolve();
        await resume.promise;
      }
      return { action: "continue" };
    });
  });
  await writeFile(join(f.root, "a.txt"), "original\n");
  await f.tools.executor.execute({
    id: "read",
    name: "read_file",
    input: { path: "a.txt" },
  });
  const run = f.tools.executor.execute({
    id: "edit",
    name: "edit_file",
    input: { path: "a.txt", old_str: "original", new_str: "new" },
  });
  await waiting.promise;
  const scope = await workspaceCoordinator.scope(f.root);
  await workspaceCoordinator.withAccess(scope, "write", undefined, async () => {
    await writeFile(join(f.root, "a.txt"), "peer\n");
    workspaceCoordinator.changed(scope);
  });
  resume.resolve();
  expect((await run).errorCode).toBe("STALE_FILE_REVISION");
});

test("terminal cached calls never rerun guards; pending approval reruns them, interrupted mutation does not", async () => {
  let guards = 0;
  const f = await fixture((ctx) => {
    ctx.guards.afterPrepare(() => {
      guards++;
      return { action: "continue" };
    });
    ctx.guards.beforeExecute(() => {
      guards++;
      return { action: "continue" };
    });
  });
  const first = await f.tools.executor.execute(f.call);
  expect(await f.tools.executor.execute(f.call)).toBe(first);
  expect(guards).toBe(2);
  const record = f.session.runtime?.invocations.call;
  if (!record) throw new Error("missing record");
  record.state = "awaiting_approval";
  record.result = undefined;
  await f.tools.executor.execute(f.call);
  expect(guards).toBe(4);
  record.state = "running";
  record.result = undefined;
  expect((await f.tools.executor.execute(f.call)).errorCode).toBe(
    "INTERRUPTED_INVOCATION",
  );
  expect(guards).toBe(4);
  expect(f.executed()).toBe(2);
});

for (const point of ["afterPrepare", "beforeExecute"] as const)
  test(`abort during ${point} promptly completes terminal record and consumes late rejection`, async () => {
    const started = deferred<ToolGuardSnapshot>();
    const finish = deferred<never>();
    let later = false;
    const f = await fixture((ctx) => {
      ctx.guards[point]((snapshot) => {
        started.resolve(snapshot);
        return finish.promise;
      });
      ctx.guards[point](() => {
        later = true;
        return { action: "continue" };
      });
    });
    const abort = new AbortController();
    const run = f.tools.executor.execute(f.call, abort.signal);
    const snapshot = await started.promise;
    abort.abort();
    expect((await run).errorCode).toBe("CANCELLED");
    expect(snapshot.signal.aborted).toBe(true);
    expect(f.scope.signal.aborted).toBe(false);
    expect(f.session.runtime?.invocations.call?.state).toBe("cancelled");
    expect(f.events.some((event) => event.type === "tool_started")).toBe(false);
    expect(f.executed()).toBe(0);
    expect(later).toBe(false);
    finish.reject(new Error("late callback failure"));
    await Promise.resolve();
  });

test("pre-aborted calls never enter a guard; empty pipelines never build a clone", async () => {
  let calls = 0;
  const f = await fixture((ctx) => {
    ctx.guards.afterPrepare(() => {
      calls++;
      return { action: "continue" };
    });
  });
  const abort = new AbortController();
  abort.abort();
  expect((await f.tools.executor.execute(f.call, abort.signal)).errorCode).toBe(
    "CANCELLED",
  );
  expect(calls).toBe(0);
  const empty = await fixture(() => {});
  // This private prepare data cannot be cloned, and must never be exposed to guards.
  empty.plan.data = { function: () => {} };
  expect((await empty.tools.executor.execute(empty.call)).isError).not.toBe(
    true,
  );
});

test("MCP permission revocation after an async guard still blocks its handler", async () => {
  const permissions = {
    default: "allow" as const,
    categories: {
      read: "allow" as const,
      write: "allow" as const,
      destructive: "ask" as const,
      unknown: "ask" as const,
    },
    tools: {} as Record<string, "allow" | "deny">,
  };
  const f = await fixture(
    (ctx) => {
      ctx.guards.beforeExecute(() => {
        permissions.tools.create = "deny";
        return { action: "continue" };
      });
    },
    { effect: "external_write" },
  );
  f.handler.spec.source = {
    type: "mcp",
    serverId: "fixture",
    serverTitle: "Fixture",
    originalName: "create",
    category: "write",
    classificationReason: "fixture",
  };
  f.handler.permissions = () => permissions;
  f.plan.approval = {
    serverId: "fixture",
    serverTitle: "Fixture",
    originalName: "create",
    title: "Create",
    category: "write",
    fields: [],
    destructive: false,
    consequence: "Creates data",
  };
  expect((await f.tools.executor.execute(f.call)).errorCode).toBe(
    "PERMISSION_DENIED",
  );
  expect(f.executed()).toBe(0);
});

test("workspace shutdown during prepare maps cancellation before touching a closed guard registry", async () => {
  const waiting = deferred<void>();
  const finish = deferred<void>();
  let callbacks = 0;
  const f = await fixture((ctx) => {
    ctx.guards.afterPrepare(() => {
      callbacks++;
      return { action: "continue" };
    });
  });
  f.handler.prepare = async () => {
    waiting.resolve();
    await finish.promise;
    return f.plan;
  };
  const run = f.tools.executor.execute(f.call, f.scope.signal);
  await waiting.promise;
  await f.scope.dispose();
  finish.resolve();
  expect((await run).errorCode).toBe("CANCELLED");
  expect(f.session.runtime?.invocations.call?.state).toBe("cancelled");
  expect(callbacks).toBe(0);
  expect(f.executed()).toBe(0);
});

test("guards get immutable network destination data without an authorization capability; live deny still wins", async () => {
  let config = resolveWebConfig();
  const f = await fixture(
    (ctx) => {
      ctx.guards.afterPrepare((snapshot) => {
        expect(Object.isFrozen(snapshot.network)).toBe(true);
        expect(snapshot).not.toHaveProperty("networkAuthorization");
        expect(() => {
          (snapshot.network as { hostname: string }).hostname = "localhost";
        }).toThrow();
        return { action: "continue" };
      });
      ctx.guards.beforeExecute(() => {
        config = resolveWebConfig({
          permissions: { denyDomains: ["docs.example"] },
        });
        return { action: "continue" };
      });
    },
    { effect: "external_read", networkConfig: () => config },
  );
  f.plan.network = {
    operation: "fetch",
    hostname: "docs.example",
    url: "https://docs.example/reference",
  };
  expect((await f.tools.executor.execute(f.call)).errorCode).toBe(
    "WEB_NETWORK_DENIED",
  );
  expect(f.executed()).toBe(0);
  expect(f.plan.network.hostname).toBe("docs.example");
});

test("malformed guard decisions cannot spoof approval or escape failure attribution through getters", async () => {
  for (const guard of [
    (() => ({ action: "approved" })) as unknown as ToolGuard,
    (() => ({
      action: "deny",
      get reason(): string {
        throw new Error("raw-secret");
      },
    })) as ToolGuard,
  ]) {
    const f = await fixture((ctx) => {
      ctx.guards.afterPrepare(guard);
    });
    const result = await f.tools.executor.execute(f.call);
    expect(result.errorCode).toBe("EXTENSION_HOOK_FAILED");
    expect(result.details).toMatchObject({ extensionId: "guard-test" });
    expect(result.output).not.toContain("raw-secret");
    expect(f.executed()).toBe(0);
  }
});
