import { expect, test } from "bun:test";

test("reviewed UI extension controls work in the real OpenTUI lifecycle", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-extension-widgets.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Extension widgets OpenTUI:");
}, 60000);
