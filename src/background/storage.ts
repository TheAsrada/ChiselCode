import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { chiselHomeDir } from "../paths/home.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { withLock } from "../sessions/lock.js";
import { processIdentity, processLive } from "../subagents/storage.js";
import type {
  BackgroundResourceOwner,
  WorkspaceAccess,
} from "../tools/workspace-coordinator.js";
import { accessPlansConflict } from "../tools/workspace-coordinator.js";
import { atomicWorktreeJson } from "../worktrees/registry.js";
import { BACKGROUND_LIMITS } from "./config.js";
import {
  type BackgroundTaskRecord,
  BackgroundTaskSchema,
} from "./contracts.js";

const OwnerSchema = z
  .object({
    schemaVersion: z.literal(1),
    ownerId: z.uuid(),
    revision: z.number().int().nonnegative(),
    records: z
      .array(BackgroundTaskSchema)
      .max(BACKGROUND_LIMITS.acceptedPerOwner),
    completions: z
      .record(
        z.uuid(),
        z.object({
          root: z.number().int().nonnegative().optional(),
          child: z.number().int().nonnegative().optional(),
        }),
      )
      .default({}),
  })
  .strict();
const ReservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    reservations: z.record(
      z.string(),
      z
        .object({
          ownerId: z.uuid(),
          bytes: z.number().int().nonnegative(),
          resources: z.array(
            z.object({ resource: z.string(), mode: z.enum(["read", "write"]) }),
          ),
          label: z.string(),
          recovery: z.boolean(),
          foreground: z.boolean().default(false),
        })
        .strict(),
    ),
  })
  .strict();
const ExecutionSchema = z
  .object({
    schemaVersion: z.literal(1),
    executions: z.record(
      z.uuid(),
      z
        .object({
          ownerId: z.uuid(),
          pid: z.number().int().positive(),
          host: z.string(),
          start: z.string().optional(),
          token: z.uuid(),
          heartbeat: z.string(),
          process: z.boolean(),
          accesses: z.array(
            z.object({ resource: z.string(), mode: z.enum(["read", "write"]) }),
          ),
          background: z
            .object({
              taskId: z.uuid(),
              ownerId: z.uuid(),
              label: z.string(),
              state: z.string(),
            })
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();
export class BackgroundTaskStore {
  async consumeCompletions(
    ownerId: string,
    records: readonly BackgroundTaskRecord[],
    child = false,
  ): Promise<BackgroundTaskRecord[]> {
    const path = await this.ownerPath(ownerId);
    return withLock(path, async (assertOwned) => {
      const value = this.readOwner(await this.json(path), ownerId);
      const key = child ? "child" : "root";
      const pending = records
        .filter(
          (record) =>
            (value.completions[record.id]?.[key] ?? -1) <
            (record.terminalRevision ?? record.revision),
        )
        .slice(0, 16);
      for (const record of pending)
        value.completions[record.id] = {
          ...value.completions[record.id],
          [key]: record.terminalRevision ?? record.revision,
        };
      if (pending.length) await atomicWorktreeJson(path, value, assertOwned);
      return pending;
    });
  }
  /** Presence is a recovery fence; absence alone never proves process cleanup. */
  async fencedTaskIds(ownerId: string): Promise<ReadonlySet<string>> {
    const directory = await this.directory();
    return withLock(join(directory, "resources"), async () => {
      const executions = ExecutionSchema.parse(
        (await this.json(join(directory, "executions.json"))) ?? {
          schemaVersion: 1,
          executions: {},
        },
      );
      const reservations = await this.reservations();
      return new Set([
        ...Object.entries(reservations)
          .filter(
            ([, entry]) =>
              entry.ownerId === ownerId && entry.resources.length > 0,
          )
          .map(([id]) => id),
        ...Object.values(executions.executions).flatMap((entry) =>
          entry.ownerId === ownerId && entry.background
            ? [entry.background.taskId]
            : [],
        ),
      ]);
    });
  }
  /** The registry lock covers check + grant + adoption, never command lifetime. */
  async acquireExecution(
    ownerId: string,
    accesses: readonly WorkspaceAccess[],
    signal?: AbortSignal,
    process = false,
  ) {
    const directory = await this.directory();
    const path = join(directory, "executions.json");
    const lockPath = join(directory, "resources");
    const id = randomUUID();
    const token = randomUUID();
    const identity = {
      ownerId,
      pid: globalThis.process.pid,
      host: hostname(),
      start: await processIdentity(),
      token,
      heartbeat: new Date().toISOString(),
      process,
      accesses: [...accesses],
    };
    while (true) {
      cancelled(signal);
      const granted = await withLock(lockPath, async (assertOwned) => {
        const value = ExecutionSchema.parse(
          (await this.json(path)) ?? { schemaVersion: 1, executions: {} },
        );
        const reservations = await this.reservations();
        for (const [taskId, other] of Object.entries(reservations)) {
          if (
            !other.foreground &&
            accessPlansConflict(accesses, other.resources)
          )
            throw new RuntimeError(
              "BACKGROUND_RESOURCE_BUSY",
              `Ресурс занят фоновой задачей «${other.label}».`,
              {
                taskId,
                ownerId: other.ownerId,
                label: other.label,
                state: other.recovery ? "cleanup_unknown" : "running",
              },
            );
        }
        let blocked = false;
        for (const [key, other] of Object.entries(value.executions)) {
          if (!accessPlansConflict(accesses, other.accesses)) continue;
          if (other.background)
            throw new RuntimeError(
              "BACKGROUND_RESOURCE_BUSY",
              `Ресурс занят фоновой задачей «${other.background.label}».`,
              other.background,
            );
          const live = await processLive(other);
          // Ordinary file operations have no owned descendants. Shell leases survive a crash as recovery fences.
          if (!live && !other.process && other.host === hostname()) {
            delete value.executions[key];
            continue;
          }
          if (!live && other.process)
            throw new RuntimeError(
              "BACKGROUND_RECOVERY_REQUIRED",
              "Ресурс использовала команда прерванного приложения. Завершение процессов требует проверки.",
              { ownerId: other.ownerId, resource: accesses[0]?.resource },
            );
          blocked = true;
        }
        if (blocked) return false;
        value.executions[id] = identity;
        await atomicWorktreeJson(path, value, assertOwned);
        return true;
      });
      if (granted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 100);
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    let released = false;
    const edit = async (background?: BackgroundResourceOwner, remove = false) =>
      withLock(lockPath, async (assertOwned) => {
        const value = ExecutionSchema.parse(
          (await this.json(path)) ?? { schemaVersion: 1, executions: {} },
        );
        const entry = value.executions[id];
        if (!entry || entry.token !== token)
          throw new RuntimeError(
            "BACKGROUND_RECOVERY_REQUIRED",
            "Владение ресурсом изменилось; доступ не освобождён.",
          );
        if (remove) delete value.executions[id];
        else entry.background = background;
        await atomicWorktreeJson(path, value, assertOwned);
      });
    return {
      adopt: (background: BackgroundResourceOwner) => edit(background),
      release: async () => {
        if (released) return;
        await edit(undefined, true);
        released = true;
      },
    };
  }
  async directory(): Promise<string> {
    await mkdir(chiselHomeDir(), { recursive: true, mode: 0o700 });
    const directory = join(await realpath(chiselHomeDir()), "background-tasks");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new RuntimeError(
        "BACKGROUND_STORAGE_FAILURE",
        "Каталог фоновых задач подменён; запись отменена.",
      );
    return directory;
  }
  async outputPath(id: string): Promise<string> {
    z.uuid().parse(id);
    return join(await this.directory(), `${id}.log`);
  }
  async saveForeground(record: BackgroundTaskRecord): Promise<void> {
    await atomicWorktreeJson(
      join(
        await this.directory(),
        `${z.uuid().parse(record.id)}.foreground.json`,
      ),
      BackgroundTaskSchema.parse(record),
    );
  }
  async listForeground(ownerId: string): Promise<BackgroundTaskRecord[]> {
    const directory = await this.directory();
    const records: BackgroundTaskRecord[] = [];
    for (const name of await readdir(directory))
      if (/^[a-f0-9-]{36}\.foreground\.json$/.test(name)) {
        const record = BackgroundTaskSchema.parse(
          await this.json(join(directory, name)),
        );
        if (record.rootOwnerId === ownerId) records.push(record);
      }
    return records;
  }
  async removeForeground(record: BackgroundTaskRecord): Promise<void> {
    if (!record.cleanup.confirmed)
      throw new RuntimeError(
        "BACKGROUND_RECOVERY_REQUIRED",
        "Завершение процессов не подтверждено.",
      );
    await rm(
      join(
        await this.directory(),
        `${z.uuid().parse(record.id)}.foreground.json`,
      ),
      { force: true },
    );
  }
  async removePromotedForeground(record: BackgroundTaskRecord): Promise<void> {
    // Verify the acknowledged handoff, not a live output revision that may
    // change during this read. Identity and durable revision guards remain.
    const proof = BackgroundTaskSchema.parse(record);
    const saved = (await this.list(proof.rootOwnerId)).find(
      (item) => item.id === proof.id,
    );
    if (
      proof.foreground ||
      !saved ||
      saved.foreground ||
      saved.process?.token !== proof.process?.token ||
      saved.revision < proof.revision
    )
      throw new RuntimeError(
        "BACKGROUND_STORAGE_FAILURE",
        "Передача не сохранена; marker остаётся.",
      );
    await rm(
      join(
        await this.directory(),
        `${z.uuid().parse(proof.id)}.foreground.json`,
      ),
      { force: true },
    );
  }
  private async ownerPath(id: string): Promise<string> {
    z.uuid().parse(id);
    return join(
      await this.directory(),
      `${createHash("sha256").update(id).digest("hex")}.json`,
    );
  }
  private async json(path: string): Promise<unknown | undefined> {
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 8 * 1024 * 1024
      )
        throw new Error("Некорректный реестр фоновых задач.");
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  async list(ownerId: string): Promise<BackgroundTaskRecord[]> {
    const value = this.readOwner(
      await this.json(await this.ownerPath(ownerId)),
      ownerId,
    );
    return value.records;
  }
  private readOwner(value: unknown, ownerId: string) {
    const record = OwnerSchema.parse(
      value ?? { schemaVersion: 1, ownerId, revision: 0, records: [] },
    );
    if (
      record.ownerId !== ownerId ||
      record.records.some((task) => task.rootOwnerId !== ownerId)
    )
      throw new Error("Владелец фоновых задач не совпадает.");
    return record;
  }
  async save(record: BackgroundTaskRecord): Promise<void> {
    const checked = BackgroundTaskSchema.parse(record);
    const path = await this.ownerPath(record.rootOwnerId);
    await withLock(path, async (assertOwned) => {
      const value = this.readOwner(await this.json(path), record.rootOwnerId);
      const prior = value.records.find((item) => item.id === checked.id);
      if (
        prior &&
        (prior.operationKey !== checked.operationKey ||
          prior.process?.token !== checked.process?.token)
      )
        throw new RuntimeError(
          "BACKGROUND_OWNER_CLOSED",
          "Запись принадлежит другому процессу.",
        );
      if (prior && prior.revision >= checked.revision) return;
      if (prior) value.records.splice(value.records.indexOf(prior), 1, checked);
      else value.records.push(checked);
      value.revision++;
      await assertOwned();
      await atomicWorktreeJson(path, OwnerSchema.parse(value), assertOwned);
    });
  }
  async reserve(record: BackgroundTaskRecord): Promise<void> {
    const path = join(await this.directory(), "reservations.json");
    await withLock(path, async (assertOwned) => {
      const value = ReservationSchema.parse(
        (await this.json(path)) ?? { schemaVersion: 1, reservations: {} },
      );
      if (value.reservations[record.id]) return;
      const reservations = Object.values(value.reservations);
      const ownerBytes = reservations
        .filter((r) => r.ownerId === record.rootOwnerId)
        .reduce((n, r) => n + r.bytes, 0);
      const appBytes = reservations.reduce((n, r) => n + r.bytes, 0);
      if (
        ownerBytes + record.outputLimit > BACKGROUND_LIMITS.ownerBytes ||
        appBytes + record.outputLimit > BACKGROUND_LIMITS.applicationBytes
      )
        throw new RuntimeError(
          "BACKGROUND_LIMIT",
          "Лимит сохранённого вывода занят. Удалите историю завершённых задач.",
        );
      value.reservations[record.id] = {
        ownerId: record.rootOwnerId,
        bytes: record.outputLimit,
        resources: [],
        label: record.label,
        recovery: false,
        foreground: record.foreground,
      };
      await atomicWorktreeJson(path, value, assertOwned);
    });
  }
  async lease(record: BackgroundTaskRecord, retained = false): Promise<void> {
    const path = join(await this.directory(), "reservations.json");
    await withLock(path, async (assertOwned) => {
      const value = ReservationSchema.parse(
        (await this.json(path)) ?? { schemaVersion: 1, reservations: {} },
      );
      const reservation = value.reservations[record.id];
      if (!reservation)
        throw new RuntimeError(
          "BACKGROUND_STORAGE_FAILURE",
          "Резервирование вывода потеряно; процесс не запускается.",
        );
      if (!retained)
        for (const [id, other] of Object.entries(value.reservations)) {
          if (
            id !== record.id &&
            accessPlansConflict(record.resources, other.resources)
          )
            throw new RuntimeError(
              "BACKGROUND_RESOURCE_BUSY",
              `Ресурс занят фоновой задачей «${other.label}».`,
              {
                taskId: id,
                ownerId: other.ownerId,
                label: other.label,
                state: other.recovery ? "cleanup_unknown" : "running",
              },
            );
        }
      reservation.resources = retained ? [] : record.resources;
      reservation.recovery = !record.cleanup.confirmed;
      reservation.foreground = record.foreground;
      if (retained) reservation.bytes = record.outputBytes;
      await atomicWorktreeJson(path, value, assertOwned);
    });
  }
  async reservations() {
    return ReservationSchema.parse(
      (await this.json(join(await this.directory(), "reservations.json"))) ?? {
        schemaVersion: 1,
        reservations: {},
      },
    ).reservations;
  }
  async removeOutput(record: BackgroundTaskRecord): Promise<void> {
    if (!record.cleanup.confirmed)
      throw new RuntimeError(
        "BACKGROUND_RECOVERY_REQUIRED",
        "Завершение процессов не подтверждено; история и маркеры сохранены.",
      );
    const path = join(await this.directory(), "reservations.json");
    await withLock(path, async (assertOwned) => {
      const value = ReservationSchema.parse(
        (await this.json(path)) ?? { schemaVersion: 1, reservations: {} },
      );
      await rm(await this.outputPath(record.id), { force: true });
      delete value.reservations[record.id];
      await atomicWorktreeJson(path, value, assertOwned);
    });
  }
  newToken(): string {
    return randomUUID();
  }
}
