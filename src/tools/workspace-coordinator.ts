import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitIdentity } from "../git/driver.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";

export type AccessMode = "read" | "write";
export interface WorkspaceAccess {
  resource: string;
  mode: AccessMode;
}
interface Lease {
  accesses: readonly WorkspaceAccess[];
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
    try {
      const identity = await gitIdentity(canonical);
      return [...new Set([canonical, await canonicalPath(identity.root)])];
    } catch {
      /* Non-Git projects and not-yet-initialized repository fixtures. */
    }
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
    return [
      ...new Set(
        await Promise.all(
          paths.map((path) =>
            path.startsWith("git:")
              ? Promise.resolve(
                  process.platform === "win32" ? path.toLowerCase() : path,
                )
              : canonicalPath(path),
          ),
        ),
      ),
    ];
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
    return this.acquirePlan(
      paths.map((resource) => ({ resource, mode })),
      signal,
    );
  }
  async withPlan<T>(
    accesses: readonly WorkspaceAccess[],
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquirePlan(accesses, signal);
    try {
      cancelled(signal);
      return await work();
    } finally {
      release();
    }
  }
  acquirePlan(
    accesses: readonly WorkspaceAccess[],
    signal?: AbortSignal,
  ): Promise<() => void> {
    cancelled(signal);
    return new Promise((resolveLease, reject) => {
      const merged = new Map<string, AccessMode>();
      for (const access of accesses)
        merged.set(
          access.resource,
          merged.get(access.resource) === "write" ? "write" : access.mode,
        );
      const lease: Lease = {
        accesses: [...merged]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([resource, mode]) => ({ resource, mode })),
      };
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
  return a.accesses.some((left) =>
    b.accesses.some(
      (right) =>
        (left.mode === "write" || right.mode === "write") &&
        overlaps(left.resource, right.resource),
    ),
  );
}
function overlaps(a: string, b: string): boolean {
  if (a.startsWith("git:") || b.startsWith("git:"))
    return process.platform === "win32"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
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
