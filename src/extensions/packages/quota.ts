import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { extensionsDirectory } from "../external/package.js";
import { PackageManagementError } from "./errors.js";
import { JournalSchema } from "./journal.js";
import { boundedJson, packageDirectory } from "./storage.js";
import { UseSchema } from "./use.js";
export const PACKAGE_BUDGET = 1024 * 1024 * 1024;
/** Called under registry lock. Includes unknown cache data; it never evicts it. */
export async function packageUsageBytes(): Promise<number> {
  const home = await extensionsDirectory(),
    operations = await packageDirectory(".management", "operations"),
    uses = await packageDirectory(".management", "uses");
  let total = 0,
    nodes = 0;
  const reserved = new Set<string>();
  for (const file of await readdir(operations)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file))
      throw new PackageManagementError(
        "PACKAGE_RECOVERY_REQUIRED",
        "Неизвестный operation journal блокирует quota.",
      );
    const record = JournalSchema.parse(
      await boundedJson(join(operations, file), 32 * 1024),
    );
    if (record.operationId !== file.slice(0, -5))
      throw new PackageManagementError(
        "PACKAGE_RECOVERY_REQUIRED",
        "Journal ownership не совпадает.",
      );
    if (
      typeof record.reservedBytes !== "number" ||
      record.reservedBytes < 0 ||
      record.reservedBytes > 128 * 1024 * 1024
    )
      throw new PackageManagementError(
        "PACKAGE_RECOVERY_REQUIRED",
        "Повреждённая reservation.",
      );
    if (record.reservedBytes) {
      total += record.reservedBytes;
      reserved.add(file.slice(0, -5));
    }
  }
  for (const file of await readdir(uses)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file))
      throw new PackageManagementError(
        "PACKAGE_RECOVERY_REQUIRED",
        "Неизвестный use lease блокирует quota.",
      );
    const record = UseSchema.parse(await boundedJson(join(uses, file), 8192));
    if (record.token !== file.slice(0, -5))
      throw new PackageManagementError(
        "PACKAGE_RECOVERY_REQUIRED",
        "Use lease ownership не совпадает.",
      );
    if (
      typeof record.reservedBytes !== "number" ||
      record.reservedBytes < 0 ||
      record.reservedBytes > 128 * 1024 * 1024
    )
      throw new PackageManagementError(
        "PACKAGE_RECOVERY_REQUIRED",
        "Повреждённая use reservation.",
      );
    total += record.reservedBytes;
  }
  const walk = async (path: string, staging = false): Promise<void> => {
    let stat: Stats;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (++nodes > 131072 || stat.isSymbolicLink())
      throw new PackageManagementError(
        "PACKAGE_RECOVERY_REQUIRED",
        "Store содержит неизвестные/слишком многочисленные пути.",
      );
    if (stat.isDirectory()) {
      for (const name of await readdir(path))
        if (!staging || !reserved.has(name)) await walk(join(path, name));
    } else if (stat.isFile()) total += stat.size;
    else
      throw new PackageManagementError(
        "PACKAGE_RECOVERY_REQUIRED",
        "Store содержит special file.",
      );
    if (total > PACKAGE_BUDGET)
      throw new PackageManagementError(
        "PACKAGE_QUOTA",
        "Хранилище расширений превышает 1 GiB; unknown/used bytes не удаляются автоматически.",
      );
  };
  for (const part of ["packages", ".runtime", ".staging"])
    await walk(join(home, part), part === ".staging");
  return total;
}
export async function checkPackageQuota(reservation: number): Promise<void> {
  if ((await packageUsageBytes()) + reservation > PACKAGE_BUDGET)
    throw new PackageManagementError(
      "PACKAGE_QUOTA",
      "Недостаточно места в лимите 1 GiB для staging/runtime reservation; текущая версия сохранена.",
    );
}
