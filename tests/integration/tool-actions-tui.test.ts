import { expect, test } from "bun:test";

for (const theme of ["obsidian", "graphite", "ember", "paper"])
  test(`production OpenTUI tool actions in ${theme}/graphics`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/tui-tool-actions.ts"],
      {
        env: {
          ...process.env,
          CHISEL_CAPTURE_THEME: theme,
        },
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
    expect(output).toContain("Tool actions OpenTUI:");
  }, 60000);
