import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createGunzip, gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";
import { extract } from "tar-stream";
import { cancelled, RuntimeError } from "../runtime/errors.js";

export const BACKEND_ARCHIVE_LIMITS = Object.freeze({
  bytes: 1024 * 1024 * 1024,
  files: 30000,
  fileBytes: 256 * 1024 * 1024,
});
export function backendArchivePath(name: string): string {
  const normalized = name
    .replace(/^\.\//, "")
    .replace(/\/$/, "")
    .split("/")
    .filter((part) => part !== ".")
    .join("/");
  if (
    !normalized ||
    normalized.includes("\\") ||
    normalized.includes(":") ||
    [...normalized].some((char) => char.charCodeAt(0) < 32) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "Unsafe language server archive path.",
      { path: name.slice(0, 160) },
    );
  return normalized;
}
/** Extract verified archives as regular files only; no links/devices or install scripts. */
export async function extractBackendArchive(
  bytes: Uint8Array,
  format: "zip" | "tar.gz" | "gz",
  destination: string,
  signal?: AbortSignal,
  allowRepeatedFiles = false,
): Promise<void> {
  let count = 0;
  let total = 0;
  const budget = (size: number) => {
    cancelled(signal);
    total += size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > BACKEND_ARCHIVE_LIMITS.fileBytes ||
      ++count > BACKEND_ARCHIVE_LIMITS.files ||
      total > BACKEND_ARCHIVE_LIMITS.bytes
    )
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "Language server archive exceeds extraction limits.",
      );
  };
  const save = async (name: string, data: Uint8Array) => {
    cancelled(signal);
    const path = join(destination, backendArchivePath(name));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(path, data, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!Buffer.from(await readFile(path)).equals(Buffer.from(data))) {
        if (!allowRepeatedFiles) throw error;
        await writeFile(path, data, { mode: 0o600 });
      }
    }
  };
  if (format === "gz") {
    const data = gunzipSync(bytes, {
      maxOutputLength: BACKEND_ARCHIVE_LIMITS.fileBytes,
    });
    budget(data.length);
    await save("server", data);
    return;
  }
  if (format === "zip") {
    const files = unzipSync(bytes, {
      filter: (file) => {
        if (["/", "./"].includes(file.name)) return false;
        backendArchivePath(file.name);
        if (file.name.endsWith("/")) return false;
        budget(file.originalSize);
        return true;
      },
    });
    for (const [name, data] of Object.entries(files)) await save(name, data);
    return;
  }
  const archive = extract();
  await new Promise<void>((resolve, reject) => {
    const source = Readable.from([bytes]);
    const decompressor = createGunzip();
    const stop = (error: unknown) => {
      source.destroy();
      decompressor.destroy();
      archive.destroy();
      reject(error);
    };
    const abort = () =>
      stop(
        new RuntimeError("CANCELLED", "Language server preparation cancelled."),
      );
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", abort);
    archive.on("entry", (header, stream, next) => {
      void (async () => {
        if (
          (header.name === "./" || header.name === ".") &&
          header.type === "directory"
        ) {
          stream.resume();
          stream.once("end", next);
          return;
        }
        backendArchivePath(header.name);
        if (header.type === "directory") {
          stream.resume();
          stream.once("end", next);
          return;
        }
        if (header.type === "symlink" || header.type === "link") {
          stream.resume();
          stream.once("end", next);
          return;
        }
        if (header.type !== "file")
          throw new RuntimeError(
            "LSP_UNAVAILABLE",
            "Unsupported language server archive entry.",
          );
        budget(header.size ?? 0);
        const parts: Buffer[] = [];
        let size = 0;
        for await (const part of stream) {
          cancelled(signal);
          size += part.length;
          if (size > (header.size ?? 0))
            throw new RuntimeError(
              "LSP_UNAVAILABLE",
              "Invalid language server archive size.",
            );
          parts.push(part);
        }
        if (size !== header.size)
          throw new RuntimeError(
            "LSP_UNAVAILABLE",
            "Truncated language server archive.",
          );
        await save(header.name, Buffer.concat(parts));
        next();
      })().catch(stop);
    });
    source.on("error", stop);
    decompressor.on("error", stop);
    archive.on("error", stop);
    archive.once("finish", () => {
      cleanup();
      resolve();
    });
    archive.once("close", cleanup);
    source.pipe(decompressor).pipe(archive);
    if (signal?.aborted) abort();
  });
}
