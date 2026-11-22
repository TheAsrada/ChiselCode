import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionToolRuntime } from "../../src/app/tool-runtime.js";
import type { BackgroundControls } from "../../src/background/binding.js";
import { loadGlobalConfig, loadProjectConfig } from "../../src/config/load.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import {
  SCRATCH_LIMITS,
  ScratchWorkspace,
} from "../../src/scratch/workspace.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import type { Session } from "../../src/types/domain.js";
import { quoteShellArg } from "../helpers/shell.js";

const homeKeys = [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
];
const projectName = "Проект с пробелом";
const [childRoot, sessionId] = process.argv.slice(2);
const host = new ExtensionHost(defaultExtensions());
let approve = true;

async function runtime(
  project: string,
  session?: Session,
  mode: "build" | "plan" = "build",
) {
  const scope = await host.open(project);
  const root = scope.workspaceRoot;
  const store = await projectSessionStore(root);
  session ??= store.create("openai", "fixture");
  await store.save(session);
  const config = await loadProjectConfig(root);
  let controls: BackgroundControls | undefined;
  const tools = await createSessionToolRuntime({
    root,
    scope,
    session,
    store,
    config: { ...config, deniedCommands: ["forbidden-scratch-command"] },
    global: await loadGlobalConfig(),
    mode,
    approvalMode: "default",
    options: { interactive: true },
    events: new RuntimeEventBus(session.id),
    signal: new AbortController().signal,
    onBackgroundControls: (value) => {
      controls = value;
    },
    resolver: {
      async requestApproval() {
        return approve ? "approved" : "denied";
      },
    },
  });
  const call = (input: Record<string, unknown>, signal?: AbortSignal) =>
    tools.executor.execute(
      { id: crypto.randomUUID(), name: "scratch_workspace", input },
      signal,
    );
  const shell = (
    command: string,
    options: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) =>
    tools.executor.execute(
      {
        id: crypto.randomUUID(),
        name: "run_shell",
        input: { command, scratch: true, ...options },
      },
      signal,
    );
  assert.ok(controls);
  return { store, session, tools, call, shell, controls };
}

async function until<T>(check: () => Promise<T | undefined>, deadline: number) {
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await Bun.sleep(30);
  }
  throw new Error("Scratch fixture did not reach its barrier.");
}

const bun = (name: string) => `${quoteShellArg(process.execPath)} ${name}`;
function ok(result: { isError?: boolean; output: string }) {
  assert.ok(!result.isError, result.output);
  return result.output;
}
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

if (childRoot && sessionId) {
  const store = await projectSessionStore(childRoot);
  const owner = await runtime(childRoot, await store.load(sessionId));
  ok(await owner.shell(bun("wait.cjs")));
  throw new Error(
    "Expected the test owner to crash while the command was running.",
  );
}

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-scratch-")),
);
const project = join(directory, projectName);
const otherProject = join(directory, "peer");
for (const key of homeKeys) process.env[key] = join(directory, "app-data");
await mkdir(project);
await mkdir(otherProject);
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const before = await readdir(project);
  const owner = await runtime(project);
  const other = await runtime(project);
  const peerScope = await ScratchWorkspace.forSession(
    otherProject,
    owner.session.id,
  );
  const workspace = await ScratchWorkspace.forSession(
    project,
    owner.session.id,
  );
  assert.notEqual(peerScope.path, workspace.path);
  const schema = owner.tools.catalog
    .selectForTurn()
    .find((tool) => tool.name === "scratch_workspace");
  assert.equal(schema?.inputSchema.type, "object");
  const write = (name: string, content: string) =>
    owner.call({ action: "write", name, content });
  const script =
    "const fs=require('node:fs');fs.writeFileSync('result.txt','готово'); console.log('scratch-ok');";
  approve = false;
  assert.equal(
    (await write("check.cjs", script)).errorCode,
    "PERMISSION_DENIED",
  );
  assert.equal(
    (await owner.shell(bun("check.cjs"))).errorCode,
    "PERMISSION_DENIED",
  );
  await assert.rejects(readdir(workspace.path), missing);
  approve = true;
  assert.equal(
    (await owner.shell("forbidden-scratch-command")).errorCode,
    "PERMISSION_DENIED",
  );
  const plan = await runtime(otherProject, undefined, "plan");
  assert.equal(
    (await plan.call({ action: "clear" })).errorCode,
    "MODE_RESTRICTION",
  );
  assert.equal(
    (await plan.shell(bun("check.cjs"))).errorCode,
    "MODE_RESTRICTION",
  );
  await plan.tools.dispose();

  ok(await write("check.cjs", script));
  assert.match(ok(await owner.shell(bun("check.cjs"))), /scratch-ok/);
  assert.equal(
    ok(await owner.call({ action: "read", name: "result.txt" })),
    "готово",
  );
  assert.match(ok(await owner.shell(bun("check.cjs"))), /scratch-ok/);
  ok(
    await write(
      "check.py",
      "from pathlib import Path\nprint(Path('result.txt').read_text(encoding='utf-8'))\n",
    ),
  );
  assert.match(
    ok(
      await owner.shell(
        `${process.platform === "win32" ? "python" : "python3"} check.py`,
      ),
    ),
    /готово/,
  );
  assert.equal(
    (await other.call({ action: "read", name: "check.cjs" })).errorCode,
    "SCRATCH_FILE_MISSING",
  );
  assert.deepEqual(await readdir(project), before);

  for (const name of [
    "../marker",
    "..\\marker",
    "x:stream",
    "nul.txt",
    "x\n",
    "/file",
    "X.js",
  ])
    assert.equal(
      (await write(name, "invalid")).errorCode,
      "INVALID_TOOL_INPUT",
      name,
    );
  for (const input of [
    { cwd: ".." },
    { background: true },
    { targetWorktreeId: crypto.randomUUID() },
  ])
    assert.equal(
      (await owner.shell(bun("check.cjs"), input)).errorCode,
      "INVALID_TOOL_INPUT",
    );
  assert.equal(
    (await write("size.txt", "я".repeat(SCRATCH_LIMITS.fileBytes))).errorCode,
    "SCRATCH_LIMIT",
  );

  const oversized = join(workspace.path, "oversized.bin");
  await writeFile(oversized, "");
  await truncate(oversized, SCRATCH_LIMITS.totalBytes);
  assert.equal(
    (await owner.shell(bun("check.cjs"))).errorCode,
    "SCRATCH_LIMIT",
  );
  ok(await owner.call({ action: "remove", name: "oversized.bin" }));
  ok(await write("replace.txt", "long text"));
  ok(await write("replace.txt", "short"));
  assert.equal(
    ok(await owner.call({ action: "read", name: "replace.txt" })),
    "short",
  );

  const outside = join(directory, "outside");
  await mkdir(outside);
  const marker = join(outside, "marker");
  await writeFile(marker, "untouched");
  await link(marker, join(workspace.path, "linked.txt"));
  assert.equal(
    (await owner.call({ action: "read", name: "linked.txt" })).errorCode,
    "SCRATCH_UNSAFE_PATH",
  );
  assert.equal(
    (await write("linked.txt", "changed")).errorCode,
    "SCRATCH_UNSAFE_PATH",
  );
  await rm(join(workspace.path, "linked.txt"));
  await symlink(
    outside,
    join(workspace.path, "junction"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    (await owner.shell(bun("check.cjs"))).errorCode,
    "SCRATCH_UNSAFE_PATH",
  );
  ok(await owner.call({ action: "clear" }));
  assert.equal(await readFile(marker, "utf8"), "untouched");
  await symlink(
    outside,
    workspace.path,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    (await owner.call({ action: "clear" })).errorCode,
    "SCRATCH_UNSAFE_PATH",
  );
  await rm(workspace.path);

  ok(await write("check.cjs", script));
  const stage = join(workspace.path, `.chisel-write-${crypto.randomUUID()}`);
  await writeFile(stage, "unpublished");
  ok(await owner.call({ action: "list" }));
  await assert.rejects(readFile(stage), missing);
  assert.equal(
    await readFile(join(workspace.path, "check.cjs"), "utf8"),
    script,
  );

  ok(
    await write(
      "wait.cjs",
      "require('node:fs').appendFileSync('ready.txt','run\\n');setInterval(()=>{},1000);",
    ),
  );
  const live = new AbortController();
  const pending = owner.shell(bun("wait.cjs"), { timeout: 20000 }, live.signal);
  try {
    await until(
      () => readFile(join(workspace.path, "ready.txt")).catch(() => undefined),
      Date.now() + 8000,
    );
    const queued = new AbortController();
    const clear = owner.call({ action: "clear" }, queued.signal);
    queued.abort();
    assert.equal((await clear).errorCode, "CANCELLED");
  } finally {
    live.abort();
    const stopped = await pending;
    assert.equal(stopped.errorCode, "CANCELLED", stopped.output);
  }
  assert.equal(
    (await owner.shell(bun("wait.cjs"), { timeout: 1000 })).errorCode,
    "TOOL_TIMEOUT",
  );
  ok(await owner.call({ action: "remove", name: "ready.txt" }));

  const promoted = owner.shell(bun("wait.cjs"), { label: "scratch promotion" });
  const task = await until(
    async () =>
      (await owner.controls.list()).find(
        (item) =>
          item.label === "scratch promotion" && item.state === "running",
      ),
    Date.now() + 12000,
  );
  const running = await owner.controls.promote(task.id);
  assert.equal(running.foreground, false);
  assert.equal(running.replayable, false);
  ok(await promoted);
  assert.equal(
    (await owner.call({ action: "clear" })).errorCode,
    "BACKGROUND_RESOURCE_BUSY",
  );
  assert.equal(
    (await owner.controls.port.stop(task.id)).cleanup.confirmed,
    true,
  );
  ok(await owner.call({ action: "remove", name: "ready.txt" }));

  // Exercise the durable fence with a separate process on this same session.
  await owner.tools.dispose();
  child = Bun.spawn(
    [process.execPath, import.meta.path, project, owner.session.id],
    {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env },
    },
  );
  await until(
    () => readFile(join(workspace.path, "ready.txt")).catch(() => undefined),
    Date.now() + 15000,
  );
  const peer = await runtime(otherProject);
  ok(
    await peer.call({
      action: "write",
      name: "peer.cjs",
      content: "console.log('peer-ok');",
    }),
  );
  assert.match(ok(await peer.shell(bun("peer.cjs"))), /peer-ok/);
  await peer.tools.dispose();
  assert.equal(child.exitCode, null);
  child.kill("SIGKILL");
  await child.exited;
  const restored = await runtime(
    project,
    await owner.store.load(owner.session.id),
  );
  const recovered = await until(async () => {
    const result = await restored.call({ action: "list" });
    if (result.errorCode === "BACKGROUND_RECOVERY_REQUIRED") return;
    return ok(result);
  }, Date.now() + 12000);
  assert.match(recovered, /check.cjs/);
  assert.equal(
    await readFile(join(workspace.path, "ready.txt"), "utf8"),
    "run\n",
  );
  assert.match(ok(await restored.shell(bun("check.cjs"))), /scratch-ok/);
  await restored.tools.dispose();
  await owner.store.delete(owner.session.id);
  await assert.rejects(readdir(workspace.path), missing);
  assert.deepEqual(await readdir(project), before);

  ok(await other.call({ action: "write", name: "old.txt", content: "old" }));
  const expired = await ScratchWorkspace.forSession(project, other.session.id);
  const old = new Date(Date.now() - SCRATCH_LIMITS.retentionMs - 60000);
  await utimes(expired.path, old, old);
  const release = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  const lease = expired.withLease(undefined, async () => {
    held.resolve();
    await release.promise;
  });
  await held.promise;
  try {
    await ScratchWorkspace.sweep();
    assert.equal(await readFile(join(expired.path, "old.txt"), "utf8"), "old");
  } finally {
    release.resolve();
    await lease;
  }
  await ScratchWorkspace.sweep();
  await assert.rejects(readdir(expired.path), missing);
  await other.tools.dispose();
  console.log("Scratch Workspace: passed");
} finally {
  if (child?.exitCode === null) child.kill("SIGKILL");
  await child?.exited;
  await host.dispose();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
