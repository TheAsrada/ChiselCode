import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { chiselHomeDir } from "../paths/home.js";
import { RuntimeError } from "../runtime/errors.js";
import { withLock } from "../sessions/lock.js";
import { type SubagentRecord, subagentActive } from "./contracts.js";
import { SubagentOwnerRecordsSchema, SubagentRecordSchema } from "./schema.js";

export async function processIdentity(
  pid = process.pid,
): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}
export async function processLive(
  owner: NonNullable<SubagentRecord["process"]>,
): Promise<boolean> {
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  return !owner.start || owner.start === (await processIdentity(owner.pid));
}
export class SubagentRecordStore {
  private async path(ownerId: string): Promise<string> {
    z.uuid().parse(ownerId);
    const home = chiselHomeDir();
    await mkdir(home, { recursive: true, mode: 0o700 });
    const directory = join(await realpath(home), "subagents");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error("Небезопасный каталог задач.");
    return join(
      await realpath(directory),
      `${createHash("sha256").update(ownerId).digest("hex")}.json`,
    );
  }
  private async read(path: string, ownerId: string) {
    try {
      const stat = await lstat(path);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.size > 16 * 1024 * 1024
      )
        throw new Error("Небезопасный или слишком большой реестр помощников.");
      const value = SubagentOwnerRecordsSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
      if (value.ownerId !== ownerId)
        throw new Error("Владелец реестра не совпадает.");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        schemaVersion: 1 as const,
        revision: 0,
        ownerId,
        records: [] as SubagentRecord[],
      };
    }
  }
  async list(ownerId: string): Promise<SubagentRecord[]> {
    return (await this.read(await this.path(ownerId), ownerId)).records;
  }
  async update(
    ownerId: string,
    update: (records: SubagentRecord[]) => void | Promise<void>,
  ): Promise<SubagentRecord[]> {
    const path = await this.path(ownerId);
    return withLock(path, async (assertOwned) => {
      const value = await this.read(path, ownerId);
      const revision = value.revision;
      await update(value.records);
      value.revision++;
      const validated = SubagentOwnerRecordsSchema.parse(value);
      const bytes = JSON.stringify(validated, null, 2) + "\n";
      if (Buffer.byteLength(bytes) > 16 * 1024 * 1024)
        throw new Error("Реестр помощников слишком большой.");
      const temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await assertOwned();
        if ((await this.read(path, ownerId)).revision !== revision)
          throw new Error(
            "Реестр помощников изменился; старый writer остановлен.",
          );
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return validated.records;
    });
  }
  async save(record: SubagentRecord): Promise<void> {
    const checked = SubagentRecordSchema.parse(record);
    await this.update(checked.rootOwnerId, (records) => {
      const prior = records.find((item) => item.id === checked.id);
      if (
        prior &&
        (prior.operationKey !== checked.operationKey ||
          prior.parentRoot !== checked.parentRoot ||
          prior.process?.token !== checked.process?.token)
      )
        throw new RuntimeError(
          "SUBAGENT_OWNER_CLOSED",
          "Задача принадлежит другому владельцу процесса.",
        );
      if (prior && prior.revision >= checked.revision) return;
      if (prior) records.splice(records.indexOf(prior), 1, checked);
      else records.push(checked);
    });
  }
  async reconcile(
    ownerId: string,
  ): Promise<{ records: SubagentRecord[]; foreignLive: boolean }> {
    let foreignLive = false;
    const records = await this.update(ownerId, async (records) => {
      for (const record of records) {
        if (!subagentActive(record.status)) continue;
        if (record.process && (await processLive(record.process))) {
          foreignLive = true;
          continue;
        }
        record.status = "interrupted";
        record.finishedAt = record.updatedAt = new Date().toISOString();
        record.step = "Прерван; автоматическое продолжение отключено";
        record.cleanup = { quiescent: false, recoveryRequired: true };
        record.error = {
          code: "SUBAGENT_INTERRUPTED",
          message:
            "Процесс завершился без подтверждённого результата. Изучите историю и файлы; незавершённые инструменты автоматически не повторяются.",
        };
        record.revision++;
      }
    });
    return { records, foreignLive };
  }
}
