import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { RuntimeError } from "../../src/runtime/errors.js";
import {
  type ApprovalDecision,
  ApprovalGate,
  type ApprovalRequest,
  type ApprovalResolver,
} from "../../src/security/approval.js";
import { createSession } from "../../src/sessions/store.js";
import { EditingService } from "../../src/tools/editing/service.js";
import { defineTool } from "../../src/tools/handler.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import { workspaceCoordinator } from "../../src/tools/workspace-coordinator.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chisel-parallel-tools-"));
  roots.push(root);
  return root;
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
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
    resolver: {
      requestApproval: async (request: ApprovalRequest) => {
        requested.resolve(request);
        return decision.promise;
      },
    },
  };
}
function runtime(root: string, resolver?: ApprovalResolver) {
  const session = createSession(root, "anthropic", "mock");
  const gate = new ApprovalGate(
    DEFAULT_PROJECT_CONFIG,
    {
      approvalMode: resolver ? "default" : "bypassPermissions",
      allowBypassPermissions: !resolver,
      autoApprove: false,
      allowedTools: new Set(),
      nonInteractive: false,
    },
    resolver ?? { requestApproval: async () => "unavailable" },
  );
  return createLocalToolRuntime(root, [], gate, session, [], {
    artifactDirectory: join(root, ".artifacts", session.id),
  });
}

test("two approved edits cannot overwrite the same observed revision", async () => {
  const root = await fixture();
  await writeFile(join(root, "file.txt"), "original");
  const approvalA = approval();
  const approvalB = approval();
  const a = runtime(root, approvalA.resolver);
  const b = runtime(root, approvalB.resolver);
  await Promise.all(
    [a, b].map((tools) =>
      tools.executor.execute({
        id: "read",
        name: "read_file",
        input: { path: "file.txt" },
      }),
    ),
  );
  const entered = deferred<void>();
  const release = deferred<void>();
  a.context.editing = new EditingService(
    a.context.workspace,
    a.context.editing.observations,
    true,
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  const first = a.executor.execute({
    id: "write-a",
    name: "write_file",
    input: { path: "file.txt", content: "first" },
  });
  const second = b.executor.execute({
    id: "write-b",
    name: "write_file",
    input: { path: "file.txt", content: "second" },
  });
  await Promise.all([approvalA.requested.promise, approvalB.requested.promise]);
  approvalA.decision.resolve("approved");
  await entered.promise;
  approvalB.decision.resolve("approved");
  release.resolve();
  const [resultA, resultB] = await Promise.all([first, second]);
  expect(resultA.isError).not.toBe(true);
  expect(resultB.errorCode).toBe("STALE_FILE_REVISION");
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("first");
  await b.executor.execute({
    id: "fresh-read",
    name: "read_file",
    input: { path: "file.txt" },
  });
  expect(
    (
      await b.executor.execute({
        id: "fresh-write",
        name: "write_file",
        input: { path: "file.txt", content: "fresh second" },
      })
    ).isError,
  ).not.toBe(true);
  expect(await readFile(join(root, "file.txt"), "utf8")).toBe("fresh second");
});

test("independent files both commit and pending approvals never hold the workspace", async () => {
  const root = await fixture();
  const approvalA = approval();
  const approvalB = approval();
  const a = runtime(root, approvalA.resolver);
  const b = runtime(root, approvalB.resolver);
  const first = a.executor.execute({
    id: "create-a",
    name: "write_file",
    input: { path: "a.txt", content: "a" },
  });
  const second = b.executor.execute({
    id: "create-b",
    name: "write_file",
    input: { path: "b.txt", content: "b" },
  });
  await Promise.all([approvalA.requested.promise, approvalB.requested.promise]);
  expect(
    (
      await runtime(root).executor.execute({
        id: "list",
        name: "list_dir",
        input: { path: "." },
      })
    ).isError,
  ).not.toBe(true);
  approvalA.decision.resolve("approved");
  approvalB.decision.resolve("approved");
  const results = await Promise.all([first, second]);
  expect(results.every((result) => !result.isError)).toBe(true);
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("a");
  expect(await readFile(join(root, "b.txt"), "utf8")).toBe("b");
});

for (const effect of ["process", "git_write"] as const) {
  test(`${effect} approval becomes stale when another tab changes the workspace`, async () => {
    const root = await fixture();
    const pending = approval();
    const a = runtime(root, pending.resolver);
    const b = runtime(root);
    let executions = 0;
    a.catalog.register(
      defineTool(
        {
          name: "sensitive_action",
          description: "action",
          effect,
          permission: "shell",
          parallelSafe: false,
        },
        z.object({}),
        async () => ({
          data: {},
          resources: [],
          preview: "approved action",
          command: "echo action",
        }),
        async () => {
          executions++;
          return { output: "executed" };
        },
      ),
    );
    const first = a.executor.execute({
      id: "stale",
      name: "sensitive_action",
      input: {},
    });
    await pending.requested.promise;
    expect(
      (
        await b.executor.execute({
          id: "change",
          name: "write_file",
          input: { path: "peer.txt", content: "changed" },
        })
      ).isError,
    ).not.toBe(true);
    pending.decision.resolve("approved");
    expect((await first).errorCode).toBe("STALE_WORKSPACE");
    expect(executions).toBe(0);
    expect(
      (
        await a.executor.execute({
          id: "fresh",
          name: "sensitive_action",
          input: {},
        })
      ).isError,
    ).not.toBe(true);
    expect(executions).toBe(1);
  });
}

test("reads cannot observe a half-applied patch and access remains held through rollback", async () => {
  const root = await fixture();
  await writeFile(join(root, "a.txt"), "original a");
  await writeFile(join(root, "b.txt"), "original b");
  const a = runtime(root);
  const b = runtime(root);
  await Promise.all(
    ["a.txt", "b.txt"].map((path) =>
      a.executor.execute({ id: path, name: "read_file", input: { path } }),
    ),
  );
  const entered = deferred<void>();
  const release = deferred<void>();
  a.context.editing = new EditingService(
    a.context.workspace,
    a.context.editing.observations,
    true,
    async (_operation, index) => {
      if (index === 1) {
        entered.resolve();
        await release.promise;
        throw new RuntimeError("PATCH_CONFLICT", "simulated failure");
      }
    },
  );
  const patch = a.executor.execute({
    id: "patch",
    name: "apply_patch",
    input: {
      patchText:
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-original a\n+new a\n*** Update File: b.txt\n@@\n-original b\n+new b\n*** End Patch",
    },
  });
  await entered.promise;
  expect(await readFile(join(root, "a.txt"), "utf8")).toBe("new a");
  let readFinished = false;
  const read = b.executor
    .execute({ id: "peer-read", name: "read_file", input: { path: "a.txt" } })
    .then((result) => {
      readFinished = true;
      return result;
    });
  await Bun.sleep(20);
  expect(readFinished).toBe(false);
  release.resolve();
  expect((await patch).isError).toBe(true);
  const result = await read;
  expect(result.output).toContain("original a");
  expect(result.output).not.toContain("new a");
  expect(await readFile(join(root, "b.txt"), "utf8")).toBe("original b");
  expect(
    (
      await b.executor.execute({
        id: "after-rollback",
        name: "write_file",
        input: { path: "c.txt", content: "c" },
      })
    ).isError,
  ).not.toBe(true);
});

test("cancelling a tool waiting for workspace access leaves its peer running", async () => {
  const root = await fixture();
  const scope = await workspaceCoordinator.scope(root);
  const unlock = await workspaceCoordinator.acquire(scope, "write");
  const abort = new AbortController();
  const tools = runtime(root);
  const waiting = tools.executor.execute(
    {
      id: "cancel",
      name: "write_file",
      input: { path: "cancelled.txt", content: "never written" },
    },
    abort.signal,
  );
  abort.abort();
  expect((await waiting).errorCode).toBe("CANCELLED");
  const peer = runtime(root).executor.execute({
    id: "peer",
    name: "write_file",
    input: { path: "peer.txt", content: "written" },
  });
  unlock();
  expect((await peer).isError).not.toBe(true);
  expect(await readFile(join(root, "peer.txt"), "utf8")).toBe("written");
  expect(
    await readFile(join(root, "cancelled.txt")).catch(() => undefined),
  ).toBeUndefined();
});

test("workspace changes from another tab reset repeated-failure detection", async () => {
  const root = await fixture();
  const a = runtime(root);
  const b = runtime(root);
  for (let i = 0; i < 3; i++)
    await a.executor.execute({
      id: `missing-${i}`,
      name: "read_file",
      input: { path: "missing.txt" },
    });
  expect(
    (
      await a.executor.execute({
        id: "blocked",
        name: "read_file",
        input: { path: "missing.txt" },
      })
    ).errorCode,
  ).toBe("REPEATED_CALL_DETECTED");
  await b.executor.execute({
    id: "create",
    name: "write_file",
    input: { path: "missing.txt", content: "now exists" },
  });
  const result = await a.executor.execute({
    id: "retry",
    name: "read_file",
    input: { path: "missing.txt" },
  });
  expect(result.isError).not.toBe(true);
  expect(result.output).toContain("now exists");
});

test("failed shell actions invalidate peer approvals even when they return an error", async () => {
  const root = await fixture();
  const pending = approval();
  const a = runtime(root, pending.resolver);
  const b = runtime(root);
  a.catalog.register(
    defineTool(
      {
        name: "later_command",
        description: "command",
        effect: "process",
        permission: "shell",
        parallelSafe: false,
      },
      z.object({}),
      async () => ({
        data: {},
        resources: [],
        preview: "later command",
        command: "echo later",
      }),
      async () => ({ output: "should not run" }),
    ),
  );
  b.catalog.register(
    defineTool(
      {
        name: "partial_command",
        description: "command",
        effect: "process",
        permission: "shell",
        parallelSafe: false,
      },
      z.object({}),
      async () => ({
        data: {},
        resources: [],
        preview: "partial command",
        command: "echo partial",
      }),
      async () => {
        await writeFile(join(root, "partial.txt"), "changed before failure");
        return { output: "failed", isError: true };
      },
    ),
  );
  const waiting = a.executor.execute({
    id: "pending",
    name: "later_command",
    input: {},
  });
  await pending.requested.promise;
  expect(
    (
      await b.executor.execute({
        id: "partial",
        name: "partial_command",
        input: {},
      })
    ).isError,
  ).toBe(true);
  pending.decision.resolve("approved");
  expect((await waiting).errorCode).toBe("STALE_WORKSPACE");
  expect(await readFile(join(root, "partial.txt"), "utf8")).toBe(
    "changed before failure",
  );
});
