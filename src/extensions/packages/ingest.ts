import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cancelled } from "../../runtime/errors.js";
import { EXTENSION_MANIFEST, EXTERNAL_LIMITS } from "../external/manifest.js";
import { canonicalPath, extensionsDirectory } from "../external/package.js";
import { inside, packageRelativePath } from "./paths.js";
import { extractZip } from "./zip.js";
export interface CaptureProgress {
  phase: "capture" | "extract" | "verify";
  bytes: number;
  files: number;
}
export interface CapturedSource {
  kind: "directory" | "zip";
  location: string;
  bytes: number;
  files: number;
}
export const CAPTURE_LIMITS = {
  zip: 64 * 1024 * 1024,
  budget: 60_000,
  entries: 2048,
  chunk: 64 * 1024,
} as const;
export async function copyRegularFile(
  source: string,
  destination: string,
  ceiling: number,
  signal: AbortSignal,
  onChunk?: (bytes: number) => void,
): Promise<number> {
  const stat = await lstat(source);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > ceiling
  )
    throw new Error(
      "Источник содержит ссылку, специальный или слишком большой файл.",
    );
  const input = await open(
    source,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  let output: FileHandle | undefined;
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino ||
      before.size !== stat.size
    )
      throw new Error("Источник изменился при открытии.");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    output = await open(destination, "wx", 0o600);
    const buffer = Buffer.alloc(CAPTURE_LIMITS.chunk);
    let total = 0;
    for (;;) {
      cancelled(signal);
      const read = await input.read(buffer, 0, buffer.length, total);
      if (!read.bytesRead) break;
      total += read.bytesRead;
      if (total > ceiling || total > stat.size)
        throw new Error("Размер источника изменился или превышает limit.");
      let offset = 0;
      while (offset < read.bytesRead) {
        cancelled(signal);
        offset += (await output.write(buffer, offset, read.bytesRead - offset))
          .bytesWritten;
      }
      onChunk?.(read.bytesRead);
    }
    const after = await input.stat(),
      final = await lstat(source);
    if (
      total !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      final.isSymbolicLink() ||
      final.dev !== before.dev ||
      final.ino !== before.ino
    )
      throw new Error("Источник изменился во время capture.");
    await output.sync();
    return total;
  } finally {
    await output?.close();
    await input.close();
  }
}
export async function captureSource(
  source: string,
  destination: string,
  archiveCopy: string,
  signal: AbortSignal,
  progress?: (value: CaptureProgress) => void,
): Promise<CapturedSource> {
  const original = resolve(source),
    info = await lstat(original);
  if (info.isSymbolicLink())
    throw new Error("Source root не может быть ссылкой/junction.");
  const root = await realpath(original),
    home = await extensionsDirectory();
  if (
    inside(root, destination) ||
    canonicalPath(root) === canonicalPath(home) ||
    ["packages", ".staging", ".runtime", ".management"].some((part) =>
      inside(join(home, part), root),
    )
  )
    throw new Error("Источник пересекается с managed store/cache/staging.");
  let bytes = 0,
    files = 0,
    last = 0;
  const publish = (phase: CaptureProgress["phase"]) => {
    if (Date.now() - last >= 100 || files === 0) {
      progress?.({ phase, bytes, files });
      last = Date.now();
    }
  };
  await mkdir(destination, { mode: 0o700 });
  if (info.isFile()) {
    if (!/\.zip$/i.test(root))
      throw new Error(
        "Поддерживаются папка или ZIP расширения. .tgz приложения/SDK не является пакетом расширения.",
      );
    await copyRegularFile(root, archiveCopy, CAPTURE_LIMITS.zip, signal);
    const result = await extractZip(
      archiveCopy,
      destination,
      signal,
      (value) => {
        bytes = value.bytes;
        files = value.files;
        publish("extract");
      },
    );
    return { kind: "zip", location: root, ...result };
  }
  if (!info.isDirectory())
    throw new Error("Источник должен быть обычной папкой или ZIP.");
  const seen = new Set<string>();
  async function walk(directory: string, prefix: string) {
    cancelled(signal);
    if (canonicalPath(await realpath(directory)) !== canonicalPath(directory))
      throw new Error("Source directory identity изменился.");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      cancelled(signal);
      const path = join(directory, entry.name),
        stat = await lstat(path),
        name = packageRelativePath(prefix + entry.name);
      if (
        seen.has(name.normalize("NFC").toLowerCase()) ||
        seen.size >= CAPTURE_LIMITS.entries
      )
        throw new Error("Повторный путь или слишком много entries.");
      seen.add(name.normalize("NFC").toLowerCase());
      if (stat.isSymbolicLink())
        throw new Error("Ссылки/junction в исходном пакете запрещены.");
      if (stat.isDirectory()) {
        await mkdir(join(destination, name), { mode: 0o700 });
        await walk(path, name + "/");
        continue;
      }
      if (files >= EXTERNAL_LIMITS.files)
        throw new Error("Слишком много файлов пакета.");
      const limit = Math.min(
        EXTERNAL_LIMITS.bytes - bytes,
        name === EXTENSION_MANIFEST
          ? EXTERNAL_LIMITS.manifest
          : EXTERNAL_LIMITS.bytes,
      );
      await copyRegularFile(
        path,
        join(destination, name),
        limit,
        signal,
        (count) => {
          bytes += count;
          publish("capture");
        },
      );
      files++;
    }
  }
  await walk(root, "");
  publish("capture");
  return { kind: "directory", location: root, bytes, files };
}
