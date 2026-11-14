import { expect, test } from "bun:test";

test.each([
  ["workbench", "workbench settings"],
  ["composer", "Composer live style, native input, submit and disable"],
])(
  "agent creates %s disabled and Settings activates it in production OpenTUI",
  async (scenario, verification) => {
    const child = Bun.spawn(
      [process.execPath, "tests/fixtures/tui-extension-creator.ts", scenario],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, error).toBe(0);
    expect(output).toContain(`Extension creator OpenTUI: ${verification}`);
  },
  60000,
);
