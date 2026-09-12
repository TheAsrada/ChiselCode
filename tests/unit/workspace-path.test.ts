import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectDir } from "../../src/utils/paths.js";

describe("resolveProjectDir", () => {
  test("keeps an existing directory as the project root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-test-"));
    try {
      // realpath: tmpdir may contain symlinks (/var -> /private/var on macOS,
      // 8.3 short names on Windows), and resolveProjectDir canonicalizes them.
      expect(await resolveProjectDir(directory, tmpdir())).toBe(
        await realpath(directory),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses the file folder when given a file path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-test-"));
    const file = join(directory, "main.ts");
    try {
      await writeFile(file, "const x = 1;\n", "utf8");
      expect(await resolveProjectDir(file, tmpdir())).toBe(
        await realpath(directory),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("resolves relative paths against the current project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chiselcode-test-"));
    const nested = join(directory, "nested");
    try {
      await mkdir(nested, { recursive: true });
      expect(await resolveProjectDir("nested", directory)).toBe(
        await realpath(nested),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects missing paths with an actionable error", async () => {
    await expect(
      resolveProjectDir(join(tmpdir(), "chiselcode-no-such-dir"), tmpdir()),
    ).rejects.toThrow("Путь не найден");
    await expect(resolveProjectDir("   ", tmpdir())).rejects.toThrow("/cwd");
  });
});
