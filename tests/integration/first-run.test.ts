import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("first-run OpenTUI resumes a saved profile and sends the first task", async () => {
  const result = Bun.spawnSync(
    [process.execPath, "tests/fixtures/tui-first-run.ts"],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 25_000,
    },
  );
  expect({
    code: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
  }).toMatchObject({ code: 0 });
}, 27_000);
