import { expect, test } from "bun:test";

for (const theme of ["obsidian", "paper"]) {
  test(`production Settings embeds tool pages in ${theme}`, async () => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/tui-settings-tools.ts"],
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
    expect(output).toContain("Settings tools:");
  }, 60000);
}
