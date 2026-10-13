import { expect, test } from "bun:test";

test("ordinary external themes preview, persist and fall back in the real TUI", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-extension-themes.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Extension themes TUI:");
}, 90000);
