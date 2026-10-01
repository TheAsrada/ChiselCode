import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("Settings revokes active Bypass capability and downgrades queued requests in the real TUI agent", () => {
  const result = Bun.spawnSync(
    [process.execPath, "tests/fixtures/tui-bypass-revocation.ts"],
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
    "Bypass availability, live revocation and queued fallback verified",
  );
});
