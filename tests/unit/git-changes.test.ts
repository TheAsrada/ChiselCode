import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGitNumstat,
  parseGitStatus,
  readGitWorkingState,
} from "../../src/ui/git-changes.js";

test("porcelain and numstat retain spaces, Unicode and rename destinations", () => {
  expect(
    parseGitStatus(
      " M кириллица name.ts\0R  new name.ts\0old name.ts\0?? new.ts\0",
    ),
  ).toEqual([
    { path: "кириллица name.ts", status: " M" },
    { path: "new name.ts", status: "R " },
    { path: "new.ts", status: "??" },
  ]);
  expect(
    parseGitNumstat("2\t1\tкириллица name.ts\0").get("кириллица name.ts"),
  ).toEqual({ additions: 2, deletions: 1 });
  expect(
    parseGitNumstat("1\t1\t\0old name.ts\0new name.ts\0").get("new name.ts"),
  ).toEqual({ additions: 1, deletions: 1 });
});

test("working Git state updates after undo and includes untracked line counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-git-context-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Test");
    await writeFile(join(root, "tracked.txt"), "before\n");
    git("add", ".");
    git("commit", "-qm", "initial");
    await writeFile(join(root, "tracked.txt"), "after\nsecond\n");
    await writeFile(join(root, "новый файл.txt"), "one\ntwo");
    const state = await readGitWorkingState(root);
    expect(state?.totalFiles).toBe(2);
    expect(
      state?.files.find((file) => file.path === "tracked.txt"),
    ).toMatchObject({ additions: 2, deletions: 1 });
    expect(
      state?.files.find((file) => file.path === "новый файл.txt"),
    ).toMatchObject({ additions: 2, deletions: 0 });
    await writeFile(join(root, "tracked.txt"), "before\n");
    await rm(join(root, "новый файл.txt"));
    expect((await readGitWorkingState(root))?.files).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
