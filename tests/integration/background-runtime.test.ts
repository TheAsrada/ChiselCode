import { expect, test } from "bun:test";

test("a restored OpenTUI conversation continues with a path alias without replaying its background history", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-background-owner.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Background owner TUI:");
}, 45000);

test("a real application crash retains history and fences without replay or reconnect", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/background-crash.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Background Tasks crash:");
}, 90000);

test("ordinary executor and default contributions own real background commands across tool calls", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/background-runtime.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Background Tasks runtime:");
}, 90000);

test("ordinary OpenTUI opens Background Tasks while main is busy and owns log input", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-background.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Background Tasks TUI:");
}, 45000);

test("the native running shell card promotes one process through its real mouse action", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-background.ts"],
    {
      env: { ...process.env, CHISEL_CAPTURE_PROMOTION: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Background Tasks TUI:");
}, 45000);
