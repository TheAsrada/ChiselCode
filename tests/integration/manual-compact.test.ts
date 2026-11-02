import { expect, test } from "bun:test";

test("/compact saves a model handoff from the real OpenTUI command without running tools", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/manual-compact.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("OpenTUI command verified");
}, 30000);
