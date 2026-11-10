import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("terminal Ctrl+C cancels real provider streams, clears follow-ups and permits another turn", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-interrupt.ts"],
    {
      cwd: resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15000,
    },
  );
  try {
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(error).not.toContain("AssertionError");
    expect(code, error).toBe(0);
    expect(output).toContain("Terminal interrupt verified");
  } finally {
    child.kill();
    await child.exited;
  }
}, 20000);
