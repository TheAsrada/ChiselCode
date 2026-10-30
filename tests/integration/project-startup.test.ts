import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("production OpenTUI starts without workspace and opens a real non-Git project without sending its draft", async () => {
  const result = Bun.spawnSync(
    [process.execPath, "tests/fixtures/project-startup.ts"],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  expect({
    code: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
  }).toMatchObject({ code: 0 });
  expect(new TextDecoder().decode(result.stdout)).toContain(
    "project-only history verified",
  );
}, 32_000);
