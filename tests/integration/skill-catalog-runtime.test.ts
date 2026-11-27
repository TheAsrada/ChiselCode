import { expect, test } from "bun:test";

test("OpenTUI invokes a manual skill beyond the first hundred and gives its reference access for one request", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-skill-catalog.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, `${output}\n${error}`).toBe(0);
  expect(output).toContain("Skill catalog OpenTUI:");
}, 60000);
