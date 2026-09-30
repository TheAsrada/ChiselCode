import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("agent keeps queued prompts and background answers in their originating tabs", async () => {
  const result = Bun.spawnSync(
    [process.execPath, "tests/fixtures/tui-agent-navigation.ts"],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    },
  );
  expect(new TextDecoder().decode(result.stderr)).not.toContain("error:");
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain(
    "Agent navigation and queued output verified",
  );
});
