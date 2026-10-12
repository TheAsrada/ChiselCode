import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../../src/sessions/lock.js";

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
