import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("production worktree manager completes its real Git and permission lifecycle", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-worktree-manager.ts"],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Worktree manager: actual OpenTUI/approvals");
}, 90000);
