import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("providers CLI path/list/validate work offline and report invalid packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "chisel-providers-cli-"));
  try {
    const env = { ...process.env, XDG_DATA_HOME: root, LOCALAPPDATA: root };
    const run = async (...args: string[]) => {
      const p = Bun.spawn(
        [process.execPath, resolve("src/cli.ts"), "providers", ...args],
        { env, stdout: "pipe", stderr: "pipe" },
      );
      return {
        out: await new Response(p.stdout).text(),
        err: await new Response(p.stderr).text(),
        code: await p.exited,
      };
    };
    const path = (await run("path")).out.trim();
    expect(path.endsWith("providers")).toBe(true);
    expect((await run("validate")).code).toBe(0);
    await mkdir(join(path, "broken"));
    await writeFile(join(path, "broken", "provider.json"), "{bad-json");
    const list = await run("list");
    expect(list.out).toContain("agentrouter\tbuiltin\topenai-chat\tready");
    expect(list.err).toContain("manifest_invalid");
    expect((await run("validate")).code).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
