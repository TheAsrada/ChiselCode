import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("independent linked UI consumer works in ordinary production TUI with real tool effects", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/tui-ui-contributions.ts"],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit) console.error(err);
  expect(exit).toBe(0);
  expect(out).toContain("UI contributions: production slots");
}, 45000);
