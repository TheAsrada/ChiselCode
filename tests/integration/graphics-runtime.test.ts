import { expect, test } from "bun:test";

for (const theme of ["obsidian", "paper"]) {
  test(`production OpenTUI uses graphics with legacy false in ${theme}`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/tui-graphics.ts"],
      {
        env: { ...process.env, CHISEL_CAPTURE_THEME: theme },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, error).toBe(0);
    expect(output).toContain("Graphical OpenTUI:");
  }, 30000);
}
