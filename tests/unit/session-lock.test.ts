import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageLockDiagnostics, withLock } from "../../src/sessions/lock.js";

function trace(phase: string): void {
  if (process.env.CHISEL_LOCK_TRACE === "1")
    console.info(phase, storageLockDiagnostics());
}

test("lock cancellation leaves FIFO intact and can interrupt an OS-visible wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-lock-cancel-"));
  const path = join(root, "state");
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  const first = withLock(path, async () => {
    trace("first entered");
    entered();
    await barrier;
  });
  try {
    await ready;
    trace("first ready");
    const localAbort = new AbortController();
    const local = withLock(
      path,
      async () => {
        throw new Error("Cancelled local writer entered");
      },
      localAbort.signal,
    );
    trace("local queued");
    localAbort.abort();
    trace("local abort delivered");
    expect(await local.catch((error) => error)).toMatchObject({
      code: "CANCELLED",
    });
    trace("local abort verified");
    let nextEntered = false;
    const next = withLock(path, async () => {
      nextEntered = true;
    });
    await Bun.sleep(25);
    expect(nextEntered).toBe(false);
    release();
    trace("first released");
    await first;
    await next;
    trace("next finished");
    expect(nextEntered).toBe(true);
    await mkdir(`${path}.lock`);
    await writeFile(join(`${path}.lock`, "owner"), "separate-writer");
    const diskAbort = new AbortController();
    const disk = withLock(
      path,
      async () => {
        throw new Error("Cancelled durable writer entered");
      },
      diskAbort.signal,
    );
    trace("durable queued");
    await Bun.sleep(25);
    trace("durable abort starting");
    diskAbort.abort();
    trace("durable abort delivered");
    // Bun's Windows promise matcher blocks the pending lock-poll timer. Await
    // through the normal event loop before making the same error assertion.
    expect(await disk.catch((error) => error)).toMatchObject({
      code: "CANCELLED",
    });
    trace("durable abort verified");
    expect(await readFile(join(`${path}.lock`, "owner"), "utf8")).toBe(
      "separate-writer",
    );
  } finally {
    release();
    await first;
    await rm(root, { recursive: true, force: true });
    trace("cancellation cleanup finished");
  }
});

test("concurrent local writers preserve FIFO and release only their owned durable lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-lock-fifo-"));
  const path = join(root, "state.json");
  await writeFile(path, "[]");
  let entered!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  let release!: () => void;
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  const first = withLock(path, async (assertOwned) => {
    await assertOwned();
    entered();
    await barrier;
    await writeFile(path, "[0]");
  });
  try {
    await ready;
    const writers = Array.from({ length: 16 }, (_, index) =>
      withLock(path, async (assertOwned) => {
        await assertOwned();
        const values = JSON.parse(await readFile(path, "utf8"));
        values.push(index + 1);
        await writeFile(path, JSON.stringify(values));
      }),
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([]);
    release();
    await Promise.all([first, ...writers]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(
      Array.from({ length: 17 }, (_, index) => index),
    );
    await expect(readFile(`${path}.lock/owner`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    release();
    await first;
    await rm(root, { recursive: true, force: true });
  }
});

test("a separate Bun process still waits for the OS-visible session lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-lock-process-"));
  const path = join(root, "state.txt");
  await writeFile(path, "parent");
  let entered!: () => void;
  const ready = new Promise<void>((done) => {
    entered = done;
  });
  let release!: () => void;
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  const first = withLock(path, async () => {
    entered();
    await barrier;
  });
  await ready;
  const module = new URL("../../src/sessions/lock.ts", import.meta.url).href;
  const script = `import {withLock} from ${JSON.stringify(module)}; import {writeFile} from 'node:fs/promises'; console.log('queued'); await withLock(${JSON.stringify(path)}, async check => {await check(); await writeFile(${JSON.stringify(path)}, 'child'); console.log('entered');});`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let output = "";
  try {
    while (!output.includes("queued")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Lock fixture exited before its barrier");
      output += new TextDecoder().decode(chunk.value);
    }
    expect(await readFile(path, "utf8")).toBe("parent");
    release();
    await first;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    expect(output).toContain("entered");
    expect(await readFile(path, "utf8")).toBe("child");
  } finally {
    release();
    await first;
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
