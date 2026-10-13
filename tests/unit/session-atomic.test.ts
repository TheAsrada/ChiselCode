import { expect, test } from "bun:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceSessionFile } from "../../src/sessions/atomic.js";

test("sharing failure retries the same real atomic replacement while the old file remains readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-atomic-"));
  const target = join(root, "index.json"),
    source = join(root, "index.tmp");
  try {
    await writeFile(target, "old checkpoint");
    await writeFile(source, "new checkpoint");
    let checks = 0,
      attempts = 0;
    await replaceSessionFile(
      source,
      target,
      async () => {
        checks++;
      },
      async (from, to) => {
        attempts++;
        expect(from).toBe(source);
        expect(to).toBe(target);
        expect(await readFile(target, "utf8")).toBe("old checkpoint");
        if (attempts < 3)
          throw Object.assign(new Error("sharing violation"), {
            code: "EPERM",
          });
        await rename(from, to);
      },
      "win32",
    );
    expect(attempts).toBe(3);
    expect(checks).toBe(3);
    expect(await readFile(target, "utf8")).toBe("new checkpoint");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lost lease during sharing retry cannot replace the original checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-atomic-owner-"));
  const target = join(root, "index.json"),
    source = join(root, "index.tmp");
  try {
    await writeFile(target, "original");
    await writeFile(source, "stale writer");
    let checks = 0,
      attempts = 0;
    await expect(
      replaceSessionFile(
        source,
        target,
        async () => {
          if (++checks === 2) throw new Error("lease lost");
        },
        async () => {
          attempts++;
          throw Object.assign(new Error("sharing violation"), {
            code: "EACCES",
          });
        },
        "win32",
      ),
    ).rejects.toThrow("lease lost");
    expect(attempts).toBe(1);
    expect(await readFile(target, "utf8")).toBe("original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permanent sharing errors are bounded; non-Windows permission errors fail immediately", async () => {
  const error = Object.assign(new Error("permission denied"), {
    code: "EPERM",
  });
  let attempts = 0;
  const fail = async () => {
    attempts++;
    throw error;
  };
  await expect(
    replaceSessionFile("unused", "unused", async () => {}, fail, "linux"),
  ).rejects.toBe(error);
  expect(attempts).toBe(1);
  const started = Date.now();
  await expect(
    replaceSessionFile("unused", "unused", async () => {}, fail, "win32"),
  ).rejects.toBe(error);
  expect(Date.now() - started).toBeLessThan(10000);
  expect(attempts).toBeLessThanOrEqual(42);
});
