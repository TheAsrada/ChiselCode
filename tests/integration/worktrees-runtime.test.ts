import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { DEFAULT_PROJECT_CONFIG } from "../../src/config/load.js";
import { worktreeServiceToken } from "../../src/extensions/builtins/worktrees.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import type { ChiselExtension } from "../../src/extensions/contracts.js";
import {
  ExtensionHost,
  type WorkspaceExtensionScope,
} from "../../src/extensions/host.js";
import { attachExtensionTools } from "../../src/extensions/tools.js";
import { gitIdentity } from "../../src/git/driver.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../src/security/approval.js";
import type { ApprovalMode } from "../../src/security/approval-mode.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { EditingService } from "../../src/tools/editing/service.js";
import { defineTool } from "../../src/tools/handler.js";
import { createLocalToolRuntime } from "../../src/tools/local-runtime.js";
import { workspaceCoordinator } from "../../src/tools/workspace-coordinator.js";
import type { JsonObject } from "../../src/types/domain.js";

const fixtures: { directory: string; host: ExtensionHost }[] = [];
const original = Object.fromEntries(
  ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "LOCALAPPDATA", "APPDATA"].map((key) => [
    key,
    process.env[key],
  ]),
);
afterEach(async () => {
  for (const { directory, host } of fixtures.splice(0)) {
    await host.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
async function git(root: string, ...args: string[]) {
  return (
    await execa(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: root },
    )
  ).stdout;
}
async function fixture(custom: readonly ChiselExtension[] = []) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-worktrees-")),
  );
  for (const key of Object.keys(original))
    process.env[key] = join(directory, "home");
  const root = join(directory, "project with пробел");
  await mkdir(root);
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "core.autocrlf", "false");
  for (const [name, content] of Object.entries({
    "a.txt": "base a\r\n",
    "b.txt": "base b\n",
    "keep.txt": "keep\n",
    "unstaged.txt": "base unstaged\n",
    "gone.txt": "delete me\n",
    "package.json": '{"name":"worktree-real-consumer"}',
    ".gitignore": "node_modules/\ncache/\n",
  }))
    await writeFile(join(root, name), content);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "base");
  const host = new ExtensionHost(defaultExtensions(custom));
  fixtures.push({ directory, host });
  const scope = await host.open(root);
  let decision: (
    request: ApprovalRequest,
  ) => Promise<"approved" | "denied" | "unavailable"> = async () => "approved";
  const previews: ApprovalRequest[] = [];
  let serial = 0;
  const runtime = async (
    scope: WorkspaceExtensionScope,
    mode: "build" | "plan" = "build",
    approvalMode: ApprovalMode = "default",
  ) => {
    const session = createSession(scope.workspaceRoot, "openai", "fixture");
    const store = await projectSessionStore(scope.workspaceRoot);
    const gate = new ApprovalGate(
      DEFAULT_PROJECT_CONFIG,
      {
        approvalMode,
        autoApprove: false,
        nonInteractive: false,
        allowedTools: new Set(),
      },
      {
        requestApproval: async (request) => {
          previews.push(request);
          return decision(request);
        },
      },
    );
    const bus = new RuntimeEventBus(session.id);
    const tools = createLocalToolRuntime(
      scope.workspaceRoot,
      DEFAULT_PROJECT_CONFIG.ignorePatterns,
      gate,
      session,
      [],
      {
        mode,
        approvalMode,
        events: bus,
        checkpoint: () => store.save(session),
        worktrees: scope.services.get(worktreeServiceToken),
        toolGuards: scope.toolGuards,
      },
    );
    await attachExtensionTools(scope, tools.catalog);
    return {
      ...tools,
      session,
      store,
      call: (name: string, input: JsonObject = {}) =>
        tools.executor.execute({ id: `call-${++serial}`, name, input }),
    };
  };
  const tools = await runtime(scope);
  const call = (name: string, input: JsonObject = {}) =>
    tools.call(`ext:builtin.worktrees:${name}`, input);
  const create = async (label: string) => {
    const result = await call("create", { label });
    expect(result.isError, result.output).not.toBe(true);
    return result.details?.worktree as {
      id: string;
      path: string;
      base: string;
    };
  };
  return {
    directory,
    root,
    host,
    scope,
    tools,
    runtime,
    call,
    create,
    previews,
    decide: (next: typeof decision) => {
      decision = next;
    },
  };
}
test("two detached trees isolate edits, transfer committed/staged/unstaged/new text and reject the second conflicting result", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "keep.txt"), "origin staged\n");
  await git(f.root, "add", "keep.txt");
  await writeFile(join(f.root, "origin-new.txt"), "untracked origin");
  const index = await readFile(
    join((await gitIdentity(f.root)).gitDir, "index"),
  );
  const head = await git(f.root, "rev-parse", "HEAD");
  const branches = await git(f.root, "for-each-ref", "refs/heads");
  const a = await f.create("Первая задача");
  const b = await f.create("Вторая задача");
  expect(await git(f.root, "for-each-ref", "refs/heads")).toBe(branches);
  for (const item of [a, b]) {
    expect(await git(item.path, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(item.path, "keep.txt"), "utf8")).toBe("keep\n");
    const result = await execa("git", ["symbolic-ref", "-q", "HEAD"], {
      cwd: item.path,
      reject: false,
    });
    expect(result.exitCode).not.toBe(0);
  }
  const aScope = await f.host.open(a.path),
    bScope = await f.host.open(b.path);
  const ar = await f.runtime(aScope),
    br = await f.runtime(bScope);
  await Promise.all([
    ar.call("read_file", { path: "a.txt" }),
    br.call("read_file", { path: "a.txt" }),
  ]);
  const edits = await Promise.all([
    ar.call("write_file", { path: "a.txt", content: "first\r\n" }),
    br.call("write_file", { path: "a.txt", content: "second\r\n" }),
  ]);
  expect(edits.every((result) => !result.isError)).toBe(true);
  expect(ar.session.runtime?.workspaceObservations).not.toEqual(
    br.session.runtime?.workspaceObservations,
  );
  await git(a.path, "add", "a.txt");
  await git(a.path, "commit", "-m", "committed result");
  await writeFile(join(a.path, "b.txt"), "staged result\n");
  await git(a.path, "add", "b.txt");
  await writeFile(join(a.path, "keep.txt"), "unstaged result\n");
  const newPath =
    process.platform === "win32"
      ? "новый файл UTF8.txt"
      : "новый файл\nUTF8.txt";
  await writeFile(join(a.path, newPath), "Ж\r\n");
  await writeFile(join(a.path, "unstaged.txt"), "unstaged transferred\n");
  await rm(join(a.path, "gone.txt"));
  const diff = await f.call("diff", { id: a.id });
  expect(diff.diffs?.map((item) => item.path)).toContain("a.txt");
  const conflict = await f.call("apply", { id: a.id });
  expect(conflict.errorCode).toBe("WORKTREE_CONFLICT");
  const applied = await f.call("apply", {
    id: a.id,
    paths: ["a.txt", "b.txt", newPath, "unstaged.txt", "gone.txt"],
  });
  expect(applied.isError, applied.output).not.toBe(true);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("first\r\n");
  expect(await readFile(join(f.root, newPath), "utf8")).toBe("Ж\r\n");
  expect(await readFile(join(f.root, "keep.txt"), "utf8")).toBe(
    "origin staged\n",
  );
  expect(
    await readFile(join((await gitIdentity(f.root)).gitDir, "index")),
  ).toEqual(index);
  expect(await git(f.root, "rev-parse", "HEAD")).toBe(head);
  expect(
    (
      await f.call("apply", {
        id: a.id,
        paths: ["a.txt", "b.txt", newPath, "unstaged.txt", "gone.txt"],
      })
    ).output,
  ).toContain("No changes.");
  expect((await f.call("apply", { id: b.id })).errorCode).toBe(
    "WORKTREE_CONFLICT",
  );
  expect(await readFile(join(b.path, "a.txt"), "utf8")).toBe("second\r\n");
  const loaded = await f.tools.store.load(f.tools.session.id);
  expect(
    Object.values(loaded.runtime?.invocations ?? {}).some(
      (record) =>
        record.toolSource?.type === "extension" &&
        record.toolSource.extensionId === "builtin.worktrees" &&
        record.result?.diffs?.length,
    ),
  ).toBe(true);
}, 60_000);

test("Plan/deny/dontAsk do not materialize files; changes during approval invalidate the whole apply", async () => {
  const f = await fixture();
  const plan = await f.runtime(f.scope, "plan");
  expect(
    (await plan.call("ext:builtin.worktrees:create", { label: "blocked" }))
      .errorCode,
  ).toBe("MODE_RESTRICTION");
  expect((await plan.call("ext:builtin.worktrees:list")).isError).not.toBe(
    true,
  );
  f.decide(async () => "denied");
  expect((await f.call("create", { label: "denied" })).errorCode).toBe(
    "PERMISSION_DENIED",
  );
  const dont = await f.runtime(f.scope, "build", "dontAsk");
  expect(
    (await dont.call("ext:builtin.worktrees:create", { label: "dont" }))
      .errorCode,
  ).toBe("PERMISSION_DENIED");
  f.decide(async () => "approved");
  const a = await f.create("approval");
  await writeFile(join(a.path, "a.txt"), "result\n");
  await writeFile(join(a.path, "b.txt"), "result b\n");
  f.decide(async (request) => {
    if (request.tool.endsWith(":apply"))
      await writeFile(join(a.path, "b.txt"), "new source\n");
    return "approved";
  });
  expect((await f.call("apply", { id: a.id })).errorCode).toBe(
    "WORKTREE_STALE",
  );
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("base a\r\n");
  f.decide(async (request) => {
    if (request.tool.endsWith(":apply"))
      await writeFile(join(f.root, "b.txt"), "external target\n");
    return "approved";
  });
  expect((await f.call("apply", { id: a.id })).errorCode).toBe(
    "WORKTREE_STALE",
  );
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("base a\r\n");
  expect(
    f.previews.some(
      (request) =>
        request.source?.type === "extension" &&
        request.source.extensionId === "builtin.worktrees" &&
        request.diffs?.length === 2,
    ),
  ).toBe(true);
}, 60_000);

test("remove refuses active/dirty/ignored/external trees and retains clean committed results across GC/restart", async () => {
  const f = await fixture();
  const a = await f.create("retention");
  const scope = await f.host.open(a.path);
  expect((await f.call("remove", { id: a.id })).errorCode).toBe(
    "WORKTREE_IN_USE",
  );
  await f.host.closeWorkspace(scope.workspaceRoot);
  await mkdir(join(a.path, "node_modules"));
  await writeFile(join(a.path, "node_modules", "data"), "must survive");
  expect((await f.call("remove", { id: a.id })).errorCode).toBe(
    "WORKTREE_DIRTY",
  );
  expect(await readFile(join(a.path, "node_modules", "data"), "utf8")).toBe(
    "must survive",
  );
  // Fixture cleanup is separate from production remove; it is an explicit test action.
  await rm(join(a.path, "node_modules"), { recursive: true });
  await writeFile(join(a.path, "a.txt"), "committed unique result\n");
  await git(a.path, "add", "a.txt");
  await git(a.path, "commit", "-m", "unique");
  const head = await git(a.path, "rev-parse", "HEAD");
  const removed = await f.call("remove", { id: a.id });
  expect(removed.isError, removed.output).not.toBe(true);
  const retained = (removed.details?.worktree ?? {}) as { retainedRef: string };
  const retainedRef = retained.retainedRef;
  expect(retainedRef.startsWith("refs/chiselcode/")).toBe(true);
  await git(f.root, "reflog", "expire", "--expire=now", "--all");
  await git(f.root, "gc", "--prune=now");
  expect(await git(f.root, "show", `${retainedRef}:a.txt`)).toBe(
    "committed unique result",
  );
  expect(await git(f.root, "rev-parse", retainedRef)).toBe(head);
  await f.host.closeWorkspace(f.root);
  const reopened = await f.host.open(f.root);
  const runtime = await f.runtime(reopened);
  expect((await runtime.call("ext:builtin.worktrees:list")).output).toContain(
    retainedRef,
  );
  expect(
    (
      await runtime.call("ext:builtin.worktrees:remove", {
        id: "00000000-0000-4000-8000-000000000000",
      })
    ).errorCode,
  ).toBe("WORKTREE_RECOVERY_REQUIRED");
}, 60_000);

test("unsupported items block the selection atomically, checkout hooks/filters do not run, mixed leases retain parallel file access", async () => {
  const f = await fixture();
  const marker = join(f.root, "hook-ran");
  await writeFile(
    join((await gitIdentity(f.root)).gitDir, "hooks", "post-checkout"),
    "#!/bin/sh\ntouch hook-ran\n",
    { mode: 0o755 },
  );
  const a = await f.create("safe");
  expect(await readFile(marker).catch(() => undefined)).toBeUndefined();
  await writeFile(join(a.path, "a.txt"), "supported\n");
  await writeFile(join(a.path, "binary.dat"), Buffer.from([0, 255]));
  expect((await f.call("diff", { id: a.id })).output).toContain("unsupported");
  expect((await f.call("apply", { id: a.id })).errorCode).toBe(
    "WORKTREE_UNSUPPORTED",
  );
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("base a\r\n");
  expect(
    (await f.call("apply", { id: a.id, paths: ["a.txt"] })).isError,
  ).not.toBe(true);
  await git(f.root, "config", "filter.malicious.smudge", "touch hook-ran");
  await writeFile(join(f.root, ".gitattributes"), "*.txt filter=malicious\n");
  expect((await f.call("create", { label: "unsafe filter" })).errorCode).toBe(
    "WORKTREE_UNSUPPORTED",
  );
  expect(await readFile(marker).catch(() => undefined)).toBeUndefined();
  await git(f.root, "config", "--remove-section", "filter.malicious");
  await rm(join(f.root, ".gitattributes"));
  const other = await f.create("peer");
  const scopes = await Promise.all([
    workspaceCoordinator.scope(a.path),
    workspaceCoordinator.scope(other.path),
  ]);
  const release = await workspaceCoordinator.acquire(
    scopes[0] as string[],
    "write",
  );
  const independent = await workspaceCoordinator.acquire(
    scopes[1] as string[],
    "write",
  );
  independent();
  release();
  const ids = await Promise.all([gitIdentity(a.path), gitIdentity(other.path)]);
  expect(ids[0]?.commonDir).toBe(ids[1]?.commonDir);
  expect(ids[0]?.gitDir).not.toBe(ids[1]?.gitDir);
}, 60_000);

test("core multi-file rollback preserves bytes; concurrent rollback failure remains recoverable", async () => {
  const f = await fixture();
  const a = await f.create("rollback");
  await writeFile(join(a.path, "a.txt"), "result a\n");
  await writeFile(join(a.path, "b.txt"), "result b\n");
  const observations = f.tools.context.editing.observations;
  f.tools.context.editing = new EditingService(
    f.tools.context.workspace,
    observations,
    true,
    async (_operation, index) => {
      if (index === 1) throw new Error("Injected second-file failure");
    },
  );
  const failed = await f.call("apply", { id: a.id });
  expect(failed.errorCode).toBe("PATCH_PARTIAL_FAILURE");
  expect(failed.details?.rolledBack).toEqual([join(f.root, "a.txt")]);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("base a\r\n");
  expect(await readFile(join(f.root, "b.txt"), "utf8")).toBe("base b\n");
  f.tools.context.editing = new EditingService(
    f.tools.context.workspace,
    observations,
    true,
    async (_operation, index) => {
      if (index === 1) {
        await writeFile(join(f.root, "a.txt"), "concurrent editor\n");
        throw new Error("Injected rollback race");
      }
    },
  );
  const partial = await f.call("apply", { id: a.id });
  expect(partial.errorCode).toBe("PATCH_PARTIAL_FAILURE");
  expect(partial.details?.rollbackFailed).toEqual([join(f.root, "a.txt")]);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe(
    "concurrent editor\n",
  );
  expect((await f.call("list")).output).toContain("Нужна проверка");
}, 60_000);

test("real file execution overlaps across roots while mixed common Git writes remain fair and cancellable", async () => {
  const f = await fixture();
  const a = await f.create("parallel A"),
    b = await f.create("parallel B");
  const ar = await f.runtime(await f.host.open(a.path)),
    br = await f.runtime(await f.host.open(b.path));
  await Promise.all([
    ar.call("read_file", { path: "a.txt" }),
    br.call("read_file", { path: "a.txt" }),
  ]);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let both!: () => void;
  const entered = new Promise<void>((resolve) => {
    both = resolve;
  });
  let count = 0;
  for (const tools of [ar, br])
    tools.context.editing = new EditingService(
      tools.context.workspace,
      tools.context.editing.observations,
      true,
      async () => {
        if (++count === 2) both();
        await barrier;
      },
    );
  const writes = Promise.all([
    ar.call("write_file", { path: "a.txt", content: "A\n" }),
    br.call("write_file", { path: "a.txt", content: "B\n" }),
  ]);
  try {
    await Promise.race([
      entered,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("File calls serialized across trees")),
          5000,
        ),
      ),
    ]);
  } finally {
    release();
  }
  expect((await writes).every((result) => !result.isError)).toBe(true);
  const common = `git:common:${(await gitIdentity(a.path)).commonDir}`;
  const held = await workspaceCoordinator.acquirePlan([
    { resource: a.path, mode: "write" },
    { resource: common, mode: "write" },
  ]);
  const abort = new AbortController();
  const cancelled = workspaceCoordinator.acquirePlan(
    [
      { resource: b.path, mode: "write" },
      { resource: common, mode: "write" },
    ],
    abort.signal,
  );
  let nextEntered = false;
  const next = workspaceCoordinator
    .acquirePlan([
      { resource: b.path, mode: "write" },
      { resource: common, mode: "write" },
    ])
    .then((dispose) => {
      nextEntered = true;
      return dispose;
    });
  abort.abort();
  await expect(cancelled).rejects.toThrow();
  expect(nextEntered).toBe(false);
  held();
  (await next)();
}, 60_000);

test("tampered ownership, symlink parents and unknown live process owners cannot authorize removal or apply", async () => {
  const f = await fixture();
  const a = await f.create("tamper");
  const home = join(
    f.directory,
    "home",
    process.platform === "win32" ? "ChiselCode" : "chiselcode",
    "worktrees",
  );
  const repository = join(home, (await readdir(home))[0] as string);
  const registryPath = join(repository, "registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  await writeFile(
    join(repository, "users", "00000000-0000-4000-8000-000000000001.json"),
    JSON.stringify({ id: a.id, host: "unknown-machine", pid: 1 }),
  );
  expect((await f.call("remove", { id: a.id })).errorCode).toBe(
    "WORKTREE_IN_USE",
  );
  await rm(
    join(repository, "users", "00000000-0000-4000-8000-000000000001.json"),
  );
  registry.records[a.id].origin.root = f.directory;
  await writeFile(registryPath, JSON.stringify(registry));
  expect((await f.call("remove", { id: a.id })).errorCode).toBe(
    "WORKTREE_RECOVERY_REQUIRED",
  );
  expect(await readFile(join(a.path, "a.txt"), "utf8")).toBe("base a\r\n");
  registry.records[a.id].origin.root = f.root;
  await writeFile(registryPath, JSON.stringify(registry));
  if (process.platform !== "win32") {
    await symlink(f.directory, join(a.path, "escape"));
    expect((await f.call("apply", { id: a.id })).errorCode).toBe(
      "WORKTREE_UNSUPPORTED",
    );
  }
  expect(
    (await f.call("create", { label: "injection", ref: "--orphan" })).errorCode,
  ).toBe("INVALID_TOOL_INPUT");
}, 60_000);

test("hard process termination reconciles create/remove/apply intents without mutation replay", async () => {
  const f = await fixture();
  const home = join(
    f.directory,
    "home",
    process.platform === "win32" ? "ChiselCode" : "chiselcode",
    "worktrees",
  );
  const registryDirectory = async () =>
    join(home, (await readdir(home))[0] as string);
  const killAt = async (action: string, id = "unused") => {
    const marker = join(f.directory, `${action}.barrier`);
    const child = execa(
      process.execPath,
      [
        join(import.meta.dir, "../fixtures/worktree-crash.ts"),
        f.root,
        action,
        id,
        marker,
      ],
      { reject: false },
    );
    let exited = false;
    void child.then(() => {
      exited = true;
    });
    try {
      const deadline = Date.now() + 10000;
      while (!(await readFile(marker).catch(() => undefined))) {
        if (Date.now() > deadline || exited) {
          child.kill("SIGKILL");
          throw new Error(
            `Crash ${action} barrier missing: ${(await child).stderr}`,
          );
        }
        await Bun.sleep(10);
      }
      child.kill("SIGKILL");
      await child;
      // Advance only the abandoned fixture storage lease expiry after verified
      // child exit; production recovery uses the existing 30s heartbeat lock.
      const old = new Date(Date.now() - 60000);
      await utimes(
        join(await registryDirectory(), "registry.json.lock"),
        old,
        old,
      );
    } finally {
      child.kill("SIGKILL");
      await child;
    }
  };
  await f.create("existing");
  await killAt("create");
  const afterCreate = (await f.call("list")).details?.worktrees as {
    id: string;
    label: string;
    state: string;
    path: string;
  }[];
  const created = afterCreate.find((record) => record.label === "Crash create");
  expect(created?.state).toBe("ready");
  if (!created) throw new Error("Missing created result");
  await writeFile(join(created.path, "a.txt"), "retained crash result\n");
  await git(created.path, "add", "a.txt");
  await git(created.path, "commit", "-m", "retained");
  await killAt("remove", created.id);
  const afterRemove = (await f.call("list")).details?.worktrees as {
    id: string;
    state: string;
    retainedRef: string;
  }[];
  const removed = afterRemove.find((record) => record.id === created.id);
  expect(removed?.state).toBe("removed");
  expect(await git(f.root, "show", `${removed?.retainedRef}:a.txt`)).toBe(
    "retained crash result",
  );
  const partial = await f.create("partial");
  await writeFile(join(partial.path, "a.txt"), "first changed\n");
  await writeFile(join(partial.path, "b.txt"), "second changed\n");
  await killAt("apply", partial.id);
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("first changed\n");
  expect(await readFile(join(f.root, "b.txt"), "utf8")).toBe("base b\n");
  expect((await f.call("list")).output).toContain("Нужна проверка");
  expect((await f.call("apply", { id: partial.id })).errorCode).toBe(
    "WORKTREE_RECOVERY_REQUIRED",
  );
  expect(await readFile(join(f.root, "b.txt"), "utf8")).toBe("base b\n");
}, 60_000);

test("genuine shared-ref tool executions serialize across roots without blocking independent file tools", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let executing = 0;
  const extension: ChiselExtension = {
    id: "fixture.shared-git",
    activate(ctx) {
      ctx.tools.register(
        defineTool(
          {
            name: "ref",
            description: "Actual fixture Git shared ref mutation",
            effect: "git_write",
            permission: "git",
            parallelSafe: false,
          },
          z.object({}),
          async () => ({
            data: {},
            resources: [],
            preview: "git update-ref refs/chiselcode/fixture HEAD",
            command: "git update-ref refs/chiselcode/fixture HEAD",
          }),
          async (context) => {
            executing++;
            enter();
            await barrier;
            await git(
              context.workspace.root,
              "update-ref",
              "refs/chiselcode/fixture",
              "HEAD",
            );
            return { output: "Shared ref updated" };
          },
        ),
      );
    },
  };
  const f = await fixture([extension]);
  const a = await f.create("git A"),
    b = await f.create("git B");
  const ar = await f.runtime(await f.host.open(a.path)),
    br = await f.runtime(await f.host.open(b.path));
  const first = ar.call("ext:fixture.shared-git:ref");
  await started;
  const signal = new AbortController();
  const cancelled = br.executor.execute(
    { id: "cancel-common", name: "ext:fixture.shared-git:ref", input: {} },
    signal.signal,
  );
  const following = br.call("ext:fixture.shared-git:ref");
  const independent = await br.call("read_file", { path: "b.txt" });
  expect(independent.isError).not.toBe(true);
  signal.abort();
  expect((await cancelled).errorCode).toBe("CANCELLED");
  expect(executing).toBe(1);
  release();
  expect((await first).isError).not.toBe(true);
  expect((await following).isError).not.toBe(true);
  expect(executing).toBe(2);
  expect(await git(f.root, "rev-parse", "refs/chiselcode/fixture")).toBe(
    await git(f.root, "rev-parse", "HEAD"),
  );
}, 60_000);

test("failed commit retention never removes the only commit result; per-file source recheck triggers ordinary rollback", async () => {
  const f = await fixture();
  const a = await f.create("retention fault");
  await writeFile(join(a.path, "a.txt"), "unique result\n");
  await git(a.path, "add", "a.txt");
  await git(a.path, "commit", "-m", "result");
  const block = join(
    (await gitIdentity(f.root)).commonDir,
    "refs",
    "chiselcode",
  );
  await writeFile(block, "block retention");
  expect((await f.call("remove", { id: a.id })).isError).toBe(true);
  expect(await readFile(join(a.path, "a.txt"), "utf8")).toBe("unique result\n");
  await rm(block);
  await f.call("list");
  await writeFile(join(a.path, "b.txt"), "result b\n");
  f.tools.context.editing = new EditingService(
    f.tools.context.workspace,
    f.tools.context.editing.observations,
    true,
    async (_operation, index) => {
      if (index === 1)
        await writeFile(join(a.path, "b.txt"), "changed during write\n");
    },
  );
  const result = await f.call("apply", { id: a.id });
  expect(result.errorCode).toBe("PATCH_PARTIAL_FAILURE");
  expect(await readFile(join(f.root, "a.txt"), "utf8")).toBe("base a\r\n");
  expect(await readFile(join(f.root, "b.txt"), "utf8")).toBe("base b\n");
}, 60_000);

test("a resumed former registry writer cannot erase the new owner's reconciliation", async () => {
  const f = await fixture();
  await f.create("existing");
  const home = join(
    f.directory,
    "home",
    process.platform === "win32" ? "ChiselCode" : "chiselcode",
    "worktrees",
  );
  const directory = join(home, (await readdir(home))[0] as string);
  const path = join(directory, "registry.json");
  let entered!: () => void, release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.tools.context.checkpoint = async () => {
    await f.tools.store.save(f.tools.session);
    const registry = JSON.parse(await readFile(path, "utf8"));
    if (
      Object.values(registry.records).some(
        (value) =>
          (value as { label: string; intent?: { phase: string } }).label ===
            "suspended" &&
          (value as { intent?: { phase: string } }).intent?.phase ===
            "executing",
      )
    ) {
      entered();
      await barrier;
    }
  };
  const first = f.call("create", { label: "suspended" });
  try {
    await paused;
    const old = new Date(Date.now() - 60000);
    await utimes(`${path}.lock`, old, old);
    const peer = await execa(
      process.execPath,
      ["src/cli.ts", "--cwd", f.root, "--json", "/worktree list"],
      { cwd: join(import.meta.dir, "../.."), reject: false, timeout: 15000 },
    );
    expect(peer.exitCode, peer.stderr).toBe(0);
    const record = JSON.parse(peer.stdout).details.worktrees.find(
      (record: { label: string }) => record.label === "suspended",
    );
    expect(record.state).toBe("ready");
  } finally {
    release();
  }
  expect((await first).errorCode).toBe("WORKTREE_STALE");
  const registry = JSON.parse(await readFile(path, "utf8"));
  const reconciled = Object.values(registry.records).find(
    (record) => (record as { label: string }).label === "suspended",
  ) as { state: string; lastAction: string };
  expect(reconciled.state).toBe("ready");
  expect(reconciled.lastAction).toBe("create_reconciled");
}, 60_000);

test("cross-process listing during approval preserves a live create; denial leaves a failed non-materialized intent", async () => {
  const f = await fixture();
  f.decide(async (request) => {
    if (!request.tool.endsWith(":create")) return "approved";
    const result = await execa(
      process.execPath,
      ["src/cli.ts", "--cwd", f.root, "--json", "/worktree list"],
      { cwd: join(import.meta.dir, "../.."), reject: false, timeout: 15000 },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      JSON.parse(result.stdout).details.worktrees.some(
        (record: { state: string }) => record.state === "creating",
      ),
    ).toBe(true);
    return request.preview.includes("deny after list") ? "denied" : "approved";
  });
  await f.create("approve after list");
  expect((await f.call("create", { label: "deny after list" })).errorCode).toBe(
    "PERMISSION_DENIED",
  );
  const list = (await f.call("list")).details?.worktrees as {
    label: string;
    state: string;
    path: string;
  }[];
  expect(
    list.find((record) => record.label === "approve after list")?.state,
  ).toBe("ready");
  const denied = list.find((record) => record.label === "deny after list");
  expect(denied?.state).toBe("failed");
  if (!denied) throw new Error("Missing denied intent");
  expect(
    await readFile(join(denied.path, "a.txt")).catch(() => undefined),
  ).toBeUndefined();
}, 60_000);
