import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  BootStampSchema,
  bootChanged,
  readBootStamp,
} from "../processes/boot.js";
import {
  type ProcessExecutionIdentity,
  type ProcessProofGrant,
  readCleanupProof,
} from "../processes/cleanup-proof.js";
import {
  currentProcessIdentity,
  identityState,
} from "../processes/identity.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { withLock } from "../sessions/lock.js";
import {
  accessPlansConflict,
  type BackgroundResourceOwner,
  backgroundResourceError,
  type WorkspaceAccess,
} from "../tools/workspace-coordinator.js";
import { atomicWorktreeJson } from "../worktrees/registry.js";
import type { BackgroundTaskRecord } from "./contracts.js";

const AccessSchema = z.object({
  resource: z.string(),
  mode: z.enum(["read", "write"]),
});
const OwnerSchema = z
  .object({
    taskId: z.uuid(),
    ownerId: z.uuid(),
    label: z.string(),
    state: z.string(),
  })
  .strict();
const TaskSchema = z
  .object({
    taskId: z.uuid(),
    ownerId: z.uuid(),
    label: z.string(),
    foreground: z.boolean(),
    instance: z.uuid().optional(),
    token: z.uuid().optional(),
  })
  .strict();
const ResolutionSchema = z
  .object({
    kind: z.enum(["cleanup", "reboot"]),
    finishedAt: z.string(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    ownerGone: z.boolean(),
  })
  .strict();
export type ExecutionResolution = z.infer<typeof ResolutionSchema>;
const EntrySchema = z
  .object({
    ownerId: z.uuid(),
    pid: z.number().int().positive(),
    host: z.string(),
    start: z.string().optional(),
    token: z.uuid(),
    heartbeat: z.string(),
    process: z.boolean(),
    accesses: z.array(AccessSchema),
    background: OwnerSchema.optional(),
    task: TaskSchema.optional(),
    boot: BootStampSchema.optional(),
    resolution: ResolutionSchema.optional(),
  })
  .strict();
type Entry = z.infer<typeof EntrySchema>;
const RegistrySchema = z
  .object({
    schemaVersion: z.literal(2),
    executions: z.record(z.uuid(), EntrySchema),
  })
  .strict();
type Registry = z.infer<typeof RegistrySchema>;

/** The only authority for resource ownership. Reservations account for output bytes. */
export class BackgroundExecutionStore {
  constructor(
    private directory: () => Promise<string>,
    private records: () => Promise<BackgroundTaskRecord[]>,
  ) {}

  private async json(path: string): Promise<unknown> {
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 8 * 1024 * 1024
      )
        throw new RuntimeError(
          "BACKGROUND_STORAGE_FAILURE",
          "Некорректный реестр команд.",
        );
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  private task(record: BackgroundTaskRecord): Entry["task"] {
    return {
      taskId: record.id,
      ownerId: record.rootOwnerId,
      label: record.label,
      foreground: record.foreground,
      instance: record.process?.instance,
      token: record.process?.token,
    };
  }
  private async registry(directory: string): Promise<Registry> {
    const raw = await this.json(join(directory, "executions.json"));
    if (
      raw &&
      typeof raw === "object" &&
      "schemaVersion" in raw &&
      raw.schemaVersion === 2
    )
      return RegistrySchema.parse(raw);
    const old = z
      .object({
        schemaVersion: z.literal(1),
        executions: z.record(
          z.uuid(),
          EntrySchema.omit({ task: true, boot: true, resolution: true }),
        ),
      })
      .strict()
      .parse(raw ?? { schemaVersion: 1, executions: {} });
    const records = await this.records();
    const value: Registry = { schemaVersion: 2, executions: {} };
    for (const [id, entry] of Object.entries(old.executions)) {
      const candidates = records.filter(
        (record) =>
          record.rootOwnerId === entry.ownerId &&
          (entry.background
            ? record.id === entry.background.taskId
            : record.process?.applicationPid === entry.pid &&
              accessPlansConflict(record.resources, entry.accesses)),
      );
      value.executions[id] = {
        ...entry,
        ...(candidates.length === 1 ? { task: this.task(candidates[0]!) } : {}),
      };
    }
    const reservations = z
      .object({
        reservations: z.record(
          z.string(),
          z.object({
            ownerId: z.uuid(),
            resources: z.array(AccessSchema),
            label: z.string(),
            foreground: z.boolean().optional(),
          }),
        ),
      })
      .passthrough()
      .parse(
        (await this.json(join(directory, "reservations.json"))) ?? {
          reservations: {},
        },
      );
    for (const [taskId, reservation] of Object.entries(
      reservations.reservations,
    )) {
      if (
        !reservation.resources.length ||
        Object.values(value.executions).some(
          (entry) =>
            entry.task?.taskId === taskId ||
            entry.background?.taskId === taskId,
        )
      )
        continue;
      const record = records.find((item) => item.id === taskId);
      value.executions[randomUUID()] = {
        ownerId: reservation.ownerId,
        pid: record?.process?.applicationPid ?? 1,
        host: record?.process?.host ?? "unknown",
        start: record?.process?.start,
        token: randomUUID(),
        heartbeat: record?.updatedAt ?? "",
        process: true,
        accesses: reservation.resources,
        task: record
          ? this.task(record)
          : {
              taskId,
              ownerId: reservation.ownerId,
              label: reservation.label,
              foreground: reservation.foreground ?? false,
            },
      };
    }
    return value;
  }
  async proofPath(taskId: string, instance: string): Promise<string> {
    z.uuid().parse(taskId);
    z.uuid().parse(instance);
    const directory = join(await this.directory(), "cleanup");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (
      (await lstat(directory)).isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      throw new RuntimeError(
        "BACKGROUND_STORAGE_FAILURE",
        "Каталог завершения команды подменён.",
      );
    return join(directory, `${taskId}.${instance}.json`);
  }
  private async state(entry: Entry): Promise<"live" | "dead" | "unknown"> {
    if (!entry.start) {
      if (entry.host !== hostname()) return "unknown";
      try {
        process.kill(entry.pid, 0);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
          ? "dead"
          : "unknown";
      }
      return "unknown";
    }
    // v1 Linux birth ticks predate the shared boot-qualified identity.
    if (process.platform === "linux" && /^\d+$/.test(entry.start)) {
      if (entry.host !== hostname()) return "unknown";
      try {
        const stat = await readFile(`/proc/${entry.pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ===
          entry.start
          ? "live"
          : "dead";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "dead"
          : "unknown";
      }
    }
    return identityState(entry);
  }
  private async reconcile(value: Registry): Promise<void> {
    const boot = await readBootStamp();
    for (const entry of Object.values(value.executions)) {
      if (entry.resolution) continue;
      const task = entry.task;
      const proof =
        task?.instance && task.token
          ? await readCleanupProof(
              await this.proofPath(task.taskId, task.instance),
              {
                taskId: task.taskId,
                ownerId: entry.ownerId,
                instance: task.instance,
                token: task.token,
              },
            )
          : undefined;
      if (proof)
        entry.resolution = {
          kind: "cleanup",
          finishedAt: proof.finishedAt,
          exitCode: proof.exitCode,
          signal: proof.signal,
          ownerGone: proof.ownerGone,
        };
      else if (entry.boot && bootChanged(entry.boot, boot))
        entry.resolution = {
          kind: "reboot",
          finishedAt: new Date().toISOString(),
          exitCode: null,
          signal: null,
          ownerGone: true,
        };
      // A legacy claim needs an observation BEFORE a subsequent proven reboot.
      if (!entry.boot && entry.host === boot.host) entry.boot = boot;
      if (entry.resolution) entry.accesses = [];
    }
  }
  private async locked<T>(
    work: (value: Registry, save: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const directory = await this.directory();
    return withLock(join(directory, "resources"), async (assertOwned) => {
      const value = await this.registry(directory);
      const before = JSON.stringify(value);
      await this.reconcile(value);
      const save = () =>
        atomicWorktreeJson(
          join(directory, "executions.json"),
          value,
          assertOwned,
        );
      // Commit migration/reconciliation even when the requested operation conflicts.
      const raw = await this.json(join(directory, "executions.json"));
      if (
        !raw ||
        (raw as { schemaVersion: number }).schemaVersion !== 2 ||
        before !== JSON.stringify(value)
      )
        await save();
      return work(value, save);
    });
  }
  private async blocker(
    entry: Entry,
  ): Promise<BackgroundResourceOwner | undefined> {
    if (!entry.process && !entry.background) return;
    const live = await this.state(entry);
    const needsRecovery =
      live !== "live" || entry.background?.state === "cleanup_unknown";
    if (
      !needsRecovery &&
      (entry.task?.foreground || (!entry.task && !entry.background))
    )
      return;
    const task = entry.task ?? entry.background;
    return {
      taskId: task?.taskId ?? entry.token,
      ownerId: entry.ownerId,
      label: task?.label ?? "Предыдущая команда",
      state: needsRecovery ? "cleanup_unknown" : "running",
    };
  }
  async assertAccess(
    accesses: readonly WorkspaceAccess[],
    ownTaskId?: string,
  ): Promise<void> {
    await this.locked(async (value) => {
      for (const entry of Object.values(value.executions)) {
        if (
          (ownTaskId !== undefined &&
            (entry.task?.taskId === ownTaskId ||
              entry.background?.taskId === ownTaskId)) ||
          !accessPlansConflict(accesses, entry.accesses)
        )
          continue;
        const blocker = await this.blocker(entry);
        if (blocker) throw backgroundResourceError(blocker);
      }
    });
  }
  async fencedTaskIds(ownerId: string): Promise<ReadonlySet<string>> {
    return this.locked(
      async (value) =>
        new Set(
          Object.values(value.executions).flatMap((entry) =>
            entry.ownerId === ownerId && entry.accesses.length
              ? [entry.task?.taskId ?? entry.background?.taskId].filter(
                  (id): id is string => !!id,
                )
              : [],
          ),
        ),
    );
  }
  async recovery(
    record: BackgroundTaskRecord,
  ): Promise<ExecutionResolution | undefined> {
    return this.locked(async (value) => {
      const entry = Object.values(value.executions).find(
        (item) =>
          item.ownerId === record.rootOwnerId &&
          item.task?.taskId === record.id,
      );
      const p = record.process;
      if (
        entry?.task?.instance &&
        (entry.task.instance !== p?.instance || entry.task.token !== p?.token)
      )
        return;
      if (entry?.resolution) return entry.resolution;
      if (!p) return;
      const proof = await readCleanupProof(
        await this.proofPath(record.id, p.instance),
        {
          taskId: record.id,
          ownerId: record.rootOwnerId,
          instance: p.instance,
          token: p.token,
        },
      );
      if (proof)
        return {
          kind: "cleanup",
          finishedAt: proof.finishedAt,
          exitCode: proof.exitCode,
          signal: proof.signal,
          ownerGone: proof.ownerGone,
        };
    });
  }
  async acknowledge(record: BackgroundTaskRecord): Promise<void> {
    const acknowledged = await this.locked(async (value, save) => {
      let changed = false;
      if (
        Object.values(value.executions).some(
          (entry) =>
            entry.ownerId === record.rootOwnerId &&
            entry.task?.taskId === record.id &&
            entry.accesses.length,
        )
      )
        return false;
      for (const [id, entry] of Object.entries(value.executions))
        if (
          entry.ownerId === record.rootOwnerId &&
          entry.task?.taskId === record.id &&
          entry.resolution
        ) {
          delete value.executions[id];
          changed = true;
        }
      if (changed) await save();
      return true;
    });
    if (acknowledged && record.process)
      await rm(await this.proofPath(record.id, record.process.instance), {
        force: true,
      });
  }
  async acquire(
    ownerId: string,
    accesses: readonly WorkspaceAccess[],
    signal?: AbortSignal,
    ownsProcess = false,
  ) {
    const id = randomUUID(),
      token = randomUUID();
    const identity = await currentProcessIdentity();
    const entry: Entry = {
      ...identity,
      ownerId,
      token,
      heartbeat: new Date().toISOString(),
      process: ownsProcess,
      accesses: [...accesses],
      boot: await readBootStamp(),
    };
    for (;;) {
      cancelled(signal);
      const granted = await this.locked(async (value, save) => {
        let blocked = false;
        for (const [key, other] of Object.entries(value.executions)) {
          if (!accessPlansConflict(accesses, other.accesses)) continue;
          const live = await this.state(other);
          if (!other.process && !other.background && live === "dead") {
            delete value.executions[key];
            continue;
          }
          const blocker = await this.blocker(other);
          if (blocker) throw backgroundResourceError(blocker);
          blocked = true;
        }
        if (blocked) return false;
        value.executions[id] = entry;
        await save();
        return true;
      });
      if (granted) break;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 100);
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted) done();
      });
    }
    let released = false;
    const edit = (work: (entry: Entry) => void, remove = false) =>
      this.locked(async (value, save) => {
        const current = value.executions[id];
        if (!current && remove) return;
        if (!current || current.token !== token)
          throw new RuntimeError(
            "BACKGROUND_RECOVERY_REQUIRED",
            "Владение командой изменилось; требуется проверка.",
          );
        if (remove) delete value.executions[id];
        else work(current);
        await save();
      });
    return {
      registerProcess: async (
        task: ProcessExecutionIdentity,
      ): Promise<ProcessProofGrant> => {
        if (task.ownerId !== ownerId || !ownsProcess)
          throw new RuntimeError(
            "PERMISSION_DENIED",
            "Запуск требует разрешённого core execution path.",
          );
        const parsed = TaskSchema.required({
          instance: true,
          token: true,
        }).parse(task);
        await edit((current) => {
          if (current.task)
            throw new RuntimeError(
              "PERMISSION_DENIED",
              "Запуск уже привязан к команде.",
            );
          current.task = parsed;
        });
        return {
          ...task,
          path: await this.proofPath(task.taskId, task.instance),
        };
      },
      adopt: (background: BackgroundResourceOwner) =>
        edit((current) => {
          current.background = background;
          if (current.task && background.state === "running")
            current.task.foreground = false;
        }),
      requireRecovery: () =>
        edit((current) => {
          if (current.background) current.background.state = "cleanup_unknown";
        }),
      release: async () => {
        if (released) return;
        await edit(() => {}, true);
        released = true;
      },
    };
  }
}
