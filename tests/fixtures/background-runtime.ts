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
import { execa } from "execa";
import { createSessionToolRuntime } from "../../src/app/tool-runtime.js";
import type { BackgroundControls } from "../../src/background/binding.js";
import type { BackgroundEvent } from "../../src/background/contracts.js";
import { BackgroundTaskStore } from "../../src/background/storage.js";
import { loadGlobalConfig, loadProjectConfig } from "../../src/config/load.js";
import { backgroundServiceToken } from "../../src/extensions/builtins/background.js";
import { defaultExtensions } from "../../src/extensions/composition.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { RuntimeEventBus } from "../../src/runtime/events.js";
import { projectSessionStore } from "../../src/sessions/project-store.js";
import { createSession } from "../../src/sessions/store.js";
import { TuiWorkspace } from "../../src/ui/tui-workspace.js";

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "chisel-background-runtime-")),
);
for (const key of [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
])
  process.env[key] = join(directory, "home");
const root = join(directory, "русский проект");
await mkdir(root);
const owner = new AbortController();
const foreground = new AbortController();
const host = new ExtensionHost(defaultExtensions());
const scope = await host.open(root);
const store = await projectSessionStore(root);
const session = createSession(root, "openai", "fixture");
session.mode = "build";
await store.save(session);
let controls!: BackgroundControls;
const events: BackgroundEvent[] = [];
const observers = new Set<() => void>();
function until(predicate: () => boolean) {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const listener = () => {
      if (predicate()) {
        observers.delete(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      observers.delete(listener);
      reject(new Error("Runtime barrier timeout"));
    }, 12000);
    observers.add(listener);
  });
}
const tools = await createSessionToolRuntime({
  root,
  session,
  store,
  scope,
  config: await loadProjectConfig(root),
  global: await loadGlobalConfig(),
  mode: "build",
  approvalMode: "default",
  options: {
    interactive: true,
    allow: "run_shell",
    subagentOwner: {
      conversationId: session.id,
      generation: 0,
      signal: owner.signal,
      assertAvailable: () => scope.assertUsable(),
    },
  },
  events: new RuntimeEventBus(session.id),
  resolver: {
    async requestApproval() {
      return "approved";
    },
  },
  signal: foreground.signal,
  onBackground: (event) => {
    events.push(event);
    for (const listener of observers) listener();
  },
  onBackgroundControls: (value) => {
    controls = value;
  },
});
const command = (file: string) =>
  `${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, file))}`;
try {
  await writeFile(
    join(root, "batch.cjs"),
    "console.log('старт');setTimeout(()=>{console.log('реальный итог');process.exitCode=7},120);",
  );
  const call = {
    id: "batch-once",
    name: "run_shell",
    input: {
      command: command("batch.cjs"),
      background: true,
      label: "Проверка",
    },
  };
  const accepted = await tools.executor.execute(call);
  assert.equal(accepted.isError, undefined, accepted.output);
  const id = (accepted.details!.backgroundTask as { id: string }).id;
  assert.match(id, /^[a-f0-9-]{36}$/);
  const busy = await tools.executor.execute({
    id: "blocked-read",
    name: "read_file",
    input: { path: "batch.cjs" },
  });
  assert.equal(busy.errorCode, "BACKGROUND_RESOURCE_BUSY", busy.output);
  assert.equal(
    busy.presentation?.view.cards?.[0]?.title,
    "Ресурс занят фоновой задачей",
  );
  assert.equal(busy.presentation?.view.cards?.[0]?.actions?.length, 3);
  const [result] = await controls.port.wait([id], 10000);
  assert.equal(result!.state, "failed");
  assert.equal(result!.exitCode, 7);
  assert.equal(result!.cleanup.confirmed, true);
  const output = await controls.port.readOutput(id);
  assert.match(output.text, /реальный итог/);
  assert.equal(output.eof, true);
  assert.deepEqual(
    (await tools.executor.execute(call)).details,
    accepted.details,
  );
  const envelope = await tools.backgrounds!.completionContext(
    session.id,
    scope.workspaceRoot,
    "fixture-boundary-0",
  );
  assert.match(envelope ?? "", new RegExp(id));
  assert.equal(
    await tools.backgrounds!.completionContext(
      session.id,
      scope.workspaceRoot,
      "fixture-boundary-0",
    ),
    envelope,
  );
  assert.equal(
    await tools.backgrounds!.completionContext(
      session.id,
      scope.workspaceRoot,
      "fixture-boundary-1",
    ),
    undefined,
  );
  await controls.port.deleteHistory(id);
  assert.equal(
    await tools.backgrounds!.completionContext(
      session.id,
      scope.workspaceRoot,
      "fixture-boundary-2",
    ),
    undefined,
  );
  const after = await tools.executor.execute({
    id: "read-after",
    name: "read_file",
    input: { path: "batch.cjs" },
  });
  assert.notEqual(after.isError, true, after.output);
  await writeFile(
    join(root, "server.cjs"),
    "const {spawn}=require('node:child_process');spawn(process.execPath,['-e',\"console.log('worker готов');setInterval(()=>{},1000)\"],{stdio:['ignore','inherit','inherit']});console.log('READY');setInterval(()=>console.log('server строка'),50);",
  );
  const started = await tools.executor.execute({
    id: "service-once",
    name: "run_shell",
    input: {
      command: command("server.cjs"),
      background: true,
      taskKind: "service",
      readySignal: "READY",
      label: "Сервер",
    },
  });
  assert.equal(started.isError, undefined, started.output);
  const serverId = (started.details!.backgroundTask as { id: string }).id;
  await until(() =>
    events.some(
      (event) =>
        event.task.id === serverId && event.task.readiness === "signal_seen",
    ),
  );
  assert.equal((await controls.port.status(serverId)).state, "running");
  const liveStatus = await tools.executor.execute({
    id: "live-status-checkpoint",
    name: "ext:builtin.background:status",
    input: { id: serverId },
  });
  assert.ok(!liveStatus.isError, liveStatus.output);
  assert.equal(JSON.parse(liveStatus.output).id, serverId);
  assert.match((await controls.port.readOutput(serverId)).text, /READY/);
  const siblingRoot = join(directory, "независимый репозиторий");
  await mkdir(siblingRoot);
  await execa("git", ["init", "--initial-branch=main"], { cwd: siblingRoot });
  await writeFile(
    join(siblingRoot, "server.cjs"),
    "console.log('SIBLING READY');setInterval(()=>{},1000);",
  );
  const siblingScope = await host.open(siblingRoot);
  const siblingStore = await projectSessionStore(siblingScope.workspaceRoot);
  const siblingSession = createSession(
    siblingScope.workspaceRoot,
    "openai",
    "fixture",
  );
  await siblingStore.save(siblingSession);
  let siblingControls!: BackgroundControls;
  const siblingTools = await createSessionToolRuntime({
    root: siblingScope.workspaceRoot,
    session: siblingSession,
    store: siblingStore,
    scope: siblingScope,
    config: await loadProjectConfig(siblingRoot),
    global: await loadGlobalConfig(),
    mode: "build",
    approvalMode: "default",
    options: { interactive: true, allow: "run_shell" },
    events: new RuntimeEventBus(siblingSession.id),
    resolver: {
      async requestApproval() {
        return "approved";
      },
    },
    signal: new AbortController().signal,
    onBackgroundControls(value) {
      siblingControls = value;
    },
  });
  try {
    const siblingStart = await siblingTools.executor.execute({
      id: "different-repository",
      name: "run_shell",
      input: {
        command: `${JSON.stringify(process.execPath)} server.cjs`,
        background: true,
        taskKind: "service",
        label: "Соседний сервер",
        outputBytes: 4096,
      },
    });
    assert.ok(!siblingStart.isError, siblingStart.output);
    const siblingId = (siblingStart.details!.backgroundTask as { id: string })
      .id;
    assert.equal(
      (await siblingControls.port.status(siblingId)).state,
      "running",
    );
    assert.equal((await controls.port.status(serverId)).state, "running");
    await assert.rejects(controls.port.status(siblingId));
    const workspace = new TuiWorkspace(root);
    const mainTab = workspace.newTab(root);
    const siblingTab = workspace.newTab(siblingRoot);
    workspace.execution(mainTab).backgroundControls = controls;
    let closed: Promise<void> | undefined;
    workspace.execution(siblingTab).backgroundControls = {
      ...siblingControls,
      close() {
        closed = siblingControls.close();
        return closed;
      },
    };
    assert.equal(
      workspace.close(),
      true,
      "Background-only tab can close its owner",
    );
    assert.ok(closed);
    await closed;
    const savedSibling = (
      await new BackgroundTaskStore().list(siblingSession.id)
    ).find((task) => task.id === siblingId)!;
    assert.equal(savedSibling.state, "cancelled");
    assert.equal(savedSibling.cleanup.confirmed, true);
    // The surviving tab keeps its real server; disposing this UI fixture must not close that owner.
    workspace.execution(mainTab).backgroundControls = undefined;
    workspace.dispose();
    assert.equal((await controls.port.status(serverId)).state, "running");
  } finally {
    await siblingControls?.close();
    await siblingTools.dispose();
  }
  const queued: string[] = [];
  for (let index = 0; index < 8; index++) {
    const accepted = await tools.executor.execute({
      id: `queued-${index}`,
      name: "run_shell",
      input: {
        command: command("batch.cjs"),
        background: true,
        outputBytes: 1024,
        label: `Очередь ${index}`,
      },
    });
    assert.ok(!accepted.isError, accepted.output);
    const id = (accepted.details!.backgroundTask as { id: string }).id;
    queued.push(id);
    assert.ok(
      ["queued", "waiting_resources"].includes(
        (await controls.port.status(id)).state,
      ),
    );
  }
  const overflow = await tools.executor.execute({
    id: "queue-overflow",
    name: "run_shell",
    input: {
      command: command("batch.cjs"),
      background: true,
      outputBytes: 1024,
    },
  });
  assert.equal(overflow.errorCode, "BACKGROUND_LIMIT");
  await Promise.all(queued.map((id) => controls.port.stop(id)));
  assert.equal(
    (await controls.port.status(serverId)).state,
    "running",
    "Остановка очереди не останавливает выбранный сервер",
  );
  assert.equal(
    new Set((await controls.port.list()).map((task) => task.ordinal)).size,
    (await controls.port.list()).length,
  );
  const deadlineQueued = await tools.executor.execute({
    id: "queue-deadline",
    name: "run_shell",
    input: {
      command: command("batch.cjs"),
      background: true,
      deadlineMs: 1000,
      outputBytes: 1024,
    },
  });
  const deadlineId = (deadlineQueued.details!.backgroundTask as { id: string })
    .id;
  const [expiredQueue] = await controls.port.wait([deadlineId], 10000);
  assert.equal(expiredQueue!.state, "timed_out");
  assert.equal(expiredQueue!.exitCode, null);
  assert.equal(expiredQueue!.outputBytes, 0);
  assert.equal((await controls.port.status(serverId)).state, "running");
  assert.equal((await controls.port.stop(serverId)).cleanup.confirmed, true);
  assert.equal((await controls.port.status(serverId)).state, "cancelled");
  const git = async (...args: string[]) =>
    (
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
  await git("init", "--initial-branch=main");
  await writeFile(join(root, "result.txt"), "committed base\n");
  await writeFile(
    join(root, "isolated.cjs"),
    "const fs=require('node:fs');console.log('ISOLATED READY');const t=setInterval(()=>{if(fs.existsSync('release.txt')){fs.writeFileSync('result.txt','background result\\n');console.log('copy итог');clearInterval(t)}},50);",
  );
  await git("add", "result.txt", "isolated.cjs");
  await git("commit", "-m", "fixture base");
  const initialHead = await git("rev-parse", "HEAD");
  const initialIndex = await git("ls-files", "--stage");
  const branches = await git(
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
  );
  await writeFile(join(root, "unrelated.txt"), "dirty origin\n");
  const created = await tools.executor.execute({
    id: "create-owned-copy",
    name: "ext:builtin.worktrees:create",
    input: { label: "Фоновая проверка" },
  });
  assert.ok(!created.isError, created.output);
  const copy = created.details!.worktree as { id: string; path: string };
  await assert.rejects(readFile(join(copy.path, "unrelated.txt")));
  const isolated = await tools.executor.execute({
    id: "isolated-once",
    name: "run_shell",
    input: {
      command: `${JSON.stringify(process.execPath)} isolated.cjs`,
      background: true,
      targetWorktreeId: copy.id,
      label: "Проверка в копии",
      readySignal: "ISOLATED READY",
    },
  });
  assert.ok(!isolated.isError, isolated.output);
  const isolatedId = (isolated.details!.backgroundTask as { id: string }).id;
  await until(() =>
    events.some(
      (event) =>
        event.task.id === isolatedId && event.task.readiness === "signal_seen",
    ),
  );
  const originRead = await tools.executor.execute({
    id: "origin-independent-read",
    name: "read_file",
    input: { path: "unrelated.txt" },
  });
  assert.ok(!originRead.isError, originRead.output);
  const originEdit = await tools.executor.execute({
    id: "origin-independent-edit",
    name: "write_file",
    input: { path: "unrelated.txt", content: "origin continued\n" },
  });
  assert.ok(!originEdit.isError, originEdit.output);
  for (const action of ["apply", "remove"]) {
    const blocked = await tools.executor.execute({
      id: `blocked-copy-${action}`,
      name: `ext:builtin.worktrees:${action}`,
      input: { id: copy.id },
    });
    assert.ok(
      ["BACKGROUND_RESOURCE_BUSY", "WORKTREE_IN_USE"].includes(
        blocked.errorCode!,
      ),
      blocked.output,
    );
  }
  const gitBlocked = await tools.executor.execute({
    id: "common-git-busy",
    name: "run_shell",
    input: { command: "git status --short" },
  });
  assert.equal(
    gitBlocked.errorCode,
    "BACKGROUND_RESOURCE_BUSY",
    gitBlocked.output,
  );
  await writeFile(join(copy.path, "release.txt"), "finish");
  const [copyResult] = await controls.port.wait([isolatedId], 10000);
  assert.equal(copyResult!.state, "completed");
  assert.equal(copyResult!.cleanup.confirmed, true);
  assert.match((await controls.port.readOutput(isolatedId)).text, /copy итог/);
  const applied = await tools.executor.execute({
    id: "apply-clean-copy",
    name: "ext:builtin.worktrees:apply",
    input: { id: copy.id, paths: ["result.txt"] },
  });
  assert.ok(!applied.isError, applied.output);
  assert.equal(
    await readFile(join(root, "result.txt"), "utf8"),
    "background result\n",
  );
  assert.equal(
    await readFile(join(root, "unrelated.txt"), "utf8"),
    "origin continued\n",
  );
  assert.equal(await git("rev-parse", "HEAD"), initialHead);
  assert.equal(await git("ls-files", "--stage"), initialIndex);
  assert.equal(
    await git("for-each-ref", "--format=%(refname)", "refs/heads"),
    branches,
  );
  await writeFile(
    join(root, "noisy.cjs"),
    "process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000);",
  );
  const noisy = await tools.executor.execute({
    id: "no-newline-limit",
    name: "run_shell",
    input: {
      command: command("noisy.cjs"),
      background: true,
      outputBytes: 1024,
      label: "Лимит вывода",
    },
  });
  const noisyId = (noisy.details!.backgroundTask as { id: string }).id;
  const [limited] = await controls.port.wait([noisyId], 10000);
  assert.equal(limited!.state, "output_limit");
  assert.equal(limited!.cleanup.confirmed, true);
  assert.ok(limited!.outputBytes <= 1024);
  await controls.port.deleteHistory(noisyId);
  assert.ok(!(await controls.port.list()).some((task) => task.id === noisyId));
  assert.equal((await controls.port.status(noisyId)).outputExpired, true);
  assert.equal((await controls.port.readOutput(noisyId)).expired, true);
  const repeatReceipt = await tools.executor.execute({
    id: "no-newline-limit",
    name: "run_shell",
    input: {
      command: command("noisy.cjs"),
      background: true,
      outputBytes: 1024,
      label: "Лимит вывода",
    },
  });
  assert.equal(
    (repeatReceipt.details!.backgroundTask as { id: string }).id,
    noisyId,
  );
  const liveDeadline = await tools.executor.execute({
    id: "live-deadline-narrowing",
    name: "run_shell",
    input: {
      command: command("server.cjs"),
      background: true,
      taskKind: "service",
      outputBytes: 4096,
      label: "Сужение срока",
    },
  });
  assert.ok(!liveDeadline.isError, liveDeadline.output);
  const narrowedDeadlineId = (
    liveDeadline.details!.backgroundTask as { id: string }
  ).id;
  await writeFile(
    join(root, ".chiselrc"),
    JSON.stringify({ backgroundTasks: { serviceDeadlineMs: 1000 } }),
  );
  const [deadlineOutcome] = await controls.port.wait(
    [narrowedDeadlineId],
    10000,
  );
  assert.equal(deadlineOutcome!.state, "timed_out");
  assert.equal(deadlineOutcome!.cleanup.confirmed, true);
  await writeFile(
    join(root, ".chiselrc"),
    JSON.stringify({ backgroundTasks: { enabled: true } }),
  );
  const livePolicy = await tools.executor.execute({
    id: "live-feature-disable",
    name: "run_shell",
    input: {
      command: command("server.cjs"),
      background: true,
      taskKind: "service",
      outputBytes: 4096,
      label: "Отключение функции",
    },
  });
  const policyId = (livePolicy.details!.backgroundTask as { id: string }).id;
  await writeFile(
    join(root, ".chiselrc"),
    JSON.stringify({ backgroundTasks: { enabled: false } }),
  );
  const [policyStopped] = await controls.port.wait([policyId], 10000);
  assert.equal(policyStopped!.state, "cancelled");
  assert.equal(policyStopped!.cleanup.confirmed, true);
  const disabledDuplicate = await tools.executor.execute(call);
  assert.equal(
    (disabledDuplicate.details!.backgroundTask as { id: string }).id,
    id,
  );
  await writeFile(
    join(root, ".chiselrc"),
    JSON.stringify({ backgroundTasks: { enabled: true } }),
  );
  await writeFile(
    join(root, "secret.cjs"),
    "const value=process.argv.at(-1);process.stdout.write(value.slice(0,5));setImmediate(()=>{process.stdout.write(value.slice(5)+'\\n');process.stderr.write('\\x1b]52;c;clipboard-secret\\x07безопасный итог\\n')});",
  );
  const secret = "fixture-private-split-value";
  const protectedStart = await tools.executor.execute({
    id: "protected-output",
    name: "run_shell",
    input: {
      command: `${command("secret.cjs")} --token ${secret}`,
      background: true,
      outputBytes: 4096,
      label: "Защита вывода",
    },
  });
  assert.ok(!protectedStart.isError, protectedStart.output);
  const protectedId = (protectedStart.details!.backgroundTask as { id: string })
    .id;
  const [protectedTask] = await controls.port.wait([protectedId], 10000);
  assert.equal(protectedTask!.state, "completed");
  const protectedOutput = await controls.port.readOutput(protectedId);
  assert.ok(!protectedOutput.text.includes(secret));
  assert.ok(!protectedOutput.text.includes("clipboard-secret"));
  assert.ok(!JSON.stringify(await store.load(session.id)).includes(secret));
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.equal(protectedTask!.replayable, false);
  const backgroundService = scope.services.get(backgroundServiceToken);
  const originalSave = backgroundService.storage.save.bind(
    backgroundService.storage,
  );
  let startupFault = false;
  backgroundService.storage.save = async (record) => {
    if (
      record.label === "Сбой после запуска" &&
      record.state === "running" &&
      !startupFault
    ) {
      startupFault = true;
      throw new Error("fixture: startup checkpoint disk failure");
    }
    await originalSave(record);
  };
  try {
    const startup = await tools.executor.execute({
      id: "startup-save-fault",
      name: "run_shell",
      input: {
        command: command("server.cjs"),
        background: true,
        taskKind: "service",
        label: "Сбой после запуска",
        outputBytes: 4096,
      },
    });
    const startupId = (startup.details!.backgroundTask as { id: string }).id;
    const [stoppedStartup] = await controls.port.wait([startupId], 10000);
    assert.equal(startupFault, true);
    assert.equal(stoppedStartup!.state, "failed");
    assert.equal(stoppedStartup!.cleanup.confirmed, true);
    const free = await tools.executor.execute({
      id: "startup-fault-releases",
      name: "read_file",
      input: { path: "unrelated.txt" },
    });
    assert.ok(!free.isError, free.output);
  } finally {
    backgroundService.storage.save = originalSave;
  }
  await writeFile(
    join(root, "recovery.cjs"),
    "const fs=require('node:fs');console.log('RECOVERY READY');const timer=setInterval(()=>{if(fs.existsSync('recovery-release')){clearInterval(timer);console.log('Фактическое завершение');}},10);",
  );
  const recoveryStart = await tools.executor.execute({
    id: "storage-fault-once",
    name: "run_shell",
    input: {
      command: command("recovery.cjs"),
      background: true,
      label: "Проверка сохранения",
      readySignal: "RECOVERY READY",
      outputBytes: 4096,
    },
  });
  assert.ok(!recoveryStart.isError, recoveryStart.output);
  const recoveryId = (recoveryStart.details!.backgroundTask as { id: string })
    .id;
  let faulted = false;
  backgroundService.storage.save = async (record) => {
    if (record.id === recoveryId && record.state === "completed" && !faulted) {
      faulted = true;
      throw new Error("fixture: no space left during terminal checkpoint");
    }
    await originalSave(record);
  };
  try {
    await writeFile(join(root, "recovery-release"), "готово");
    const [unknown] = await controls.port.wait([recoveryId], 10000);
    assert.equal(unknown!.state, "cleanup_unknown");
    assert.equal(unknown!.exitCode, 0);
    const held = await tools.executor.execute({
      id: "fault-holds-resources",
      name: "read_file",
      input: { path: "unrelated.txt" },
    });
    assert.equal(held.errorCode, "BACKGROUND_RESOURCE_BUSY");
    const [recovered, duplicateRecovery] = await Promise.all([
      controls.port.recover(recoveryId),
      controls.port.recover(recoveryId),
    ]);
    assert.equal(recovered.state, "completed");
    assert.equal(recovered.cleanup.confirmed, true);
    assert.equal(recovered.revision, duplicateRecovery.revision);
    const released = await tools.executor.execute({
      id: "recovered-resources",
      name: "read_file",
      input: { path: "unrelated.txt" },
    });
    assert.ok(!released.isError, released.output);
    assert.match(
      (await controls.port.readOutput(recoveryId)).text,
      /Фактическое завершение/,
    );
  } finally {
    backgroundService.storage.save = originalSave;
  }
  await writeFile(
    join(root, "promote.cjs"),
    "const fs=require('node:fs');fs.appendFileSync('launches.txt','one\\n');console.log('promotion READY');setTimeout(()=>console.log('promotion итог'),500);",
  );
  const running = tools.executor.execute({
    id: "foreground-once",
    name: "run_shell",
    input: { command: command("promote.cjs"), label: "Перевод" },
  });
  await until(() =>
    events.some(
      (event) =>
        event.task.label === "Перевод" && event.task.state === "running",
    ),
  );
  const before = (await controls.list()).find(
    (task) => task.label === "Перевод",
  )!;
  const promoted = await controls.promote(before.id);
  assert.equal(promoted.id, before.id);
  assert.equal(promoted.deadline, before.deadline);
  const receipt = await running;
  assert.equal(
    (receipt.details!.backgroundTask as { id: string }).id,
    before.id,
  );
  foreground.abort();
  const [completed] = await controls.port.wait([before.id], 10000);
  assert.equal(completed!.state, "completed");
  assert.equal(completed!.exitCode, 0);
  assert.equal(await readFile(join(root, "launches.txt"), "utf8"), "one\n");
  assert.match(
    (await controls.port.readOutput(before.id)).text,
    /promotion итог/,
  );
  const saved = await store.load(session.id);
  assert.equal(saved.backgroundTasks?.[id]?.state, "failed");
  assert.equal(saved.totalTokens.inputTokens, 0);
  console.log(
    "Background Tasks runtime: real batch, service descendants, resource busy, dedup and one-instance promotion",
  );
} finally {
  owner.abort();
  await controls?.close();
  await tools.dispose();
  await host.dispose();
  await rm(directory, { recursive: true, force: true });
}
