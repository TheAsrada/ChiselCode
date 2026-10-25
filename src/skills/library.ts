import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { chiselHomeDir, skillsRootDir, userSkillsDir } from "../paths/home.js";
import { cancelled } from "../runtime/errors.js";
import { withLock } from "../sessions/lock.js";
import {
  SKILL_RECEIPT,
  type SkillPackage,
  validateSkillPackage,
} from "./package.js";

export async function ensureSkillsLibrary(): Promise<void> {
  for (const path of [chiselHomeDir(), skillsRootDir(), userSkillsDir()]) {
    await mkdir(path, { recursive: true });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Небезопасная папка навыков: ${path}`);
  }
}
export async function withSkillsLibraryLock<T>(
  action: (assertOwned: () => Promise<void>) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  await ensureSkillsLibrary();
  return withLock(
    join(skillsRootDir(), ".library.lock"),
    async (assertOwned) => {
      await assertOwned();
      cancelled(signal);
      return action(assertOwned);
    },
    signal,
  );
}
export async function publishSkill(
  pkg: SkillPackage,
  signal?: AbortSignal,
): Promise<{ path: string; alreadyInstalled: boolean }> {
  pkg = validateSkillPackage(pkg.files, pkg.metadata.name, pkg.origin);
  return withSkillsLibraryLock(async (assertOwned) => {
    const path = join(userSkillsDir(), pkg.metadata.name);
    try {
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        try {
          const receiptInfo = await lstat(join(path, SKILL_RECEIPT));
          if (
            !receiptInfo.isFile() ||
            receiptInfo.isSymbolicLink() ||
            receiptInfo.size > 64 * 1024
          )
            throw new Error("Некорректный receipt навыка.");
          const receipt = JSON.parse(
            await readFile(join(path, SKILL_RECEIPT), "utf8"),
          );
          const files = new Map<string, Uint8Array>();
          let visited = 0;
          async function visit(directory: string, prefix = ""): Promise<void> {
            for (const entry of await readdir(directory, {
              withFileTypes: true,
            })) {
              cancelled(signal);
              if (++visited > pkg.files.size * 32 + 1)
                throw new Error("Состав навыка изменён.");
              const name = `${prefix}${entry.name}`;
              if (name === SKILL_RECEIPT && entry.isFile()) continue;
              if (entry.isSymbolicLink())
                throw new Error("Ссылка в установленном навыке.");
              if (entry.isDirectory())
                await visit(join(directory, entry.name), `${name}/`);
              else if (entry.isFile() && pkg.files.has(name)) {
                const stat = await lstat(join(directory, entry.name));
                if (stat.size !== pkg.files.get(name)?.byteLength)
                  throw new Error("Файл изменён.");
                files.set(name, await readFile(join(directory, entry.name)));
              } else throw new Error("Состав навыка изменён.");
            }
          }
          await visit(path);
          if (
            receipt.version === 1 &&
            validateSkillPackage(files, pkg.metadata.name, pkg.origin)
              .digest === pkg.digest
          )
            return { path, alreadyInstalled: true };
        } catch {
          // Preserve any existing, edited or unmanaged skill.
          cancelled(signal);
        }
      }
      throw new Error(
        `Навык ${pkg.metadata.name} уже существует. Его файлы сохранены; автоматическая перезапись запрещена.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const visible = (await readdir(userSkillsDir())).filter(
      (name) => !name.startsWith("."),
    );
    if (visible.length >= 100)
      throw new Error(
        "В библиотеке уже 100 пользовательских навыков. Освободите место перед установкой.",
      );
    const stage = join(userSkillsDir(), `.install-${randomUUID()}`);
    try {
      await mkdir(stage, { mode: 0o700 });
      for (const [name, bytes] of pkg.files) {
        cancelled(signal);
        const target = join(stage, name);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { flag: "wx", mode: 0o600, signal });
      }
      await writeFile(
        join(stage, SKILL_RECEIPT),
        `${JSON.stringify({ version: 1, ...pkg.origin, digest: pkg.digest, files: [...pkg.files.keys()].sort() }, null, 2)}\n`,
        { flag: "wx", mode: 0o600, signal },
      );
      cancelled(signal);
      try {
        await lstat(path);
        throw new Error(`Навык ${pkg.metadata.name} уже существует.`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await assertOwned();
      await rename(stage, path);
      return { path, alreadyInstalled: false };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }, signal);
}
