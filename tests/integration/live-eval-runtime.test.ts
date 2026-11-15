import { expect, test } from "bun:test";

test("live evaluation authorizes fixture verification without an interactive approval pause", async () => {
  const child = Bun.spawn([process.execPath, "tests/fixtures/live-eval.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  expect(output).toContain("Live eval: real shell completed");
}, 30000);
