import { expect, test } from "bun:test";

test("production failure reason survives storage and native history replay without secrets or another model request", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/conversation-diagnostics.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain(
    "redacted durable reason, native restored error and LSP workspace guard verified",
  );
}, 30000);
