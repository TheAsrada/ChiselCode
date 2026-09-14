import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanGlob } from "../../src/utils/fs-scan.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chiselcode-scan-"));
  roots.push(root);
  await writeFile(join(root, "a.json"), "{}");
  await writeFile(join(root, "b.txt"), "hi");
  await writeFile(join(root, ".hidden.json"), "{}");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "sub", "c.json"), "{}");
  await writeFile(join(root, "sub", "d.md"), "doc");
  return root;
}

describe("scanGlob", () => {
  test("top-level pattern with absolute paths", async () => {
    const root = await makeTree();
    const files = await Array.fromAsync(
      scanGlob("*.json", { cwd: root, absolute: true }),
    );
    expect(files).toEqual([join(root, "a.json")]);
  });

  test("relative top-level entries", async () => {
    const root = await makeTree();
    const entries = await Array.fromAsync(scanGlob("*", { cwd: root }));
    expect(new Set(entries)).toEqual(new Set(["a.json", "b.txt", "sub"]));
  });

  test("recursive files only", async () => {
    const root = await makeTree();
    const files = await Array.fromAsync(
      scanGlob("**/*", { cwd: root, onlyFiles: true }),
    );
    expect(new Set(files.map((file) => file.replaceAll("\\", "/")))).toEqual(
      new Set(["a.json", "b.txt", "sub/c.json", "sub/d.md"]),
    );
  });

  test("missing directory throws ENOENT", async () => {
    const missing = join(tmpdir(), "chiselcode-scan-nope");
    await rm(missing, { recursive: true, force: true });
    await expect(
      Array.fromAsync(scanGlob("*.json", { cwd: missing })),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
