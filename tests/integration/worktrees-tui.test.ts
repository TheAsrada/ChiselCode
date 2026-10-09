import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("ordinary production TUI creates/opens two isolated worktrees and applies with real tools/LSP/approvals", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-worktrees.ts"],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Worktree TUI: real detached");
}, 90_000);
