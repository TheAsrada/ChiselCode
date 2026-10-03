import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("agent runs tabs concurrently with sequential follow-ups and independent cancellation", async () => {
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
    "Parallel tabs, sequential follow-ups and independent cancellation verified",
  );
});
