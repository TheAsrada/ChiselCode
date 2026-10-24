import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("production UI preserves editing, persists motion and searches without model requests", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-ui-design.ts"],
    {
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("no model calls from menus passed");
}, 90000);
