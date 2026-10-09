import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runExtensionCommand } from "../../src/app/run-command.js";
import {
  type ChiselExtension,
  defineTool,
  type ExtensionCommandInvocation,
  ExtensionHost,
} from "../../src/extensions/index.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../../src/security/approval.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";

let directory: string;
const hosts: ExtensionHost[] = [];
const variables = ["XDG_DATA_HOME", "LOCALAPPDATA"] as const;
const env = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chisel-command-runtime-"));
  process.env.XDG_DATA_HOME = directory;
  process.env.LOCALAPPDATA = directory;
  await mkdir(join(directory, "workspace"));
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      profiles: { fixture: { providerId: "anthropic", defaultModel: "model" } },
      defaultProfileId: "fixture",
      web: { enabled: false },
      permissions: { allowBypassPermissions: true },
    }),
  );
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const key of variables) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  await rm(directory, { recursive: true, force: true });
});
async function fixture(
  definitions: ChiselExtension[],
  options: {
    mode?: "plan" | "build";
    approvalMode?: "default" | "dontAsk" | "bypassPermissions";
    decision?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  } = {},
) {
  const host = new ExtensionHost(definitions);
  hosts.push(host);
  const scope = await host.open(join(directory, "workspace"));
  const events: RuntimeEvent[] = [];
  const run = (
    name = "action",
    args = "",
    resume?: string,
    signal?: AbortSignal,
  ) => {
    const command = scope.commands.get(name);
    return runExtensionCommand(
      { command, input: command.parse(args) },
      scope,
      {
        cwd: scope.workspaceRoot,
        resume,
        configPath: join(directory, "config.json"),
        interactive: true,
        mode: options.mode ?? "build",
        approvalMode: options.approvalMode ?? "default",
      },
      { requestApproval: options.decision ?? (async () => "approved") },
      {
        onEvent: (event) => {
          events.push(event);
        },
      },
      signal,
    );
  };
  return { host, scope, events, run };
}
function action(
  execute: (
    context: ExtensionCommandInvocation,
  ) => Promise<import("../../src/types/domain.js").ToolExecutionResult>,
  extra?: ChiselExtension["activate"],
): ChiselExtension {
  return {
    id: "fixture",
    activate(ctx) {
      extra?.(ctx);
      ctx.commands.register({
        name: "action",
        description: "Fixture action",
        parse: () => undefined,
        execute,
      });
    },
  };
}

test("local command execution can precede model profile and credential setup", async () => {
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      profiles: {},
      web: { enabled: false },
    }),
  );
  await writeFile(
    join(directory, "workspace", "note.txt"),
    "local reference\n",
  );
  const f = await fixture([
    action((context) =>
      context.tools.execute("read_file", { path: "note.txt" }),
    ),
  ]);
  const outcome = await f.run();
  expect(outcome.result.isError).toBeUndefined();
  expect(outcome.result.output).toContain("local reference");
  expect(outcome.session.messages).toEqual([]);
  const store = await projectSessionStore(f.scope.workspaceRoot);
  expect((await store.load(outcome.session.id)).profileId).toBe(
    outcome.session.profileId,
  );
  expect(
    JSON.parse(await readFile(join(directory, "config.json"), "utf8")).profiles,
  ).toEqual({});
});

test("both guards veto command tools, including Bypass; snapshots retain tool attribution", async () => {
  for (const point of ["afterPrepare", "beforeExecute"] as const) {
    let approvals = 0;
    const f = await fixture(
      [
        action(
          (context) => context.tools.execute("ext:fixture:write", {}),
          (ctx) => {
            ctx.tools.register(
              defineTool(
                {
                  name: "write",
                  description: "Write",
                  effect: "workspace_write",
                  permission: "write",
                  parallelSafe: false,
                },
                z.object({}),
                async () => ({
                  data: undefined,
                  preview: "Write",
                  resources: [],
                }),
                async () => {
                  throw new Error("Should never execute");
                },
              ),
            );
            ctx.guards[point]((snapshot) => {
              expect(snapshot.tool.source).toEqual({
                type: "extension",
                extensionId: "fixture",
                originalName: "write",
              });
              return { action: "deny", reason: "Fixture veto" };
            });
          },
        ),
      ],
      {
        approvalMode:
          point === "afterPrepare" ? "bypassPermissions" : "default",
        decision: async () => {
          approvals++;
          return "approved";
        },
      },
    );
    const result = await f.run();
    expect(result.result.errorCode).toBe("EXTENSION_HOOK_DENIED");
    expect(approvals).toBe(point === "afterPrepare" ? 0 : 1);
    expect(f.events.some((event) => event.type === "tool_started")).toBe(false);
    expect(
      Object.values(result.session.runtime?.invocations ?? {})[0]?.state,
    ).toBe("denied");
  }
});

test("pending approval, user deny and Plan keep ordinary checkpoint/error semantics", async () => {
  const extension = action((context) =>
    context.tools.execute("write_file", { path: "note.txt", content: "new\n" }),
  );
  for (const decision of ["unavailable", "denied"] as const) {
    const f = await fixture([extension], { decision: async () => decision });
    const outcome = await f.run();
    expect(outcome.result.errorCode).toBe(
      decision === "unavailable" ? "APPROVAL_UNAVAILABLE" : "PERMISSION_DENIED",
    );
    expect(outcome.result.requiresApproval).toBe(
      decision === "unavailable" ? true : undefined,
    );
    expect(
      Object.values(outcome.session.runtime?.invocations ?? {})[0]?.state,
    ).toBe(decision === "unavailable" ? "awaiting_approval" : "denied");
    expect(f.events.some((event) => event.type === "tool_started")).toBe(false);
    await expect(
      readFile(join(f.scope.workspaceRoot, "note.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
  const f = await fixture([extension], {
    mode: "plan",
    approvalMode: "bypassPermissions",
  });
  expect((await f.run()).result.errorCode).toBe("MODE_RESTRICTION");
});

test("stale file checks survive approval waits for command edits", async () => {
  await writeFile(join(directory, "workspace", "note.txt"), "old\n");
  const extension = action(async (context) => {
    await context.tools.execute("read_file", { path: "note.txt" });
    return context.tools.execute("write_file", {
      path: "note.txt",
      content: "approved\n",
    });
  });
  const f = await fixture([extension], {
    decision: async () => {
      await writeFile(join(directory, "workspace", "note.txt"), "concurrent\n");
      return "approved";
    },
  });
  const outcome = await f.run();
  expect(outcome.result.errorCode).toBe("STALE_FILE_REVISION");
  expect(await readFile(join(f.scope.workspaceRoot, "note.txt"), "utf8")).toBe(
    "concurrent\n",
  );
});

test("a sibling command invalidates an approved process plan before it can execute", async () => {
  const root = join(directory, "workspace");
  await writeFile(join(root, "note.txt"), "old\n");
  let sibling: () => Promise<unknown> = async () => {};
  const f = await fixture(
    [
      action((context) =>
        context.tools.execute("run_shell", {
          command: "echo process-must-not-start",
        }),
      ),
    ],
    {
      decision: async () => {
        await sibling();
        return "approved";
      },
    },
  );
  // Both commands use the real process-wide coordinator, with separate Sessions.
  const peer = await fixture([
    action(async (context) => {
      await context.tools.execute("read_file", { path: "note.txt" });
      return context.tools.execute("write_file", {
        path: "note.txt",
        content: "sibling\n",
      });
    }),
  ]);
  sibling = async () => {
    expect((await peer.run()).result.isError).toBeUndefined();
  };
  const outcome = await f.run();
  expect(outcome.result.errorCode).toBe("STALE_WORKSPACE");
  expect(await readFile(join(root, "note.txt"), "utf8")).toBe("sibling\n");
  expect(
    Object.values(outcome.session.runtime?.invocations ?? {})[0]?.state,
  ).toBe("failed");
});

test("a callback cannot mutate denied tool results into success or corrupt persisted records", async () => {
  const f = await fixture(
    [
      action(async (context) => {
        const result = await context.tools.execute("run_shell", {
          command: "echo forbidden",
        });
        try {
          result.isError = false;
          result.errorCode = undefined;
        } catch {
          /* Frozen DTO rejects mutation. */
        }
        return {
          output: "False success",
          details: { command: { extensionId: "forged" } },
        };
      }),
    ],
    { approvalMode: "dontAsk" },
  );
  const outcome = await f.run();
  expect(outcome.result.errorCode).toBe("PERMISSION_DENIED");
  expect(outcome.result.details?.command).toEqual({
    extensionId: "fixture",
    name: "action",
  });
  const store = await projectSessionStore(f.scope.workspaceRoot);
  const restored = await store.load(outcome.session.id);
  expect(
    Object.values(restored.runtime?.invocations ?? {})[0]?.result?.isError,
  ).toBe(true);
  expect(restored.messages).toEqual([]);
});

test("command ownership waits for unawaited core tools and closes retained execution ports", async () => {
  let release = () => {};
  let started = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let retained: ExtensionCommandInvocation | undefined;
  const f = await fixture([
    action(
      async (context) => {
        retained = context;
        void context.tools.execute("ext:fixture:wait", {});
        return { output: "Callback returned" };
      },
      (ctx) =>
        ctx.tools.register(
          defineTool(
            {
              name: "wait",
              description: "Wait",
              effect: "read",
              permission: "read",
              parallelSafe: true,
              workspaceAccess: "none",
            },
            z.object({}),
            async () => ({ data: undefined, preview: "Wait", resources: [] }),
            async () => {
              started();
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              return { output: "Wait completed" };
            },
          ),
        ),
    ),
  ]);
  let completed = false;
  const run = f.run().then((value) => {
    completed = true;
    return value;
  });
  await entered;
  expect(completed).toBe(false);
  expect(Object.isFrozen(retained)).toBe(true);
  expect(Object.isFrozen(retained?.tools)).toBe(true);
  release();
  const outcome = await run;
  expect(outcome.result.isError).toBeUndefined();
  expect(
    (await retained?.tools.execute("read_file", { path: "x" }))?.errorCode,
  ).toBe("CANCELLED");
  expect(
    Object.values(outcome.session.runtime?.invocations ?? {}),
  ).toHaveLength(1);
});

test("caller cancellation and cooperative tool timeout retain core states without closing the workspace", async () => {
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture([
    action(
      (context) => context.tools.execute("ext:fixture:cooperative", {}),
      (ctx) =>
        ctx.tools.register(
          defineTool(
            {
              name: "cooperative",
              description: "Wait for cancellation",
              effect: "read",
              permission: "read",
              parallelSafe: true,
              workspaceAccess: "none",
              timeoutMs: 50,
            },
            z.object({}),
            async () => ({ data: undefined, preview: "Wait", resources: [] }),
            async (context) => {
              entered();
              await new Promise<void>((resolve) => {
                if (context.signal?.aborted) resolve();
                else
                  context.signal?.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
              });
              return { output: "Operation settled" };
            },
          ),
        ),
    ),
  ]);
  const operation = new AbortController();
  const active = f.run("action", "", undefined, operation.signal);
  await started;
  operation.abort();
  const cancelled = await active;
  expect(cancelled.result.errorCode).toBe("CANCELLED");
  expect(
    Object.values(cancelled.session.runtime?.invocations ?? {})[0]?.state,
  ).toBe("cancelled");
  expect(f.scope.signal.aborted).toBe(false);
  const timeout = await f.run("action", "", cancelled.session.id);
  expect(timeout.result.errorCode).toBe("TOOL_TIMEOUT");
  const store = await projectSessionStore(f.scope.workspaceRoot);
  expect(
    Object.values(
      (await store.load(timeout.session.id)).runtime?.invocations ?? {},
    ).map((record) => record.state),
  ).toEqual(["cancelled", "failed"]);
  const before = f.events.length;
  await expect(
    f.run("action", "", undefined, AbortSignal.abort()),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  expect(f.events.length).toBe(before);
});

test("pure feedback creates no fake tool events and unknown tools remain controlled failures", async () => {
  const f = await fixture([
    action(async () => ({
      output: "Hello",
      details: { command: { extensionId: "fake" } },
    })),
  ]);
  const outcome = await f.run();
  expect(outcome.result.details?.command).toEqual({
    extensionId: "fixture",
    name: "action",
  });
  expect(f.events.map((event) => event.type)).toEqual(["checkpoint_saved"]);
  expect(outcome.session.messages).toEqual([]);
  const unknown = await fixture([
    action((context) => context.tools.execute("not-installed.inspect", {})),
  ]);
  expect((await unknown.run()).result.errorCode).toBe("INVALID_TOOL_INPUT");
});

test("foreground command model port uses real driver without main history/events and seals a retained port", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-foreground-model-key";
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;
      const body = (await request.json()) as {
        tools?: unknown[];
        model: string;
      };
      expect(body.tools ?? []).toEqual([]);
      expect(body.model).toBe("foreground-captured");
      return new Response(
        `data: ${JSON.stringify({ id: "fore", choices: [{ index: 0, delta: { content: "A deterministic separate answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 14, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  let retained: ExtensionCommandInvocation["model"] | undefined;
  try {
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        schemaVersion: 2,
        profiles: {
          fixture: {
            providerId: "openai-compatible",
            defaultModel: "foreground-captured",
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
          },
        },
        defaultProfileId: "fixture",
        web: { enabled: false },
      }),
    );
    const f = await fixture([
      action(async (context) => {
        retained = context.model;
        const answer = await context.model.request({
          text: "Answer without tools",
          context: "none",
        });
        return {
          output: answer.text,
          isError: answer.status !== "completed",
          errorCode: answer.error?.code,
        };
      }),
    ]);
    const outcome = await f.run();
    expect(outcome.result.output).toBe("A deterministic separate answer");
    expect(requests).toBe(1);
    expect(outcome.session.messages).toEqual([]);
    expect(outcome.session.sideQueries?.[0]?.owner.extensionId).toBe("fixture");
    expect(outcome.session.totalTokens.inputTokens).toBe(14);
    expect(
      f.events.some(
        (event) =>
          event.type === "provider_turn_completed" ||
          event.type === "tool_started",
      ),
    ).toBe(false);
    if (!retained) throw new Error("Model port absent");
    await expect(
      retained.request({ text: "late", context: "none" }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(requests).toBe(1);
  } finally {
    server.stop(true);
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});
