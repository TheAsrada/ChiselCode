import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("production resume opens any project history and continues in its original runtime", () => {
  const result = Bun.spawnSync(
    [process.execPath, "tests/fixtures/session-resume.ts"],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 35000,
    },
  );
  expect({
    code: result.exitCode,
    stderr: new TextDecoder().decode(result.stderr),
  }).toMatchObject({ code: 0 });
  expect(new TextDecoder().decode(result.stdout)).toContain("original runtime");
}, 37000);
