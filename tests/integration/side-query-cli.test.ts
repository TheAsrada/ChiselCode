import { expect, test } from "bun:test";

test("ordinary CLI /btw uses real protocol drivers and bounded actual HTTP retries", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "tests/fixtures/side-query-cli.ts",
      process.execPath,
      "src/cli.ts",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(error).not.toContain("AssertionError");
  expect(code).toBe(0);
  expect(output).toContain("Side query CLI:");
}, 30000);
