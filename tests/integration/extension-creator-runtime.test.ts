import { expect, test } from "bun:test";

test("agent creates a disabled package and Settings activates it in the production OpenTUI without restarting core", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-extension-creator.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Extension creator OpenTUI:");
}, 60000);
