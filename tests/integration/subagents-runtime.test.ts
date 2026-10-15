import { expect, test } from "bun:test";

test("native Subagent Settings migrate old config, keep the draft and expose no token quotas", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-subagent-settings.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain(
    "no token fields, compact layout and draft preserved",
  );
}, 45000);

test("production child accepts large contexts, compacts with a model and keeps complete result artifacts without token quotas", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/subagents-context.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("generations above 16000 tokens");
  expect(output).toContain("full artifact verified");
}, 45000);

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
  expect(code, error).toBe(0);
  expect(error).not.toContain("AssertionError");
  expect(output).toContain(
    "Subagents runtime: two production model/tool loops",
  );
}, 45000);

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
