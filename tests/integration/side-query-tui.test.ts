import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("builtin /btw answers alongside foreground through actual TUI, drivers and persistence", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-side-query.ts"],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(error).not.toContain("AssertionError");
  expect(code).toBe(0);
  expect(output).toContain("Side query: real TUI");
}, 25000);
