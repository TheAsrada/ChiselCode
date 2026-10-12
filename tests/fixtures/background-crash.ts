import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { createSessionToolRuntime } from "../../src/app/tool-runtime.js";
import { BackgroundTaskStore } from "../../src/background/storage.js";
import { loadGlobalConfig, loadProjectConfig } from "../../src/config/load.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { quoteShellArg } from "../helpers/shell.js";

type ProcessRow = { pid: number; parent: number; start: string; name: string };
async function windowsProcesses(): Promise<ProcessRow[]> {
  const result = await execa(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name | ConvertTo-Json -Compress",
    ],
    { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const parsed = JSON.parse(result.stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: row.ProcessId,
    parent: row.ParentProcessId,
    start: String(row.CreationDate),
    name: String(row.Name),
  }));
}
async function removeAfterCrashCleanup(
  directory: string,
  owned: ProcessRow[],
): Promise<void> {
  const cleanupDeadline = Date.now() + 12000;
  for (;;) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      // Bun on Windows does not consistently apply node:fs rm maxRetries.
      // Retry the actual locked-directory operation within a fixed bound.
      const retry =
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        ["EBUSY", "ENOTEMPTY", "EPERM"].includes(String(error.code)) &&
        Date.now() < cleanupDeadline;
      if (!retry) {
        if (process.platform === "win32") {
          const observed = await windowsProcesses();
          console.error(
            "Crash cleanup diagnostics:",
            JSON.stringify({
              remaining: observed.filter((row) =>
                owned.some(
                  (item) => item.pid === row.pid && item.start === row.start,
                ),
              ),
              files: (await readdir(directory, { recursive: true })).slice(
                0,
                40,
              ),
              fixtureCwd: process.cwd(),
            }),
          );
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

if (process.argv[2] === "--child") {
  const root = process.argv[3]!;
  const host = new ExtensionHost(defaultExtensions());
  const scope = await host.open(root);
  const store = await projectSessionStore(scope.workspaceRoot);
  const session = createSession(scope.workspaceRoot, "openai", "fixture");
  await store.save(session);
  let ready!: () => void;
  const barrier = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const tools = await createSessionToolRuntime({
    root: scope.workspaceRoot,
    session,
    store,
    scope,
    config: await loadProjectConfig(scope.workspaceRoot),
    global: await loadGlobalConfig(),
    mode: "build",
    approvalMode: "default",
    signal: new AbortController().signal,
    options: { interactive: true, allow: "run_shell" },
    events: new RuntimeEventBus(session.id),
    resolver: {
      async requestApproval() {
        return "approved";
      },
    },
    onBackground(event) {
      if (event.task.readiness === "signal_seen") ready();
    },
  });
  const result = await tools.executor.execute({
    id: "crash-once",
    name: "run_shell",
    input: {
      command: `${quoteShellArg(process.execPath)} ${quoteShellArg(join(root, "server.cjs"))}`,
      background: true,
      taskKind: "service",
      readySignal: "CRASH READY",
      label: "До сбоя",
    },
  });
  assert.ok(!result.isError, result.output);
  await barrier;
  console.log(
    JSON.stringify({
      sessionId: session.id,
      task: result.details!.backgroundTask,
    }),
  );
  await new Promise<void>(() => {});
} else {
  const directory = await mkdtemp(join(tmpdir(), "chisel-background-crash-"));
  const root = join(directory, "проект сбоя");
  await mkdir(root);
  for (const key of [
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "APPDATA",
    "LOCALAPPDATA",
  ])
    process.env[key] = directory;
  await writeFile(
    join(root, "server.cjs"),
    "const fs=require('node:fs');fs.appendFileSync('launches.txt','one\\n');console.log('CRASH READY');setInterval(()=>{},1000);",
  );
  const child = Bun.spawn(
    [process.execPath, import.meta.path, "--child", root],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  let receipt!: (value: { sessionId: string; task: { id: string } }) => void;
  const accepted = new Promise<{ sessionId: string; task: { id: string } }>(
    (resolve) => {
      receipt = resolve;
    },
  );
  const reader = (async () => {
    let pending = "";
    for await (const bytes of child.stdout) {
      pending += Buffer.from(bytes).toString();
      const at = pending.indexOf("\n");
      if (at !== -1) {
        receipt(JSON.parse(pending.slice(0, at)));
        pending = pending.slice(at + 1);
      }
    }
  })();
  const stderr = new Response(child.stderr).text();
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15000);
  let owned: ProcessRow[] = [];
  try {
    const first = await Promise.race([
      accepted,
      child.exited.then(async () => {
        throw new Error((await stderr) || "Application ended before handshake");
      }),
    ]);
    if (process.platform === "win32") {
      const rows = await windowsProcesses();
      const parents = new Set([child.pid]);
      for (let index = 0; index < rows.length; index++)
        for (const row of rows)
          if (parents.has(row.parent)) parents.add(row.pid);
      owned = rows.filter((row) => parents.has(row.pid));
    }
    child.kill("SIGKILL");
    await child.exited;
    await reader;
    assert.equal(await stderr, "");
    const restored = await execa(
      process.execPath,
      [
        "src/cli.ts",
        "--cwd",
        root,
        "--resume",
        first.sessionId,
        "--json",
        `/tasks status ${first.task.id}`,
      ],
      { reject: false, timeout: 45000 },
    );
    assert.ok(
      restored.stdout.trim(),
      JSON.stringify({
        stderr: restored.stderr,
        code: restored.exitCode,
        signal: restored.signal,
      }),
    );
    const result = JSON.parse(restored.stdout.trim().split("\n").at(-1)!);
    assert.ok(result.output.startsWith("{"), result.output);
    const task = JSON.parse(result.output);
    assert.equal(task.id, first.task.id);
    assert.equal(task.state, "interrupted");
    assert.equal(task.cleanup.confirmed, false);
    assert.equal(task.cleanup.recoveryRequired, true);
    assert.equal(await readFile(join(root, "launches.txt"), "utf8"), "one\n");
    await assert.rejects(
      new BackgroundTaskStore().acquireExecution(
        crypto.randomUUID(),
        task.resources,
      ),
      (error) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "BACKGROUND_RESOURCE_BUSY",
    );
    const output = await execa(
      process.execPath,
      [
        "src/cli.ts",
        "--cwd",
        root,
        "--resume",
        first.sessionId,
        "--json",
        `/tasks output ${task.id}`,
      ],
      { reject: false, timeout: 45000 },
    );
    assert.match(output.stdout, /CRASH READY/);
    const recovery = await execa(
      process.execPath,
      [
        "src/cli.ts",
        "--cwd",
        root,
        "--resume",
        first.sessionId,
        "--json",
        `/tasks recover ${task.id}`,
      ],
      { reject: false, timeout: 45000 },
    );
    assert.notEqual(recovery.exitCode, 0);
    assert.match(
      recovery.stdout,
      /Нет подтверждения от исходного process backend/,
    );
    assert.equal(await readFile(join(root, "launches.txt"), "utf8"), "one\n");
    console.log(
      "Background Tasks crash: killed application, retained output, no replay/PID kill, durable recovery fence",
    );
  } finally {
    clearTimeout(watchdog);
    child.kill("SIGKILL");
    await child.exited;
    // Application exit precedes the supervisor's bounded descendant cleanup.
    // Windows keeps a live command's cwd locked. Await its release through the
    // filesystem operation, without killing a restored PID or ignoring EBUSY.
    await removeAfterCrashCleanup(directory, owned);
  }
}
