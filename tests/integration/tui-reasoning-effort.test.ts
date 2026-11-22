import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("OpenTUI snapshots reasoning effort across tool rounds, queued messages and profiles", () => {
  const result = Bun.spawnSync(
    [process.execPath, "tests/fixtures/tui-reasoning-effort.ts"],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    },
  );
  expect(result.stderr.toString()).not.toContain("error:");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("session storage verified");
}, 22_000);
