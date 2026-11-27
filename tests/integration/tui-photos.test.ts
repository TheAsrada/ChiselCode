import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("OpenTUI attaches photos, submits bytes, restores drafts and history, and retains rejected input", async () => {
  const child = Bun.spawn([process.execPath, "tests/fixtures/tui-photos.ts"], {
    cwd: resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(error);
  expect(output).toContain(
    "Ввод, отправка и восстановление фото проверены в OpenTUI",
  );
}, 30_000);
