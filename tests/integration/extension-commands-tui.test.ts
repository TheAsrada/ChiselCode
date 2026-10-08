import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("linked commands run through the real TUI dispatch and core tools without model credentials", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-command-contributions.ts"],
    {
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(err).not.toContain("AssertionError");
  expect(exit).toBe(0);
  expect(out).toContain(
    "Command contributions: TUI dispatch, tools, queue, cancellation, checkpoints and artifacts verified",
  );
}, 25000);
