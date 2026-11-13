import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionToolRuntime } from "../../src/app/tool-runtime.js";
import type { BackgroundControls } from "../../src/background/binding.js";
import { BackgroundTaskStore } from "../../src/background/storage.js";
import { loadGlobalConfig, loadProjectConfig } from "../../src/config/load.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { RuntimeError } from "../../src/runtime/errors.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { quoteShellArg } from "../helpers/shell.js";

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-foreground-cleanup-")),
);
process.env.XDG_DATA_HOME = join(directory, "data");
process.env.XDG_CONFIG_HOME = join(directory, "config");
const root = join(directory, "проект");
await mkdir(root);
const host = new ExtensionHost(defaultExtensions());
const scope = await host.open(root);
const store = await projectSessionStore(root);
const config = await loadProjectConfig(root);
const global = await loadGlobalConfig();
const clients: { dispose(): Promise<void>; controls?: BackgroundControls }[] =
  [];

async function open() {
  const session = createSession(root, "openai", "fixture");
  session.mode = "build";
  await store.save(session);
  let controls: BackgroundControls | undefined;
  const tools = await createSessionToolRuntime({
    root,
    session,
    store,
    scope,
    config,
    global,
    mode: "build",
    approvalMode: "default",
    options: { interactive: true, allow: "run_shell" },
    events: new RuntimeEventBus(session.id),
    resolver: { requestApproval: async () => "approved" },
    signal: new AbortController().signal,
    onBackgroundControls(value) {
      controls = value;
    },
  });
  clients.push({ dispose: tools.dispose, controls });
  await tools.refresh();
  return { tools, session };
}

async function stopFixtureChild() {
  const pid = Number(
    await readFile(join(root, "escaped.pid"), "utf8").catch(() => ""),
  );
  if (pid <= 1) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

try {
  const first = await open();
  const second = await open();
  const read = (id: string) =>
    second.tools.executor.execute({
      id,
      name: "read_file",
      input: { path: "file.txt" },
    });
  await writeFile(join(root, "file.txt"), "readable after cleanup\n");
  const completed = await first.tools.executor.execute({
    id: "gnu-timeout",
    name: "run_shell",
    input: { command: "timeout 3 sleep 0.4; printf done" },
  });
  assert.equal(completed.isError, false, completed.output);
  assert.equal(completed.details?.exitCode, 0);
  assert.equal(
    (completed.details?.shell as { cleanupConfirmed?: boolean })
      ?.cleanupConfirmed,
    true,
  );
  assert.match(completed.output, /done$/);
  assert.match((await read("confirmed")).output, /readable after cleanup/);

  const cancelled = await first.tools.executor.execute({
    id: "cancel-nested-group",
    name: "run_shell",
    input: { command: "timeout 20 sleep 20; printf unexpected", timeout: 1000 },
  });
  assert.equal(cancelled.errorCode, "TOOL_TIMEOUT", cancelled.output);
  assert.match((await read("after-cancel")).output, /readable after cleanup/);

  await writeFile(
    join(root, "escape.cjs"),
    `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
  detached: true, stdio: 'ignore',
});
writeFileSync('escaped.pid', String(child.pid));
child.unref();
`,
  );
  const escaped = await first.tools.executor.execute({
    id: "escaped",
    name: "run_shell",
    input: { command: `${quoteShellArg(process.execPath)} escape.cjs` },
  });
  assert.equal(
    escaped.errorCode,
    "BACKGROUND_RECOVERY_REQUIRED",
    escaped.output,
  );
  assert.equal(escaped.details?.exitCode, 0);
  const taskId = escaped.details?.foregroundTaskId;
  assert.equal(typeof taskId, "string");
  const busy = await read("unconfirmed");
  assert.equal(busy.errorCode, "BACKGROUND_RECOVERY_REQUIRED", busy.output);
  assert.equal(busy.details?.taskId, taskId);
  assert.equal(busy.details?.state, "cleanup_unknown");
  assert.equal(busy.details?.ownerId, first.session.id);
  const requiresRecovery = (error: unknown) =>
    error instanceof RuntimeError &&
    error.code === "BACKGROUND_RECOVERY_REQUIRED" &&
    error.details?.taskId === taskId &&
    error.details?.state === "cleanup_unknown";
  const background = second.tools.context.background;
  assert.ok(background);
  await assert.rejects(
    background.acquireAccess([{ resource: root, mode: "read" }]),
    requiresRecovery,
  );

  const stored = new BackgroundTaskStore();
  await assert.rejects(
    stored.assertAccess([{ resource: root, mode: "read" }]),
    requiresRecovery,
  );
  for (const [action, code] of [
    ["status", "PERMISSION_DENIED"],
    ["stop", "PERMISSION_DENIED"],
    ["recover", "PERMISSION_DENIED"],
  ]) {
    const result = await second.tools.executor.execute({
      id: `foreign-${action}`,
      name: `ext:builtin.background:${action}`,
      input: { id: taskId },
    });
    assert.equal(result.errorCode, code, result.output);
  }
  const list = await second.tools.executor.execute({
    id: "foreign-list",
    name: "ext:builtin.background:list",
    input: {},
  });
  assert.deepEqual(JSON.parse(list.output), []);
  const own = await first.tools.executor.execute({
    id: "owner-status",
    name: "ext:builtin.background:status",
    input: { id: taskId },
  });
  assert.equal(JSON.parse(own.output).state, "cleanup_unknown");
  for (const action of ["stop", "recover"]) {
    const result = await first.tools.executor.execute({
      id: `owner-${action}`,
      name: `ext:builtin.background:${action}`,
      input: { id: taskId },
    });
    assert.equal(
      result.errorCode,
      "BACKGROUND_RECOVERY_REQUIRED",
      result.output,
    );
  }
  console.log("Foreground process cleanup: passed");
} finally {
  await stopFixtureChild();
  for (const client of clients) {
    await client.controls?.close();
    await client.dispose();
  }
  await scope.dispose();
  await host.dispose();
  await rm(directory, { recursive: true, force: true });
}
