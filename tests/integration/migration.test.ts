import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("first-run migration imports three sources, reports skips and preserves local changes on retry", () => {
  const result = Bun.spawnSync(
    [process.execPath, "tests/fixtures/tui-migration.ts"],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  expect({
    code: result.exitCode,
    stderr: result.stderr.toString("utf8"),
  }).toMatchObject({ code: 0 });
}, 32_000);
