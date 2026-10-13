import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replaceSessionFile } from "../../sessions/atomic.js";
import { extensionsDirectory } from "../external/package.js";

export async function packageDirectory(...segments: string[]): Promise<string> {
  let current = await extensionsDirectory();
  for (const segment of segments) {
    if (
      !/^[a-zA-Z0-9._-]+$/.test(segment) ||
      segment === "." ||
      segment === ".."
    )
      throw new Error("Недопустимый внутренний путь хранилища.");
    current = join(current, segment);
    await mkdir(current, { recursive: true, mode: 0o700 });
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(
        "Хранилище пакетов содержит ссылку или специальный файл.",
      );
  }
  return realpath(current);
}
export async function boundedJson(
  path: string,
  ceiling = 2 * 1024 * 1024,
): Promise<unknown> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > ceiling
  )
    throw new Error("Небезопасные или слишком большие метаданные пакетов.");
  const input = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino ||
      before.size !== stat.size
    )
      throw new Error("Метаданные изменились при открытии.");
    const bytes = Buffer.alloc(Math.min(ceiling + 1, stat.size + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const part = await input.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    const after = await input.stat(),
      final = await lstat(path);
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      final.isSymbolicLink() ||
      final.dev !== before.dev ||
      final.ino !== before.ino
    )
      throw new Error("Метаданные изменились во время чтения.");
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally {
    await input.close();
  }
}
export async function atomicPackageJson(
  path: string,
  value: unknown,
  assertOwned: () => Promise<void> = async () => {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await replaceSessionFile(temporary, path, assertOwned);
  } finally {
    await rm(temporary, { force: true });
  }
}
