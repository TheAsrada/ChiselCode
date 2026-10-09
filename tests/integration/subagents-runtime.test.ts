import { expect, test } from "bun:test";

test("production parent delegates two coding tasks through real Git, protocol driver, executor and stores", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/subagents-runtime.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(error).not.toContain("AssertionError");
  expect(code).toBe(0);
  expect(output).toContain(
    "Subagents runtime: two production model/tool loops",
  );
}, 30000);

test("ordinary TUI delegates through production dispatch and keeps parent request running while child work and viewers complete", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-subagents.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Subagents TUI: production delegation");
}, 45000);
