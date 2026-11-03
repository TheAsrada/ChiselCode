import type { Dir } from "node:fs";
import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { cancelled } from "../runtime/errors.js";

export interface DirectoryPage {
  path: string;
  parent: string;
  directories: string[];
  more: boolean;
  offset: number;
  filter: string;
}
export async function navigationDirectory(): Promise<string> {
  return realpath(homedir());
}
const pathKey = (path: string) =>
  process.platform === "win32" ? path.toLowerCase() : path;
const matches = (path: string, prefix: string) =>
  pathKey(basename(path)).startsWith(pathKey(prefix));
const sorted = (paths: string[]) =>
  paths.sort((a, b) =>
    basename(a).localeCompare(basename(b), "ru", { numeric: true }),
  );
const inputPath = (input: string, base: string) =>
  resolve(base, input.trim().replace(/^["']([\s\S]*)["']$/, "$1"));

interface Source {
  path: string;
  filter: string;
  directory: Dir;
  offset: number;
  names: string[];
  cacheable: boolean;
}

/** One popup owns the cursor and a bounded, short-lived cache. Names only, no project activation. */
export class DirectoryBrowser {
  private source?: Source;
  private revision = 0;
  private disposed = false;
  private cache = new Map<
    string,
    { path: string; names: string[]; expires: number }
  >();
  constructor(private base: string) {}

  cached(input: string): DirectoryPage | undefined {
    const requested = inputPath(input, this.base);
    let entry = this.cache.get(pathKey(requested));
    let filter = "";
    if (!entry) {
      entry = this.cache.get(pathKey(dirname(requested)));
      filter = basename(requested);
      // A known directory needs its own contents, not sibling completions.
      if (entry?.names.some((name) => pathKey(name) === pathKey(requested)))
        return;
    }
    if (!entry || entry.expires <= Date.now() || this.disposed) return;
    return {
      path: entry.path,
      parent: dirname(entry.path),
      directories: sorted(entry.names.filter((name) => matches(name, filter))),
      more: false,
      offset: 0,
      filter,
    };
  }

  async browse(
    input: string,
    signal?: AbortSignal,
    offset = 0,
  ): Promise<DirectoryPage> {
    const revision = ++this.revision;
    const check = () => {
      cancelled(signal);
      if (this.disposed || revision !== this.revision)
        throw new Error("Просмотр папки отменён.");
    };
    check();
    const requested = inputPath(input, this.base);
    let path = requested,
      filter = "";
    try {
      if ((await stat(path)).isFile()) path = dirname(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      path = dirname(requested);
      filter = basename(requested);
    }
    check();
    path = await realpath(path);
    check();
    const cached = this.cache.get(pathKey(path));
    if (offset === 0 && cached && cached.expires > Date.now()) {
      await this.closeSource();
      check();
      return {
        path,
        parent: dirname(path),
        directories: sorted(
          cached.names.filter((name) => matches(name, filter)),
        ),
        more: false,
        offset: 0,
        filter,
      };
    }
    if (
      !this.source ||
      this.source.path !== path ||
      this.source.filter !== filter ||
      this.source.offset !== offset
    ) {
      await this.closeSource();
      check();
      const directory = await opendir(path);
      try {
        check();
      } catch (error) {
        await directory.close().catch(() => {});
        throw error;
      }
      this.source = {
        path,
        filter,
        directory,
        offset: 0,
        names: [],
        cacheable: true,
      };
    }
    const source = this.source;
    const abort = () => {
      if (this.source === source) this.source = undefined;
      void source.directory.close().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    const directories: string[] = [];
    let more = true;
    try {
      // Bound each I/O batch. Continue the same cursor without rescanning.
      for (let scanned = 0; scanned < 256; scanned++) {
        check();
        const entry = await source.directory.read();
        check();
        if (!entry) {
          more = false;
          break;
        }
        source.offset++;
        const candidate = join(path, entry.name);
        const directory =
          entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            (await stat(candidate).catch(() => undefined))?.isDirectory());
        check();
        if (!directory) continue;
        if (source.cacheable) {
          source.names.push(candidate);
          if (source.names.length > 2048) {
            source.names = [];
            source.cacheable = false;
          }
        }
        if (matches(candidate, filter)) directories.push(candidate);
      }
      if (!more) {
        if (source.cacheable) {
          this.cache.delete(pathKey(path));
          this.cache.set(pathKey(path), {
            path,
            names: source.names,
            expires: Date.now() + 5000,
          });
          const oldest = this.cache.keys().next().value;
          if (this.cache.size > 8 && oldest !== undefined)
            this.cache.delete(oldest);
        }
        if (this.source === source) this.source = undefined;
        await source.directory.close().catch(() => {});
      }
      check();
      return {
        path,
        parent: dirname(path),
        directories: sorted(directories),
        more,
        offset: source.offset,
        filter,
      };
    } catch (error) {
      if (this.source === source) this.source = undefined;
      await source.directory.close().catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private async closeSource() {
    const source = this.source;
    this.source = undefined;
    if (source) await source.directory.close().catch(() => {});
  }
  async dispose() {
    this.disposed = true;
    this.revision++;
    this.cache.clear();
    await this.closeSource();
  }
}
