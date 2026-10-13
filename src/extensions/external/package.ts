import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { chiselHomeDir } from "../../paths/home.js";
import { cancelled } from "../../runtime/errors.js";
import {
  compatibility,
  EXTENSION_MANIFEST,
  EXTERNAL_LIMITS,
  type ExtensionManifest,
  ExtensionManifestSchema,
} from "./manifest.js";

export interface InspectedPackage {
  readonly location: string;
  readonly digest: string;
  readonly manifest: ExtensionManifest;
  readonly files: number;
  readonly bytes: number;
  readonly incompatible?: string;
}
export function canonicalPath(path: string): string {
  return process.platform === "win32"
    ? path.replaceAll("/", "\\").toLowerCase()
    : path;
}
export async function extensionsDirectory(): Promise<string> {
  await mkdir(chiselHomeDir(), { recursive: true, mode: 0o700 });
  const home = await realpath(chiselHomeDir()),
    dir = join(home, "extensions");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink())
    throw new Error("Каталог расширений не может быть ссылкой.");
  return realpath(dir);
}
async function safeRoot(candidate: string, parent: string): Promise<string> {
  const path = resolve(candidate),
    rel = relative(canonicalPath(parent), canonicalPath(path));
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
    throw new Error(
      "Подготовленный пакет должен находиться внутри ChiselCode Home/extensions.",
    );
  let current = parent;
  for (const part of relative(parent, path).split(/[\\/]/)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Ссылки и junction в пути пакета запрещены.");
  }
  const canonical = await realpath(path);
  if (canonicalPath(canonical) !== canonicalPath(path))
    throw new Error("Путь пакета изменился.");
  return canonical;
}
async function capture(
  root: string,
  signal?: AbortSignal,
): Promise<{ files: Map<string, Buffer>; digest: string; bytes: number }> {
  const files = new Map<string, Buffer>(),
    seen = new Set<string>();
  let total = 0;
  async function walk(dir: string, prefix: string, depth: number) {
    if (depth > 32) throw new Error("Слишком глубокие пути пакета.");
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      cancelled(signal);
      const name = prefix + entry.name,
        folded = name.toLowerCase();
      if (
        name.length > 512 ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Package names cannot contain terminal/path control bytes.
        /[\\:\u0000-\u001f]/.test(entry.name) ||
        /[. ]$/.test(entry.name) ||
        seen.has(folded)
      )
        throw new Error(
          "Недопустимые или совпадающие по регистру пути пакета.",
        );
      seen.add(folded);
      if (seen.size > 2048)
        throw new Error("Слишком много каталогов и файлов пакета.");
      const path = join(dir, entry.name),
        info = await lstat(path);
      if (info.isSymbolicLink())
        throw new Error("Пакет содержит ссылку или junction.");
      if (info.isDirectory()) {
        await walk(path, name + "/", depth + 1);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1)
        throw new Error("В пакете допустимы только обычные файлы без links.");
      if (
        files.size >= EXTERNAL_LIMITS.files ||
        total + info.size > EXTERNAL_LIMITS.bytes ||
        (name === EXTENSION_MANIFEST && info.size > EXTERNAL_LIMITS.manifest)
      )
        throw new Error("Превышен размер или число файлов пакета.");
      const file = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      let bytes: Buffer;
      try {
        const opened = await file.stat();
        if (
          !opened.isFile() ||
          opened.dev !== info.dev ||
          opened.ino !== info.ino ||
          opened.size !== info.size
        )
          throw new Error("Файл пакета изменился при чтении.");
        bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          cancelled(signal);
          const read = await file.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!read.bytesRead)
            throw new Error("Файл пакета изменился при чтении.");
          offset += read.bytesRead;
        }
        const after = await file.stat();
        if (
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs ||
          (await lstat(path)).isSymbolicLink()
        )
          throw new Error("Файл пакета изменился при чтении.");
      } finally {
        await file.close();
      }
      total += bytes.length;
      files.set(name, bytes);
    }
  }
  await walk(root, "", 0);
  const hash = createHash("sha256").update("ChiselCode extension package v1\0");
  for (const name of [...files.keys()].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    const path = Buffer.from(name, "utf8"),
      bytes = files.get(name)!,
      header = Buffer.alloc(12);
    header.writeUInt32BE(path.length, 0);
    header.writeBigUInt64BE(BigInt(bytes.length), 4);
    hash.update(header).update(path).update(bytes);
  }
  return { files, digest: hash.digest("hex"), bytes: total };
}
function inspectCaptured(
  location: string,
  captured: Awaited<ReturnType<typeof capture>>,
): InspectedPackage {
  const raw = captured.files.get(EXTENSION_MANIFEST);
  if (!raw || raw.length > EXTERNAL_LIMITS.manifest)
    throw new Error(`Не найден ограниченный ${EXTENSION_MANIFEST}.`);
  const manifest = ExtensionManifestSchema.parse(
    JSON.parse(raw.toString("utf8")),
  );
  const entry = captured.files.get(manifest.entry);
  if (!entry || entry.length > EXTERNAL_LIMITS.entry)
    throw new Error("entry отсутствует или превышает 8 MiB.");
  return Object.freeze({
    location,
    manifest: Object.freeze(manifest),
    digest: captured.digest,
    files: captured.files.size,
    bytes: captured.bytes,
    incompatible: compatibility(manifest),
  });
}
export async function inspectPackage(
  path: string,
  signal?: AbortSignal,
): Promise<InspectedPackage> {
  const location = await safeRoot(path, await extensionsDirectory());
  return inspectCaptured(location, await capture(location, signal));
}
/** Recheck bytes, publish a private content-addressed snapshot, then recheck it. No import here. */
export async function runtimeSnapshot(
  candidate: InspectedPackage,
  signal?: AbortSignal,
): Promise<string> {
  const location = await safeRoot(
      candidate.location,
      await extensionsDirectory(),
    ),
    captured = await capture(location, signal);
  if (captured.digest !== candidate.digest)
    throw new Error("Содержимое изменилось после подтверждения доверия.");
  const root = join(await extensionsDirectory(), ".runtime");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Небезопасный runtime cache.");
  const destination = join(root, candidate.digest),
    temporary = join(root, `.pending-${randomUUID()}`);
  try {
    await mkdir(temporary, { mode: 0o700 });
    for (const [name, bytes] of captured.files) {
      cancelled(signal);
      const file = join(temporary, name);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { flag: "wx", mode: 0o400 });
    }
    if ((await capture(temporary, signal)).digest !== candidate.digest)
      throw new Error("Runtime snapshot не совпадает с подтверждёнными bytes.");
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY", "EPERM"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
    await safeRoot(destination, root);
    if ((await capture(destination, signal)).digest !== candidate.digest)
      throw new Error("Runtime snapshot повреждён.");
    return join(destination, candidate.manifest.entry);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
