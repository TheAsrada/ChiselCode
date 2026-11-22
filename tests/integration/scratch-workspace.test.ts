import { expect, test } from "bun:test";

test("scratch files and managed commands survive session reuse and recover without crossing project boundaries", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/scratch-workspace.ts"],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, `${output}\n${error}`).toBe(0);
    expect(output).toContain("Scratch Workspace: passed");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}, 90000);
