import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rm,
  unlink,
  utimes,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { BackgroundTaskStore } from "../background/storage.js";
import { chiselHomeDir } from "../paths/home.js";
import {
  canonicalApplicationPath,
  pathContains,
  pathIdentity,
} from "../projects/paths.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { replaceAtomicFile } from "../utils/atomic-file.js";

export const SCRATCH_LIMITS = {
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  entries: 64,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
} as const;

const scopeName = /^[a-f0-9]{64}$/;
const stageName = /^\.chisel-write-[a-f0-9-]{36}$/;
const storage = new BackgroundTaskStore();
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

function unsafe(): never {
  throw new RuntimeError(
    "SCRATCH_UNSAFE_PATH",
    "Scratch Workspace: ожидается обычный локальный путь без ссылок или специальных файлов.",
  );
}

function limit(): never {
  throw new RuntimeError(
    "SCRATCH_LIMIT",
    "Scratch Workspace: превышен лимит файлов или размера. Удалите лишние файлы или очистите каталог.",
  );
}

export function validScratchName(name: string): boolean {
  return (
    name.length <= 80 &&
    /^[a-z0-9]/.test(name) &&
    !/[^a-z0-9._-]/.test(name) &&
    !name.endsWith(".") &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(name)
  );
}

async function inspect(path: string) {
  return lstat(path).catch((error) => {
    if (!missing(error)) throw error;
    return undefined;
  });
}

async function directory(path: string, create = false) {
  if (create) {
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }
  const info = await inspect(path);
  if (
    info &&
    (!info.isDirectory() ||
      pathIdentity(await realpath(path)) !== pathIdentity(path))
  )
    unsafe();
  return info;
}

async function rootDirectory(): Promise<string> {
  return join(await canonicalApplicationPath(chiselHomeDir()), "scratch");
}

function filePath(path: string, name: string): string {
  if (!validScratchName(name))
    throw new RuntimeError(
      "INVALID_TOOL_INPUT",
      "Некорректное имя scratch-файла.",
    );
  return join(path, name);
}

/** All filesystem operations run under the owning scratch resource lease. */
export class ScratchWorkspace {
  private constructor(readonly path: string) {}

  static async forSession(project: string, sessionId: string) {
    const projectPath = pathIdentity(await realpath(project));
    const base = await rootDirectory();
    if (pathContains(projectPath, base))
      throw new RuntimeError(
        "SCRATCH_UNSAFE_PATH",
        "Папка данных ChiselCode находится внутри проекта. Scratch Workspace требует внешнюю папку данных.",
      );
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          projectPath,
          process.platform === "win32" ? sessionId.toLowerCase() : sessionId,
        ]),
      )
      .digest("hex");
    const workspace = new ScratchWorkspace(join(base, key));
    await workspace.directory();
    return workspace;
  }

  private async directory(create = false) {
    const base = dirname(this.path);
    if (create) await mkdir(dirname(base), { recursive: true, mode: 0o700 });
    if (!(await directory(dirname(base)))) return;
    const root = await directory(base, create);
    if (!root) return;
    const uid = process.getuid?.();
    if (uid !== undefined && (root.uid !== uid || (root.mode & 0o077) !== 0))
      unsafe();
    return directory(this.path, create);
  }

  private async touch() {
    await this.directory();
    const now = new Date();
    await utimes(this.path, now, now);
  }

  private async inventory(signal?: AbortSignal) {
    const files: Array<{ name: string; bytes: number }> = [];
    const pending = [this.path];
    let count = 0;
    let bytes = 0;
    let stages = 0;
    for (const current of pending) {
      if (!(await directory(current))) unsafe();
      const entries = await opendir(current);
      for await (const entry of entries) {
        cancelled(signal);
        const path = join(current, entry.name);
        // A crash can leave an unpublished sibling of the last good version.
        if (
          current === this.path &&
          stageName.test(entry.name) &&
          !entry.isDirectory()
        ) {
          if (++stages > SCRATCH_LIMITS.entries) limit();
          await unlink(path);
          continue;
        }
        if (++count > SCRATCH_LIMITS.entries) limit();
        const info = await lstat(path);
        if (info.isDirectory()) {
          pending.push(path);
        } else {
          if (!info.isFile() || info.nlink !== 1) unsafe();
          bytes += info.size;
          if (bytes > SCRATCH_LIMITS.totalBytes) limit();
          files.push({ name: relative(this.path, path), bytes: info.size });
        }
      }
    }
    return {
      files: files.sort((a, b) => a.name.localeCompare(b.name)),
      count,
      bytes,
    };
  }

  /** The current scope obeys retention even before the global sweep reaches it. */
  private async ready(create: boolean, signal?: AbortSignal) {
    cancelled(signal);
    const info = await this.directory();
    if (info && Date.now() - info.mtimeMs >= SCRATCH_LIMITS.retentionMs)
      await this.clear(signal);
    return Boolean(await this.directory(create));
  }

  async list(signal?: AbortSignal) {
    if (!(await this.ready(false, signal))) return [];
    const { files } = await this.inventory(signal);
    await this.touch();
    return files;
  }

  async read(name: string, signal?: AbortSignal) {
    const path = filePath(this.path, name);
    if (!(await this.ready(false, signal))) return;
    const info = await inspect(path);
    if (!info) return;
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      pathIdentity(await realpath(path)) !== pathIdentity(path)
    )
      unsafe();
    if (info.size > SCRATCH_LIMITS.fileBytes) limit();
    const file = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32"
          ? 0
          : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    );
    try {
      const opened = await file.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== info.dev ||
        opened.ino !== info.ino
      )
        unsafe();
      if (opened.size > SCRATCH_LIMITS.fileBytes) limit();
      const data = Buffer.alloc(opened.size + 1);
      let bytesRead = 0;
      while (bytesRead < data.length) {
        cancelled(signal);
        const chunk = await file.read(
          data,
          bytesRead,
          data.length - bytesRead,
          bytesRead,
        );
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead !== opened.size)
        throw new RuntimeError(
          "STALE_WORKSPACE",
          "Scratch-файл изменился во время чтения.",
        );
      await this.touch();
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        data.subarray(0, bytesRead),
      );
    } finally {
      await file.close();
    }
  }

  async write(name: string, content: string, signal?: AbortSignal) {
    const target = filePath(this.path, name);
    const bytes = Buffer.byteLength(content);
    if (bytes > SCRATCH_LIMITS.fileBytes) limit();
    await this.ready(true, signal);
    const { count, files, bytes: used } = await this.inventory(signal);
    const existing = files.find((file) => file.name.toLowerCase() === name);
    if (existing && existing.name !== name)
      throw new RuntimeError(
        "SCRATCH_UNSAFE_PATH",
        "Имя scratch-файла отличается регистром от существующего.",
      );
    if (
      (!existing && count >= SCRATCH_LIMITS.entries) ||
      used - (existing?.bytes ?? 0) + bytes > SCRATCH_LIMITS.totalBytes
    )
      limit();
    const temporary = join(this.path, `.chisel-write-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(content, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await replaceAtomicFile(temporary, target, async () => {
        cancelled(signal);
        if (!(await this.directory())) unsafe();
        const current = await inspect(target);
        if (current && (!current.isFile() || current.nlink !== 1)) unsafe();
      });
    } finally {
      if (await this.directory()) await rm(temporary, { force: true });
    }
    return bytes;
  }

  async remove(name: string, signal?: AbortSignal) {
    const path = filePath(this.path, name);
    if (!(await this.ready(false, signal))) return false;
    const info = await inspect(path);
    if (!info) return false;
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      pathIdentity(await realpath(path)) !== pathIdentity(path)
    )
      unsafe();
    cancelled(signal);
    await unlink(path);
    return true;
  }

  async clear(signal?: AbortSignal) {
    cancelled(signal);
    if (!(await this.directory())) return;
    await rm(this.path, { recursive: true, force: true, maxRetries: 2 });
  }

  async prepareShell(signal?: AbortSignal) {
    await this.ready(true, signal);
    await this.inventory(signal);
    await this.touch();
  }

  /** Standalone callers and maintenance share the application execution registry. */
  async withLease<T>(
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ) {
    const lease = await storage.acquireExecution(
      randomUUID(),
      [{ resource: pathIdentity(this.path), mode: "write" }],
      signal,
    );
    try {
      cancelled(signal);
      return await action();
    } finally {
      await lease.release();
    }
  }

  static async removeSession(project: string, sessionId: string) {
    const workspace = await ScratchWorkspace.forSession(project, sessionId);
    if (!(await workspace.directory())) return;
    const signal = AbortSignal.timeout(500);
    await workspace.withLease(signal, () => workspace.clear(signal));
  }

  static async sweep() {
    const base = await rootDirectory();
    if (!(await directory(dirname(base))) || !(await directory(base))) return;
    const entries = await opendir(base);
    for await (const entry of entries) {
      if (!entry.isDirectory() || !scopeName.test(entry.name)) continue;
      const workspace = new ScratchWorkspace(join(base, entry.name));
      try {
        const old = async () => {
          const info = await workspace.directory();
          return (
            info && Date.now() - info.mtimeMs >= SCRATCH_LIMITS.retentionMs
          );
        };
        if (await old())
          await workspace.withLease(AbortSignal.timeout(500), async () => {
            if (await old()) await workspace.clear();
          });
      } catch {
        // Busy or damaged scopes are left alone. A later sweep can retry them.
      }
    }
  }
}

let nextSweep = 0;
export function scheduleScratchSweep() {
  if (Date.now() < nextSweep) return;
  nextSweep = Date.now() + 60 * 60 * 1000;
  void ScratchWorkspace.sweep().catch(() => {});
}
