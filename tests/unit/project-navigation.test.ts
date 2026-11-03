import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DirectoryBrowser } from "../../src/projects/navigation.js";

test("navigation completes partial paths, preserves native case rules, file parents and directory aliases", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-navigation-")),
  );
  const browser = new DirectoryBrowser(root);
  try {
    await mkdir(join(root, "Проект с пробелами"));
    await mkdir(join(root, "Other"));
    await symlink(
      join(root, "Other"),
      join(root, "Alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeFile(join(root, "file.txt"), "content");
    const page = await browser.browse('"Проек"');
    expect(page.path).toBe(root);
    expect(page.filter).toBe("Проек");
    expect(page.directories.map((path) => basename(path))).toEqual([
      "Проект с пробелами",
    ]);
    expect(
      browser.cached("Ali")?.directories.map((path) => basename(path)),
    ).toEqual(["Alias"]);
    expect(
      (await browser.browse("oth")).directories.map((path) => basename(path)),
    ).toEqual(process.platform === "win32" ? ["Other"] : []);
    expect((await browser.browse("file.txt")).filter).toBe("");
    expect((await browser.browse("Проект с пробелами")).directories).toEqual(
      [],
    );
    expect((await browser.browse("Alias")).path).toBe(
      await realpath(join(root, "Other")),
    );
    await expect(browser.browse("missing/child")).rejects.toThrow();
    await expect(browser.browse(root, AbortSignal.abort())).rejects.toThrow();
    const concurrent = await Promise.allSettled([
      browser.browse("Проек"),
      browser.browse("Other"),
    ]);
    expect(concurrent[0]?.status).toBe("rejected");
    expect(concurrent[1]?.status).toBe("fulfilled");
  } finally {
    await browser.dispose();
    await rm(root, { recursive: true, force: true });
  }
  await expect(browser.browse(root)).rejects.toThrow("отменён");
});

test("bounded cursor reaches sparse matches beyond the first batch without duplicate pages", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-navigation-pages-")),
  );
  const browser = new DirectoryBrowser(root);
  try {
    await Promise.all(
      Array.from({ length: 700 }, (_, i) =>
        mkdir(join(root, `folder-${String(i).padStart(4, "0")}`)),
      ),
    );
    await mkdir(join(root, "z-result"));
    let page = await browser.browse(join(root, "z-"));
    expect(page.more).toBe(true);
    expect(page.offset).toBeLessThanOrEqual(256);
    const found = [...page.directories];
    let batches = 1;
    while (page.more) {
      const prior = page.offset;
      page = await browser.browse(join(root, "z-"), undefined, page.offset);
      expect(page.offset).toBeGreaterThanOrEqual(prior);
      expect(page.offset - prior).toBeLessThanOrEqual(256);
      found.push(...page.directories);
      expect(++batches).toBeLessThan(6);
    }
    expect(found.map((path) => basename(path))).toEqual(["z-result"]);
    expect(browser.cached(join(root, "folder-069"))?.directories).toHaveLength(
      10,
    );
    await browser.dispose();
    // A disposed iterator cannot keep the real Windows directory locked.
    await rm(root, { recursive: true });
  } finally {
    await browser.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
