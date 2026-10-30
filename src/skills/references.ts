import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { packageRelativePath } from "../utils/package-path.js";
import { resolveProjectPath } from "../utils/paths.js";
import { SKILL_RECEIPT, utf8 } from "./package.js";

export async function readSkillReference(
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  packageRelativePath(path);
  if (path.toLowerCase() === SKILL_RECEIPT)
    throw new Error("Служебный файл источника не является инструкцией навыка.");
  let current = root;
  for (const part of ["", ...path.split("/")]) {
    if (part) current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error("Ссылки в файлах навыка не поддерживаются.");
  }
  // This is an advertised library entry, not a project workspace. Keep its own
  // canonical boundary and no-symlink checks without granting Home as a project.
  const resolved = await resolveProjectPath(root, path);
  const file = await open(
    resolved,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024)
      throw new Error("Чтение навыка ограничено текстовыми файлами до 64 KiB.");
    signal?.throwIfAborted();
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 64 * 1024 || bytes.subarray(0, length).includes(0))
      throw new Error("Файл не является небольшим текстовым документом.");
    return utf8(bytes.subarray(0, length));
  } finally {
    await file.close();
  }
}
