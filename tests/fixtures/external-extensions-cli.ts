import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";

/** External bytes are authored outside checkout and copied after application compilation. */
export async function smokeExternalCli(
  command: string,
  prefix: string[],
  installedPackage = resolve(
    import.meta.dir,
    "../../dist/install-smoke/node_modules/chiselcode",
  ),
) {
  const temp = await mkdtemp(join(tmpdir(), "chisel-external-cli-")),
    project = join(temp, "Проект с пробелами"),
    author = join(temp, "Автор пакета");
  const data = join(temp, "Home"),
    home = join(
      data,
      process.platform === "win32" ? "ChiselCode" : "chiselcode",
    ),
    packageDir = join(home, "extensions", "Заметки проекта");
  const env = {
    ...process.env,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: data,
    APPDATA: data,
    LOCALAPPDATA: data,
  };
  const invoke = (args: string[]) =>
    execa(command, [...prefix, ...args], {
      env,
      reject: false,
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    });
  await mkdir(project, { recursive: true });
  await mkdir(join(author, "node_modules"), { recursive: true });
  await mkdir(packageDir, { recursive: true });
  const example = resolve(
    import.meta.dir,
    "../../examples/extensions/project-notes",
  );
  try {
    // Only the installed public entry and declarations; no neighboring checkout src.
    await mkdir(join(author, "node_modules/chiselcode/dist/extension-sdk"), {
      recursive: true,
    });
    const packageManifest = JSON.parse(
      await readFile(join(installedPackage, "package.json"), "utf8"),
    );
    await writeFile(
      join(author, "node_modules/chiselcode/package.json"),
      JSON.stringify({
        name: "chiselcode",
        type: "module",
        exports: packageManifest.exports,
      }),
    );
    for (const file of ["index.d.ts", "index.js"])
      await copyFile(
        join(installedPackage, "dist/extension-sdk", file),
        join(author, "node_modules/chiselcode/dist/extension-sdk", file),
      );
    await writeFile(
      join(author, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await copyFile(join(example, "index.ts"), join(author, "index.ts"));
    await writeFile(
      join(author, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          skipLibCheck: false,
        },
        include: ["index.ts"],
      }),
    );
    const types = await execa(
      process.execPath,
      [
        resolve(import.meta.dir, "../../node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--project",
        join(author, "tsconfig.json"),
      ],
      { cwd: author, reject: false },
    );
    assert.equal(types.exitCode, 0, types.stdout + types.stderr);
    await execa(
      process.execPath,
      [
        "build",
        join(author, "index.ts"),
        "--target",
        "bun",
        "--outfile",
        join(author, "index.mjs"),
      ],
      { cwd: author },
    );
    const source = await readFile(join(author, "index.mjs"), "utf8");
    assert.ok(!source.includes("chiselcode/extension-sdk"));
    assert.ok(!source.includes("/src/"));
    const sentinel = join(temp, "import-sentinel.txt");
    await writeFile(
      join(packageDir, "index.mjs"),
      `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(sentinel)}, 'import\\n');\n` +
        source,
    );
    await copyFile(
      join(example, "chisel-extension.json"),
      join(packageDir, "chisel-extension.json"),
    );
    await writeFile(
      join(packageDir, "asset.txt"),
      "Все assets участвуют в digest",
    );
    const config = join(data, "chiselcode/config.json");
    await mkdir(join(data, "chiselcode"), { recursive: true });
    await writeFile(
      config,
      JSON.stringify({
        schemaVersion: 2,
        profiles: {},
        lsp: { mode: "off", servers: {} },
        web: { enabled: false },
      }),
    );
    await writeFile(join(project, "note.txt"), "Исходная заметка\n");
    const inspected = await invoke([
      "extensions",
      "inspect",
      packageDir,
      "--json",
    ]);
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    const candidate = JSON.parse(inspected.stdout);
    await assert.rejects(readFile(sentinel));
    const status = await invoke(["extensions", "status", "--json"]);
    assert.equal(status.exitCode, 0, status.stderr);
    await assert.rejects(readFile(sentinel));
    const version = await invoke(["--version"]);
    assert.equal(version.exitCode, 0);
    await assert.rejects(readFile(sentinel));
    const approved = await invoke([
      "extensions",
      "approve",
      packageDir,
      "--id",
      candidate.manifest.id,
      "--digest",
      candidate.digest,
      "--enable",
      "--ack-process-access",
    ]);
    assert.equal(approved.exitCode, 0, approved.stderr);
    await assert.rejects(readFile(sentinel));
    const read = await invoke(["--cwd", project, "--json", "/notes note.txt"]);
    assert.equal(read.exitCode, 0, read.stdout + read.stderr);
    assert.match(read.stdout, /Исходная заметка/);
    assert.equal(await readFile(sentinel, "utf8"), "import\n");
    const write = await invoke([
      "--cwd",
      project,
      "--json",
      "--approval",
      "acceptEdits",
      `/notes-write ${JSON.stringify({ path: "note.txt", content: "Настоящая запись внешнего SDK\n" })}`,
    ]);
    assert.equal(write.exitCode, 0, write.stdout + write.stderr);
    assert.equal(
      await readFile(join(project, "note.txt"), "utf8"),
      "Настоящая запись внешнего SDK\n",
    );
    const plan = await invoke([
      "--cwd",
      project,
      "--json",
      "--mode",
      "plan",
      "--approval",
      "acceptEdits",
      `/notes-write ${JSON.stringify({ path: "note.txt", content: "нельзя" })}`,
    ]);
    assert.notEqual(plan.exitCode, 0, plan.stdout + plan.stderr);
    assert.equal(
      await readFile(join(project, "note.txt"), "utf8"),
      "Настоящая запись внешнего SDK\n",
    );
    const before = await readFile(sentinel, "utf8");
    await writeFile(join(packageDir, "asset.txt"), "изменён");
    const modified = await invoke([
      "--cwd",
      project,
      "--json",
      "/notes note.txt",
    ]);
    assert.notEqual(modified.exitCode, 0);
    assert.equal(await readFile(sentinel, "utf8"), before);
    const recovery = await invoke([
      "--no-external-extensions",
      "--cwd",
      project,
      "--json",
      "/tasks list",
    ]);
    assert.equal(recovery.exitCode, 0, recovery.stdout + recovery.stderr);
    assert.equal(await readFile(sentinel, "utf8"), before);
    console.log(
      "External SDK: standalone author/types, exact trust, ordinary import/read/write/Plan, modified asset refusal and recovery verified",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [command, ...prefix] = process.argv.slice(2);
  if (!command) throw Error("Укажите ordinary CLI/npm/compiled executable.");
  await smokeExternalCli(command, prefix);
}
