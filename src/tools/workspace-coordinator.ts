import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cancelled, RuntimeError } from "../runtime/errors.js";

type AccessMode = "read" | "write";
interface Lease {
  paths: readonly string[];
  mode: AccessMode;
}
interface Waiter extends Lease {
  grant(): void;
}

/** Process-wide, fair access to overlapping workspaces and tool resources. */
export class WorkspaceCoordinator {
  private active = new Set<Lease>();
  private waiting: Waiter[] = [];
  private changes = new Map<string, number>();
  private serial = 0;

  async scope(root: string): Promise<string[]> {
    const canonical = await canonicalPath(root);
    // Subdirectories of one repository share its Git index and shell effects.
    for (let directory = canonical; ; directory = dirname(directory)) {
      try {
        await lstat(join(directory, ".git"));
        return [...new Set([canonical, directory])];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (dirname(directory) === directory) return [canonical];
    }
  }

  async resources(paths: readonly string[]): Promise<string[]> {
    return [...new Set(await Promise.all(paths.map(canonicalPath)))];
  }

  revision(paths: readonly string[]): number {
    let revision = 0;
    for (const [changed, version] of this.changes)
      if (paths.some((path) => overlaps(path, changed)))
        revision = Math.max(revision, version);
    return revision;
  }

  changed(paths: readonly string[]): void {
    const version = ++this.serial;
    for (const path of paths) this.changes.set(path, version);
  }

  async withAccess<T>(
    paths: readonly string[],
    mode: AccessMode,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(paths, mode, signal);
    try {
      cancelled(signal);
      return await work();
    } finally {
      release();
    }
  }

  acquire(
    paths: readonly string[],
    mode: AccessMode,
    signal?: AbortSignal,
  ): Promise<() => void> {
    cancelled(signal);
    return new Promise((resolveLease, reject) => {
      const lease: Lease = { paths, mode };
      const onAbort = () => {
        this.waiting = this.waiting.filter((item) => item !== waiter);
        reject(
          new RuntimeError(
            "CANCELLED",
            "Workspace operation cancelled while waiting for another tab.",
          ),
        );
        this.drain();
      };
      const waiter: Waiter = {
        ...lease,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          this.active.add(lease);
          resolveLease(() => {
            if (this.active.delete(lease)) this.drain();
          });
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    const blocked: Waiter[] = [];
    for (const waiter of this.waiting) {
      if (
        [...this.active].some((lease) => conflicts(lease, waiter)) ||
        blocked.some((earlier) => conflicts(earlier, waiter))
      )
        blocked.push(waiter);
      else waiter.grant();
    }
    this.waiting = blocked;
  }
}

function conflicts(a: Lease, b: Lease): boolean {
  return (
    (a.mode === "write" || b.mode === "write") &&
    a.paths.some((left) => b.paths.some((right) => overlaps(left, right)))
  );
}
function overlaps(a: string, b: string): boolean {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return (
      path === "" ||
      (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    );
  };
  return contains(a, b) || contains(b, a);
}
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  let candidate = absolute;
  for (;;) {
    try {
      const canonical = resolve(
        await realpath(candidate),
        relative(candidate, absolute),
      );
      return process.platform === "win32" ? canonical.toLowerCase() : canonical;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        dirname(candidate) === candidate
      )
        throw error;
      candidate = dirname(candidate);
    }
  }
}

export const workspaceCoordinator = new WorkspaceCoordinator();
