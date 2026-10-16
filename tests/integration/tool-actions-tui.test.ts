import { expect, test } from "bun:test";

for (const theme of ["obsidian", "graphite", "ember", "paper"])
  for (const unicode of ["0", "1"]) {
    test(`production OpenTUI tool actions in ${theme}/${unicode}`, async () => {
      const child = Bun.spawn(
        [process.execPath, "tests/fixtures/tui-tool-actions.ts"],
        {
          env: {
            ...process.env,
            CHISEL_CAPTURE_THEME: theme,
            CHISEL_CAPTURE_UNICODE: unicode,
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
  }
