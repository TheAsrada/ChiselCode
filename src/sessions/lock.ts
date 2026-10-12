import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const STALE_MS = 30_000;
// Wait long enough for a newly abandoned lock to expire in the same request.
const WAIT_MS = 35_000;
const HEARTBEAT_MS = 5_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

async function stale(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > STALE_MS;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

// Only one process may move a stale lock aside or release its own lock at once.
// The guard is also recoverable if that process crashes during cleanup.
async function withCleanupGuard(
  lock: string,
  action: () => Promise<void>,
): Promise<boolean> {
  const guard = `${lock}.cleanup`;
  try {
    await mkdir(guard);
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
    if (await stale(guard)) {
      await rm(guard, { recursive: true, force: true });
    }
    return false;
  }
  try {
    await action();
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
  return true;
}

async function removeStaleLock(lock: string): Promise<void> {
  if (!(await stale(lock))) return;
  await withCleanupGuard(lock, async () => {
    if (!(await stale(lock))) return;
    const retired = `${lock}.${randomUUID()}.stale`;
    try {
      await rename(lock, retired);
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    await rm(retired, { recursive: true, force: true });
  });
}

const localQueues = new Map<string, Promise<void>>();

/** Same-process writers use FIFO before contending for the durable OS-visible lock. */
export async function withLock<T>(
  path: string,
  action: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const canonical = resolve(path);
  const key =
    process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const previous = localQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  const queue = previous.then(() => current);
  localQueues.set(key, queue);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Хранилище занято: ${path}`)),
          WAIT_MS,
        );
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return await withFileLock(path, action);
  } finally {
    if (timeout) clearTimeout(timeout);
    release();
    // A timed-out waiter must keep its predecessor in the queue until it leaves.
    void queue.then(() => {
      if (localQueues.get(key) === queue) localQueues.delete(key);
    });
  }
}

async function withFileLock<T>(
  path: string,
  action: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lock = `${path}.lock`;
  const token = randomUUID();
  const owner = join(lock, "owner");
  const deadline = Date.now() + WAIT_MS;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      await removeStaleLock(lock);
      if (Date.now() >= deadline) throw new Error(`Хранилище занято: ${path}`);
      await pause(30 + Math.random() * 20);
    }
  }

  try {
    await writeFile(owner, token, { flag: "wx" });
  } catch (error) {
    await rm(lock, { recursive: true, force: true });
    throw error;
  }
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      // The directory timestamp is the lease. A resumed former owner must not
      // renew a lock that was already reclaimed by another process.
      if ((await readFile(owner, "utf8").catch(() => "")) !== token) return;
      const now = new Date();
      await utimes(lock, now, now).catch(() => {});
    });
  }, HEARTBEAT_MS);
  timer.unref();
  const releaseOwned = async () => {
    clearInterval(timer);
    await heartbeat;
    const releaseDeadline = Date.now() + WAIT_MS;
    while (
      !(await withCleanupGuard(lock, async () => {
        if ((await readFile(owner, "utf8").catch(() => "")) !== token) return;
        const retired = `${lock}.${token}.released`;
        await rename(lock, retired);
        await rm(retired, { recursive: true, force: true });
      }))
    ) {
      if (Date.now() >= releaseDeadline)
        throw new Error(`Не удалось освободить lock хранилища: ${path}`);
      await pause(30);
    }
  };
  try {
    return await action(async () => {
      if ((await readFile(owner, "utf8").catch(() => "")) !== token)
        throw new Error(
          "Storage lease ownership changed; retry with a fresh operation.",
        );
    });
  } finally {
    await releaseOwned();
  }
}
