import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { BackgroundTaskRecord } from "../../src/background/contracts.js";
import { BackgroundTaskStore } from "../../src/background/storage.js";
import { bootChanged, readBootStamp } from "../../src/processes/boot.js";
import { readCleanupProof } from "../../src/processes/cleanup-proof.js";
import { ManagedProcess } from "../../src/processes/managed.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-cleanup-proof-")),
  );
  directories.push(root);
  class Store extends BackgroundTaskStore {
    override async directory() {
      return root;
    }
  }
  const record: BackgroundTaskRecord = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    operationKey: "fixture:one",
    ordinal: 1,
    rootOwnerId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    conversationId: "fixture",
    generation: 1,
    invocationId: "one",
    turnId: "fixture",
    ownerLabel: "Разговор",
    origin: root,
    workspace: root,
    workspaceLabel: "Проект",
    label: "Проверка",
    commandPreview: "echo ONE",
    replayable: true,
    kind: "batch",
    foreground: true,
    state: "interrupted",
    revision: 1,
    acceptedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 20000).toISOString(),
    readiness: "unknown",
    tail: [],
    outputBytes: 0,
    outputLines: 0,
    outputLimit: 4096,
    outputGeneration: crypto.randomUUID(),
    truncated: false,
    cleanup: { confirmed: false, recoveryRequired: true },
    resources: [{ resource: root, mode: "write" }],
    process: {
      instance: crypto.randomUUID(),
      applicationPid: process.pid,
      host: (await readBootStamp()).host,
      token: crypto.randomUUID(),
    },
  };
  return { root, Store, record };
}

test("a native completion survives lost application checkpoint and another registry releases the same claim", async () => {
  const { root, Store, record } = await fixture();
  const first = new Store();
  const lease = await first.acquireExecution(
    record.rootOwnerId,
    record.resources,
    undefined,
    true,
  );
  const proof = await lease.registerProcess({
    taskId: record.id,
    ownerId: record.rootOwnerId,
    label: record.label,
    foreground: true,
    instance: record.process!.instance,
    token: record.process!.token,
  });
  let output = "";
  const handle = new ManagedProcess({
    command: "echo CLEANUP_NATIVE_OK",
    cwd: root,
    deadline: Date.now() + 10000,
    proof,
    capture: {
      async write(_stream, bytes) {
        output += Buffer.from(bytes).toString();
      },
      async close() {},
    },
  });
  await handle.ready;
  const outcome = await handle.done;
  expect(outcome.cleanup).toBe(true);
  expect(outcome.exitCode).toBe(0);
  expect(output).toContain("CLEANUP_NATIVE_OK");
  expect(await readFile(proof.path, "utf8")).not.toContain("CLEANUP_NATIVE_OK");
  const second = new Store();
  expect(await second.recovery(record)).toMatchObject({
    kind: "cleanup",
    exitCode: 0,
  });
  await second.assertAccess([{ resource: root, mode: "read" }]);
  const acquired = await second.acquireExecution(
    crypto.randomUUID(),
    [{ resource: root, mode: "read" }],
    AbortSignal.timeout(3000),
  );
  await acquired.release();
  await lease.release();
}, 20000);

test("foreign, truncated, negative and symlinked cleanup receipts cannot release a claim", async () => {
  const { root, Store, record } = await fixture();
  const store = new Store();
  const lease = await store.acquireExecution(
    record.rootOwnerId,
    record.resources,
    undefined,
    true,
  );
  const grant = await lease.registerProcess({
    taskId: record.id,
    ownerId: record.rootOwnerId,
    label: record.label,
    foreground: false,
    instance: record.process!.instance,
    token: record.process!.token,
  });
  const proof = {
    schemaVersion: 1,
    taskId: record.id,
    ownerId: record.rootOwnerId,
    instance: record.process!.instance,
    token: record.process!.token,
    cleanup: true,
    escaped: false,
    exitCode: 0,
    signal: null,
    ownerGone: false,
    finishedAt: new Date().toISOString(),
  };
  for (const content of [
    "{",
    JSON.stringify({ ...proof, token: crypto.randomUUID() }),
    JSON.stringify({ ...proof, instance: crypto.randomUUID() }),
    JSON.stringify({ ...proof, cleanup: false }),
    JSON.stringify({ ...proof, escaped: true }),
  ]) {
    await writeFile(grant.path, content);
    expect(await readCleanupProof(grant.path, grant)).toBeUndefined();
    await expect(
      store.assertAccess([{ resource: root, mode: "read" }]),
    ).rejects.toMatchObject({ code: "BACKGROUND_RESOURCE_BUSY" });
  }
  await rm(grant.path);
  const outside = join(root, "untrusted.json");
  await writeFile(outside, JSON.stringify(proof));
  if (process.platform !== "win32") {
    await symlink(outside, grant.path);
    expect(await readCleanupProof(grant.path, grant)).toBeUndefined();
  }
  await lease.release();
});

test("v1 foreground reservations migrate once without dropping the orphaned execution fence", async () => {
  const { root, Store, record } = await fixture();
  const dead = execa(process.execPath, ["-e", ""], { windowsHide: true });
  await dead;
  record.process!.applicationPid = dead.pid!;
  const store = new Store();
  await store.saveForeground(record);
  await writeFile(
    join(root, "executions.json"),
    JSON.stringify({
      schemaVersion: 1,
      executions: {
        [crypto.randomUUID()]: {
          ownerId: record.rootOwnerId,
          pid: dead.pid,
          host: record.process!.host,
          token: crypto.randomUUID(),
          heartbeat: record.acceptedAt,
          process: true,
          accesses: record.resources,
        },
      },
    }),
  );
  await writeFile(
    join(root, "reservations.json"),
    JSON.stringify({
      schemaVersion: 1,
      reservations: {
        [record.id]: {
          ownerId: record.rootOwnerId,
          bytes: 4096,
          resources: record.resources,
          label: record.label,
          recovery: false,
          foreground: true,
        },
      },
    }),
  );
  await expect(
    store.assertAccess([{ resource: root, mode: "read" }]),
  ).rejects.toMatchObject({
    code: "BACKGROUND_RECOVERY_REQUIRED",
    details: { taskId: record.id, state: "cleanup_unknown" },
  });
  const migrated = JSON.parse(
    await readFile(join(root, "executions.json"), "utf8"),
  );
  expect(migrated.schemaVersion).toBe(2);
  expect(Object.keys(migrated.executions)).toHaveLength(1);
  await store.lease(record);
  expect((await store.reservations())[record.id]!.resources).toHaveLength(0);
  await expect(
    new Store().assertAccess([{ resource: root, mode: "read" }]),
  ).rejects.toMatchObject({ code: "BACKGROUND_RECOVERY_REQUIRED" });
  expect(await store.recovery(record)).toBeUndefined();
});

test("boot recovery requires positive native evidence on the same machine", () => {
  const linux = {
    host: "fixture",
    hostId: "machine",
    platform: "linux",
    bootId: "one",
  };
  expect(bootChanged(linux, { ...linux })).toBe(false);
  expect(bootChanged(linux, { ...linux, bootId: "two" })).toBe(true);
  expect(bootChanged(linux, { ...linux, bootId: "two", hostId: "other" })).toBe(
    false,
  );
  expect(bootChanged(linux, { ...linux, bootId: undefined })).toBe(false);
  const windows = {
    host: "fixture",
    hostId: "machine",
    platform: "win32",
    uptimeMs: 500000,
  };
  expect(bootChanged(windows, { ...windows, uptimeMs: 10000 })).toBe(true);
  expect(bootChanged(windows, { ...windows, uptimeMs: 499999 })).toBe(false);
  expect(bootChanged(windows, { ...windows, uptimeMs: 700000 })).toBe(false);
  expect(bootChanged(windows, { ...windows, uptimeMs: undefined })).toBe(false);
  expect(
    bootChanged(windows, { ...windows, uptimeMs: 10000, hostId: undefined }),
  ).toBe(false);
});

test("a native boot checkpoint releases legacy claims only after a positively different boot observation", async () => {
  const { root, Store, record } = await fixture();
  const stamp = await readBootStamp();
  const old =
    stamp.platform === "win32" && stamp.uptimeMs !== undefined
      ? { ...stamp, uptimeMs: stamp.uptimeMs + 1000000 }
      : { ...stamp, bootId: crypto.randomUUID() };
  const store = new Store();
  await store.saveForeground(record);
  await writeFile(
    join(root, "executions.json"),
    JSON.stringify({
      schemaVersion: 2,
      executions: {
        [crypto.randomUUID()]: {
          ownerId: record.rootOwnerId,
          pid: record.process!.applicationPid,
          host: record.process!.host,
          token: crypto.randomUUID(),
          heartbeat: record.acceptedAt,
          process: true,
          accesses: record.resources,
          boot: old,
          task: {
            taskId: record.id,
            ownerId: record.rootOwnerId,
            label: record.label,
            foreground: true,
          },
        },
      },
    }),
  );
  const resolution = await store.recovery(record);
  if (
    !stamp.hostId ||
    (stamp.platform === "win32" ? stamp.uptimeMs === undefined : !stamp.bootId)
  ) {
    expect(resolution).toBeUndefined();
  } else {
    expect(resolution).toMatchObject({ kind: "reboot", ownerGone: true });
    await store.assertAccess([{ resource: root, mode: "read" }]);
  }
});
