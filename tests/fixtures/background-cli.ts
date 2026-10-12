import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export async function smokeBackgroundCli(command: string, prefix: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "chisel-background-cli-"));
  const root = join(directory, "Проект с  двойными пробелами");
  await mkdir(root);
  const env = {
    ...process.env,
    XDG_DATA_HOME: directory,
    XDG_CONFIG_HOME: directory,
    APPDATA: directory,
    LOCALAPPDATA: directory,
    OPENAI_API_KEY: "fixture-unused-background-key",
  };
  await mkdir(join(directory, "chiselcode"), { recursive: true });
  const config = join(directory, "chiselcode", "config.json");
  await writeFile(
    config,
    JSON.stringify({
      schemaVersion: 2,
      profiles: {},
      lsp: { mode: "off", servers: {} },
      web: { enabled: false },
    }),
  );
  const source = join(root, "batch.cjs");
  await writeFile(
    source,
    "const fs=require('node:fs');fs.appendFileSync('launches.txt','one\\n');console.log('Вывод установленной команды');setTimeout(()=>{console.error('Реальный итог');process.exitCode=7},120);",
  );
  const invoke = async (input: string, extra: string[] = []) =>
    execa(
      command,
      [
        ...prefix,
        "--cwd",
        root,
        "--json",
        "--allow",
        "run_shell",
        ...extra,
        input,
      ],
      { env, reject: false, timeout: 45000, maxBuffer: 1024 * 1024 },
    );
  const json = (output: string) =>
    JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
  try {
    const started = await invoke(
      `/tasks start ${JSON.stringify(process.execPath)} ${JSON.stringify(source)}`,
    );
    assert.notEqual(started.exitCode, 0, started.stdout);
    assert.ok(started.stdout.trim(), started.stderr);
    const accepted = json(started.stdout);
    const task = accepted.details?.backgroundTasks?.[0];
    assert.ok(task, `${started.stdout}\n${started.stderr}`);
    assert.equal(task.state, "failed");
    assert.equal(task.exitCode, 7);
    assert.equal(task.cleanup.confirmed, true);
    const sessionId = accepted.session?.id ?? task.rootOwnerId;
    assert.ok(sessionId);
    const output = await invoke(`/tasks output ${task.id}`, [
      "--resume",
      sessionId,
    ]);
    const page = json(output.stdout);
    assert.match(page.output, /Вывод установленной команды/);
    assert.match(page.output, /Реальный итог/);
    const status = await invoke(`/tasks status ${task.id}`, [
      "--resume",
      sessionId,
    ]);
    assert.equal(JSON.parse(json(status.stdout).output).id, task.id);
    assert.equal(await readFile(join(root, "launches.txt"), "utf8"), "one\n");
    const denied = await invoke(
      `/tasks start ${JSON.stringify(process.execPath)} ${JSON.stringify(source)}`,
      ["--mode", "plan"],
    );
    assert.notEqual(denied.exitCode, 0);
    assert.equal(await readFile(join(root, "launches.txt"), "utf8"), "one\n");
    console.log(
      "Background Tasks CLI: real packaged process, exit 7, retained output, history without model/replay and Plan refusal",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [command, ...prefix] = process.argv.slice(2);
  if (!command) throw new Error("Укажите ordinary CLI или compiled binary.");
  await smokeBackgroundCli(command, prefix);
}
