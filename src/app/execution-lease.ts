import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { canonicalWorkspaceRoot } from "../extensions/host.js";
import { gitIdentity } from "../git/driver.js";
import { chiselHomeDir } from "../paths/home.js";
import { RuntimeError } from "../runtime/errors.js";

interface Entry {
  users: number;
  pending: Promise<() => Promise<void>>;
  closing?: Promise<void>;
}
const leases = new Map<string, Entry>();
/** Retain admission while owned work runs; observing busy must never invoke shutdown/drain. */
export async function releaseAfterOwnedTasks(
  release: () => Promise<void>,
  controls: readonly ({ busy(): boolean } | undefined)[],
): Promise<void> {
  while (controls.some((control) => control?.busy()))
    await new Promise<void>((done) => {
      const timer = setTimeout(done, 250);
      timer.unref();
    });
  await release();
}
/** Coarse cross-process admission; existing in-process coordinator keeps tab concurrency. */
export async function acquireExecutionLease(
  root: string,
): Promise<() => Promise<void>> {
  const canonical = await canonicalWorkspaceRoot(root);
  const resource = await gitIdentity(canonical).then(
    (git) => git.commonDir,
    () => canonical,
  );
  let entry = leases.get(resource);
  if (entry?.closing) {
    await entry.closing;
    return acquireExecutionLease(root);
  }
  if (!entry) {
    entry = { users: 0, pending: claim(resource) };
    leases.set(resource, entry);
  }
  entry.users++;
  let release: () => Promise<void>;
  try {
    release = await entry.pending;
  } catch (error) {
    entry.users--;
    if (!entry.users) leases.delete(resource);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (--entry.users === 0) {
      entry.closing = release();
      try {
        await entry.closing;
      } finally {
        if (leases.get(resource) === entry) leases.delete(resource);
      }
    }
  };
}
async function claim(resource: string): Promise<() => Promise<void>> {
  const directory = join(chiselHomeDir(), "execution-locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(
    directory,
    `${createHash("sha256").update(resource).digest("hex")}.lock`,
  );
  const token = randomUUID();
  const busy = () =>
    new RuntimeError(
      "WORKSPACE_BUSY",
      "Проект выполняет задачу в другом процессе ChiselCode. Дождитесь завершения или используйте отдельный клон репозитория.",
    );
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt) throw busy();
      // Reclamation is serialized and verifies the old identity again inside the guard.
      const guard = `${lock}.cleanup`;
      try {
        await mkdir(guard);
      } catch {
        throw busy();
      }
      try {
        let dead = false;
        try {
          const owner = JSON.parse(
            await readFile(join(lock, "owner.json"), "utf8"),
          ) as { pid: number; host: string };
          if (
            owner.host !== hostname() ||
            !Number.isSafeInteger(owner.pid) ||
            owner.pid <= 0
          )
            throw busy();
          try {
            process.kill(owner.pid, 0);
          } catch (cause) {
            dead = (cause as NodeJS.ErrnoException).code === "ESRCH";
          }
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT")
            dead = Date.now() - (await stat(lock)).mtimeMs > 30_000;
          else throw cause;
        }
        if (!dead) throw busy();
        const retired = `${lock}.${token}.retired`;
        await rename(lock, retired);
        await rm(retired, { recursive: true });
      } finally {
        await rm(guard, { recursive: true, force: true });
      }
      continue;
    }
    try {
      await writeFile(
        join(lock, "owner.json"),
        JSON.stringify({ pid: process.pid, host: hostname(), token }),
        { mode: 0o600 },
      );
    } catch (error) {
      await rm(lock, { recursive: true, force: true });
      throw error;
    }
    return async () => {
      const owner = JSON.parse(
        await readFile(join(lock, "owner.json"), "utf8"),
      ) as { token: string };
      if (owner.token !== token) throw busy();
      await rm(lock, { recursive: true });
    };
  }
  throw busy();
}
