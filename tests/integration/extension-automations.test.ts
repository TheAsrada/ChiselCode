import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";

test.each(["concurrent", "crash"] as const)(
  "standard SDK and built-in automate through the executor with durable acceptance (%s)",
  async (phase) => {
    const home = await mkdtemp(join(tmpdir(), "chisel-automations-"));
    const root = join(home, "project"),
      source = join(home, "source"),
      config = join(home, "config.json");
    const env = {
      XDG_DATA_HOME: home,
      XDG_CONFIG_HOME: home,
      LOCALAPPDATA: home,
      APPDATA: home,
    };
    await Promise.all([mkdir(root), mkdir(source)]);
    await Promise.all([
      writeFile(
        config,
        JSON.stringify({
          schemaVersion: 2,
          profiles: {},
          lsp: { mode: "off", servers: {} },
          web: { enabled: false },
        }),
      ),
      writeFile(
        join(root, "count.cjs"),
        'require("node:fs").appendFileSync("effects.txt", process.argv[2] + "\\n");',
      ),
      writeFile(
        join(source, "chisel-extension.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "fixture.automation",
          version: "1.0.0",
          apiVersion: 1,
          entry: "index.mjs",
          displayName: "Автоматизация",
          requires: ["automations"],
        }),
      ),
      writeFile(
        join(source, "index.mjs"),
        `export default ({manifest}) => ({...manifest, activate(ctx) {
        ctx.automations.register({id: "external-once", schedule: {kind:"once", at:"2020-01-01T00:00:00Z"}, tool:{name:"run_shell", input:{command:"node count.cjs external"}}});
      }});`,
      ),
    ]);
    const cli = (...args: string[]) =>
      execa(process.execPath, [resolve("src/cli.ts"), "extensions", ...args], {
        env,
      });
    const worker = (mode: string) =>
      execa(
        process.execPath,
        [
          resolve("tests/fixtures/extension-automation-worker.ts"),
          root,
          config,
          mode,
        ],
        { env, timeout: 16000 },
      );
    const children: ReturnType<typeof worker>[] = [];
    try {
      const inspected = JSON.parse(
        (await cli("inspect", source, "--json")).stdout,
      );
      await cli(
        "install",
        source,
        "--digest",
        inspected.digest,
        "--ack-process-access",
        "--enable",
        "--json",
      );
      expect(await Bun.file(join(root, "effects.txt")).exists()).toBe(false);
      if (phase === "concurrent") {
        children.push(worker("run"), worker("run"));
        await Promise.all(children);
        await worker("run");
        expect((await readFile(join(root, "effects.txt"), "utf8")).trim()).toBe(
          "external",
        );
      } else {
        const child = worker("crash");
        children.push(child);
        const deadline = Date.now() + 8000;
        while (!(await Bun.file(join(root, "approval-ready")).exists())) {
          if (Date.now() > deadline)
            throw Error("Нет принятого запуска и ожидающего approval.");
          await Bun.sleep(25);
        }
        child.kill("SIGKILL");
        await child.catch(() => {});
        await worker("restart");
        expect(await Bun.file(join(root, "effects.txt")).exists()).toBe(false);
      }
    } finally {
      for (const child of children) {
        child.kill("SIGKILL");
        await child.catch(() => {});
      }
      await rm(home, { recursive: true, force: true });
    }
  },
  25000,
);
