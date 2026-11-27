import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
export async function file(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error("Файл пропущен.");
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.ino !== info.ino ||
      opened.dev !== info.dev ||
      opened.size > limit
    )
      throw new Error("Исходный файл изменился.");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function json(path: string): Promise<Record<string, unknown>> {
  try {
    return record(
      Bun.JSONC.parse((await file(path, 2 * 1024 * 1024)).toString("utf8")),
    );
  } catch (error) {
    if (missing(error)) return {};
    throw error;
  }
}

export async function entries(path: string) {
  try {
    if (!(await lstat(path)).isDirectory()) return [];
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

export async function filesUnder(
  root: string,
  accept: (name: string) => boolean,
  maxDepth: number,
  maxEntries = 50_000,
): Promise<string[]> {
  const paths: string[] = [];
  let visited = 0;
  async function walk(dir: string, depth: number) {
    for (const entry of await entries(dir)) {
      if (++visited > maxEntries)
        throw new Error("Слишком много исходных файлов.");
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) await walk(path, depth + 1);
      else if (entry.isFile() && accept(entry.name)) paths.push(path);
    }
  }
  await walk(root, 0);
  return paths.sort();
}

export function packagePath(root: string, path: string): string {
  const local = relative(root, path);
  if (!local || isAbsolute(local) || /^\.\.(?:[\\/]|$)/.test(local))
    throw new Error("Путь за пределами пакета.");
  return process.platform === "win32" ? local.replaceAll("\\", "/") : local;
}
