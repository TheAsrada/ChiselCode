import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTaskSchema } from "../../src/background/contracts.js";
import { ProcessLog } from "../../src/background/log.js";
import { BackgroundTaskStore } from "../../src/background/storage.js";
import { ManagedProcess } from "../../src/processes/managed.js";
import { SecretRedactor } from "../../src/security/redaction.js";
import { WorkspaceCoordinator } from "../../src/tools/workspace-coordinator.js";
import { quoteShellArg } from "../helpers/shell.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(source: string, executable = process.execPath) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-background-process-")),
  );
  roots.push(root);
  const file = join(root, "command.cjs");
  await writeFile(file, source);
  return {
    root,
    command: `${quoteShellArg(executable)} ${quoteShellArg(file)}`,
  };
}
test("managed backend reports real exit and never gives the shell interactive stdin", async () => {
  const { root, command } = await fixture(
    "process.stdin.resume();process.stdin.on('end',()=>{console.log('EOF настоящий');process.exitCode=7;});",
  );
  let output = "";
  const process = new ManagedProcess({
    command,
    cwd: root,
    deadline: Date.now() + 10000,
    capture: {
      async write(_stream, bytes) {
        output += Buffer.from(bytes);
      },
      async close() {},
    },
  });
  await process.ready;
  const outcome = await process.done;
  expect(outcome.exitCode).toBe(7);
  expect(outcome.cleanup).toBe(true);
  expect(output).toContain("EOF настоящий");
}, 15000);
test("the supervisor retains inherited output after its leader exits", async () => {
  const { root, command } = await fixture(
    globalThis.process.platform === "win32"
      ? "import os, subprocess, sys\nsubprocess.Popen([sys.executable, '-c', \"import time; print('потомок начал', flush=True); time.sleep(0.5); print('потомок завершён', flush=True)\"], stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=sys.stderr)\nos._exit(0)\n"
      : "const {spawn}=require('node:child_process');spawn(process.execPath,['-e',\"console.log('потомок начал');setTimeout(()=>console.log('потомок завершён'),500)\"],{stdio:['ignore','inherit','inherit']});process.exit(0);",
    globalThis.process.platform === "win32" ? "python" : "node",
  );
  let output = "";
  const process = new ManagedProcess({
    command,
    cwd: root,
    deadline: Date.now() + 10000,
    capture: {
      async write(_stream, bytes) {
        output += Buffer.from(bytes);
      },
      async close() {},
    },
  });
  await process.ready;
  const outcome = await process.done;
  expect(outcome.cleanup).toBe(true);
  expect(outcome.exitCode).toBe(0);
  expect(output).toContain("потомок начал");
  expect(output).toContain("потомок завершён");
}, 15000);
test("ownership transfer preserves one instance and removes the old foreground abort signal", async () => {
  const { root, command } = await fixture(
    "console.log('один запуск');setTimeout(()=>console.log('готово'),300);",
  );
  const signal = new AbortController();
  let output = "";
  const process = new ManagedProcess({
    command,
    cwd: root,
    signal: signal.signal,
    deadline: Date.now() + 10000,
    capture: {
      async write(_stream, bytes) {
        output += Buffer.from(bytes);
      },
      async close() {},
    },
  });
  await process.ready;
  const pid = process.pid;
  const instance = process.instance;
  process.detachForeground();
  signal.abort();
  expect((await process.done).exitCode).toBe(0);
  expect(process.pid).toBe(pid);
  expect(process.instance).toBe(instance);
  expect(output.match(/один запуск/g)?.length).toBe(1);
  expect(output).toContain("готово");
}, 15000);
test("safe append and byte pages redact split secrets and escapes before disk", async () => {
  const { root } = await fixture("");
  const redactor = new SecretRedactor();
  redactor.add("secret-across-writes");
  const log = new ProcessLog(
    join(root, "output.log"),
    4096,
    redactor,
    () => {},
    () => {
      throw new Error("unexpected limit");
    },
  );
  await log.create();
  for (const text of [
    "Привет secret-ac",
    "ross-writes\n",
    "\u001b]52;c;",
    "clipboard-secret\u0007Готово\n",
  ])
    await log.write("stdout", Buffer.from(text));
  const emoji = Buffer.from("😀 русский вывод\n");
  await log.write("stderr", emoji.subarray(0, 2));
  await log.write("stderr", emoji.subarray(2));
  await log.close();
  const disk = await readFile(log.path, "utf8");
  expect(disk).toContain("[секрет скрыт]");
  expect(disk).toContain("😀 русский вывод");
  expect(disk).not.toContain("secret-across-writes");
  expect(disk).not.toContain("clipboard-secret");
  expect(disk).not.toContain("\u001b");
  let output = "";
  let cursor = 0;
  while (cursor < log.size) {
    const page = await log.read(cursor, 7);
    expect(page.text).not.toContain("�");
    output += page.text;
    expect(page.next).toBeGreaterThan(cursor);
    cursor = page.next;
  }
  expect(output).toBe(disk);
});
test("an adopted lifetime lease atomically fails conflicting waiters and remains after caller finally", async () => {
  const coordinator = new WorkspaceCoordinator();
  const lease = await coordinator.acquirePlanLease([
    { resource: "/fixture/isolated", mode: "write" },
  ]);
  const waiting = coordinator.acquire(["/fixture/isolated/file"], "read");
  const rejected = waiting.catch((error) => error);
  const transferred = await lease.transfer({
    taskId: "owned-task",
    ownerId: "owner",
    label: "Проверка",
    state: "running",
  });
  lease.finish();
  expect(await rejected).toMatchObject({
    code: "BACKGROUND_RESOURCE_BUSY",
    details: { taskId: "owned-task" },
  });
  await expect(
    coordinator.acquire(["/fixture/isolated"], "write"),
  ).rejects.toMatchObject({ code: "BACKGROUND_RESOURCE_BUSY" });
  const origin = await coordinator.acquire(["/fixture/origin/file"], "write");
  origin();
  transferred.release();
  transferred.release();
  const after = await coordinator.acquire(["/fixture/isolated"], "read");
  after();
});

test("durable execution adoption prevents a second registry instance from entering the same resource", async () => {
  const { root } = await fixture("");
  class Store extends BackgroundTaskStore {
    override async directory() {
      return root;
    }
  }
  const first = new Store();
  const second = new Store();
  const ownerId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const lease = await first.acquireExecution(ownerId, [
    { resource: root, mode: "write" },
  ]);
  const signal = new AbortController();
  const waiting = second
    .acquireExecution(
      crypto.randomUUID(),
      [{ resource: join(root, "child"), mode: "read" }],
      signal.signal,
    )
    .catch((error) => error);
  await lease.adopt({
    ownerId,
    taskId,
    label: "Проверка между приложениями",
    state: "running",
  });
  expect(await waiting).toMatchObject({
    code: "BACKGROUND_RESOURCE_BUSY",
    details: { taskId },
  });
  expect((await second.fencedTaskIds(ownerId)).has(taskId)).toBe(true);
  await lease.release();
  await lease.release();
  expect((await second.fencedTaskIds(ownerId)).has(taskId)).toBe(false);
  const after = await second.acquireExecution(ownerId, [
    { resource: root, mode: "read" },
  ]);
  await after.release();
});

test("promotion removes only an acknowledged snapshot while live revisions advance", async () => {
  const { root } = await fixture("");
  let blocked = false;
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  class Store extends BackgroundTaskStore {
    override async directory() {
      return root;
    }
    override async list(ownerId: string) {
      const saved = await super.list(ownerId);
      if (blocked) {
        entered();
        await barrier;
      }
      return saved;
    }
  }
  const store = new Store();
  const ownerId = crypto.randomUUID();
  const stamp = new Date().toISOString();
  const record = BackgroundTaskSchema.parse({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    operationKey: "promotion-once",
    ordinal: 1,
    rootOwnerId: ownerId,
    sessionId: ownerId,
    conversationId: "fixture",
    generation: 0,
    invocationId: "one",
    turnId: "one",
    ownerLabel: "Основной агент",
    origin: root,
    workspace: root,
    workspaceLabel: "Проект",
    label: "Проверка",
    commandPreview: "echo fixture",
    replayable: true,
    kind: "batch",
    foreground: true,
    state: "running",
    revision: 1,
    acceptedAt: stamp,
    updatedAt: stamp,
    deadline: stamp,
    readiness: "unknown",
    tail: [],
    outputBytes: 0,
    outputLimit: 4096,
    outputGeneration: crypto.randomUUID(),
    cleanup: { confirmed: false },
    resources: [],
    process: {
      instance: crypto.randomUUID(),
      applicationPid: process.pid,
      host: "fixture",
      token: crypto.randomUUID(),
    },
  });
  await store.saveForeground(record);
  record.foreground = false;
  record.revision = 2;
  await store.save(record);
  await expect(
    store.removePromotedForeground({ ...record, revision: 3 }),
  ).rejects.toMatchObject({ code: "BACKGROUND_STORAGE_FAILURE" });
  await expect(
    store.removePromotedForeground({
      ...record,
      process: { ...record.process!, token: crypto.randomUUID() },
    }),
  ).rejects.toMatchObject({ code: "BACKGROUND_STORAGE_FAILURE" });
  expect(await store.listForeground(ownerId)).toHaveLength(1);
  blocked = true;
  const removal = store.removePromotedForeground(record);
  await reached;
  record.revision++;
  record.tail = ["Следующая ещё не сохранённая строка"];
  release();
  await removal;
  expect(await store.listForeground(ownerId)).toHaveLength(0);
  blocked = false;
  expect((await store.list(ownerId))[0]?.revision).toBe(2);
});

test("workspace resource identity follows a real symlink or Windows junction", async () => {
  const { root } = await fixture("");
  const alias = `${root}-alias`;
  roots.push(alias);
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const coordinator = new WorkspaceCoordinator();
  expect(await coordinator.resources([root, alias])).toHaveLength(1);
});

test("stop waits for a real TERM-ignoring descendant and confirms closed pipes", async () => {
  const { root, command } = await fixture(
    "process.on('SIGTERM',()=>{});console.log('IGNORE READY');setInterval(()=>console.error('worker'),100);",
  );
  let ready!: () => void;
  const barrier = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const process = new ManagedProcess({
    command,
    cwd: root,
    deadline: Date.now() + 15000,
    capture: {
      async write(_stream, bytes) {
        if (Buffer.from(bytes).toString().includes("IGNORE READY")) ready();
      },
      async close() {},
    },
  });
  await barrier;
  const stopped = await process.stop();
  expect(stopped.cleanup).toBe(true);
  expect(stopped.reason).toBe("cancelled");
  expect(await process.stop()).toEqual(stopped);
}, 18000);
test.skipIf(process.platform !== "linux")(
  "a real detached orphan is reported unknown rather than falsely cleaned",
  async () => {
    const { root } = await fixture("");
    const file = join(root, "escape.cjs");
    await writeFile(
      file,
      "const {spawn}=require('node:child_process');const fs=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync('escaped.pid',String(p.pid));p.unref();process.exit(0);",
    );
    const handle = new ManagedProcess({
      command: `${quoteShellArg(process.execPath)} ${quoteShellArg(file)}`,
      cwd: root,
      deadline: Date.now() + 10000,
      capture: { async write() {}, async close() {} },
    });
    try {
      await handle.ready;
      const outcome = await handle.done;
      expect(outcome.cleanup).toBe(false);
      expect(outcome.escaped).toBe(true);
    } finally {
      const pid = Number(await readFile(join(root, "escaped.pid"), "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Fixture child already gone. */
      }
    }
  },
  15000,
);
