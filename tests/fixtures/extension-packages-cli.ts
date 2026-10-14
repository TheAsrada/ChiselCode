import assert from "node:assert/strict";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { zipSync } from "fflate";

/** Real outside author + production package CLI. No injected definition or runtime test flag. */
export async function smokeExtensionPackages(
  command: string,
  prefix: string[],
  installedPackage = resolve("dist/install-smoke/node_modules/chiselcode"),
) {
  const temp = await mkdtemp(join(tmpdir(), "chisel-managed-cli-")),
    author = join(temp, "Автор расширения"),
    project = join(temp, "Проект с пробелами"),
    data = join(temp, "Home");
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          ![
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "APPDATA",
            "LOCALAPPDATA",
          ].includes(key.toUpperCase()),
      ),
    ),
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: data,
    APPDATA: data,
    LOCALAPPDATA: data,
  };
  const invoke = (args: string[]) =>
    execa(command, [...prefix, ...args], {
      env,
      extendEnv: false,
      reject: false,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
  const ok = async (args: string[]) => {
    const result = await invoke(args);
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    return result;
  };
  const id = "fixture.managed",
    sentinel = join(temp, "import.txt"),
    prepared = join(author, "package");
  try {
    await mkdir(join(author, "node_modules/chiselcode/dist/extension-sdk"), {
      recursive: true,
    });
    await mkdir(project);
    await mkdir(data);
    const publicManifest = JSON.parse(
      await readFile(join(installedPackage, "package.json"), "utf8"),
    );
    await writeFile(
      join(author, "node_modules/chiselcode/package.json"),
      JSON.stringify({
        name: "chiselcode",
        type: "module",
        exports: publicManifest.exports,
      }),
    );
    await cp(
      join(installedPackage, "dist/extension-sdk"),
      join(author, "node_modules/chiselcode/dist/extension-sdk"),
      { recursive: true },
    );
    await writeFile(
      join(author, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await copyFile(
      resolve("examples/extensions/project-notes/index.ts"),
      join(author, "index.ts"),
    );
    await copyFile(
      resolve("tests/fixtures/extensions/themes/index.ts"),
      join(author, "themes.ts"),
    );
    const source = await readFile(join(author, "index.ts"), "utf8");
    await writeFile(
      join(author, "index.ts"),
      `import themeFactory from './themes.js';\n` +
        source.replace(
          "export default factory;",
          "export default ((input: Parameters<ExtensionFactory>[0]) => {const definition = factory(input); const themes = themeFactory(input); if(definition instanceof Promise || themes instanceof Promise) throw Error('Unexpected async example'); return {...definition, themes: themes.themes};}) satisfies ExtensionFactory;",
        ),
    );
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
        include: ["index.ts", "themes.ts"],
      }),
    );
    const typed = await execa(
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--project",
        join(author, "tsconfig.json"),
      ],
      { cwd: author, reject: false },
    );
    assert.equal(typed.exitCode, 0, typed.stdout + typed.stderr);
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
    const entry = await readFile(join(author, "index.mjs"), "utf8");
    assert.ok(!entry.includes("chiselcode/extension-sdk"));
    assert.ok(!entry.includes("/src/"));
    const entries = (version: string) => ({
      "chisel-extension.json": Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          id,
          version,
          apiVersion: 1,
          entry: "index.mjs",
          displayName: "Самостоятельные заметки и темы",
        }),
      ),
      "index.mjs": Buffer.from(
        `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(sentinel)},${JSON.stringify(version + "\n")});\n` +
          entry,
      ),
      "asset.txt": Buffer.from(`Версия ${version}`),
    });
    await mkdir(prepared);
    for (const [name, bytes] of Object.entries(entries("1.0.0")))
      await writeFile(join(prepared, name), bytes);
    await writeFile(
      join(data, "config.json"),
      JSON.stringify({
        schemaVersion: 2,
        profiles: {},
        lsp: { mode: "off", servers: {} },
        web: { enabled: false },
      }),
    );
    await writeFile(join(project, "note.txt"), "Настоящий файл managed SDK\n");
    // Ordinary project config disables network/LSP without affecting management user scope.
    await writeFile(
      join(project, ".chiselrc"),
      JSON.stringify({ lsp: { mode: "off" }, web: { enabled: false } }),
    );
    const inspected = JSON.parse(
      (await ok(["extensions", "inspect", prepared, "--json"])).stdout,
    );
    const installed = JSON.parse(
      (await ok(["extensions", "install", prepared, "--json"])).stdout,
    );
    assert.equal(installed.digest, inspected.digest);
    assert.equal(installed.trusted, false);
    assert.equal(installed.enabled, false);
    await assert.rejects(readFile(sentinel));
    await rm(prepared, { recursive: true });
    await ok(["extensions", "status", "--json"]);
    await assert.rejects(readFile(sentinel));
    const deniedEnable = await invoke(["extensions", "enable", id, "--json"]);
    assert.notEqual(deniedEnable.exitCode, 0);
    assert.equal(JSON.parse(deniedEnable.stdout).committed, false);
    await ok([
      "extensions",
      "approve",
      installed.location,
      "--id",
      id,
      "--digest",
      installed.digest,
      "--enable",
      "--ack-process-access",
    ]);
    const read = await ok(["--cwd", project, "--json", "/notes note.txt"]);
    assert.match(read.stdout, /Настоящий файл managed SDK/);
    assert.equal(await readFile(sentinel, "utf8"), "1.0.0\n");
    const zip = join(temp, "Обновление.zip");
    await writeFile(zip, zipSync(entries("2.0.0"), { level: 6 }));
    const v2 = JSON.parse(
      (await ok(["extensions", "inspect", zip, "--json"])).stdout,
    );
    const denied = await invoke(["extensions", "update", id, zip, "--json"]);
    assert.notEqual(denied.exitCode, 0);
    assert.equal(JSON.parse(denied.stdout).committed, false);
    let status = JSON.parse(
      (await ok(["extensions", "status", "--json"])).stdout,
    );
    assert.equal(status.packages[0].selected.digest, installed.digest);
    assert.equal(await readFile(sentinel, "utf8"), "1.0.0\n");
    const updated = JSON.parse(
      (
        await ok([
          "extensions",
          "update",
          id,
          zip,
          "--digest",
          v2.digest,
          "--ack-process-access",
          "--json",
        ])
      ).stdout,
    );
    assert.equal(updated.enabled, true);
    assert.equal(updated.digest, v2.digest);
    await rm(zip);
    assert.equal(await readFile(sentinel, "utf8"), "1.0.0\n");
    await ok(["--cwd", project, "--json", "/notes note.txt"]);
    assert.equal(await readFile(sentinel, "utf8"), "1.0.0\n2.0.0\n");
    const versions = JSON.parse(
      (await ok(["extensions", "versions", id, "--json"])).stdout,
    );
    assert.equal(versions.versions.length, 2);
    await ok(["extensions", "rollback", id, installed.digest, "--json"]);
    await ok(["--cwd", project, "--json", "/notes note.txt"]);
    assert.equal(await readFile(sentinel, "utf8"), "1.0.0\n2.0.0\n1.0.0\n");
    await ok(["extensions", "disable", id, "--json"]);
    await ok(["--cwd", project, "--json", "/tasks list"]);
    assert.equal(await readFile(sentinel, "utf8"), "1.0.0\n2.0.0\n1.0.0\n");
    await ok(["extensions", "enable", id, "--json"]);
    const removed = JSON.parse(
      (await ok(["extensions", "remove", id, "--json"])).stdout,
    );
    assert.equal(removed.outcome, "committed");
    assert.equal(removed.deferred, false);
    await assert.rejects(readFile(join(installed.location, "index.mjs")));
    await assert.rejects(readFile(join(updated.location, "index.mjs")));
    await ok(["extensions", "recover", "--json"]);
    status = JSON.parse((await ok(["extensions", "status", "--json"])).stdout);
    assert.equal(status.packages[0].removed, true);
    assert.equal(
      await readFile(join(project, "note.txt"), "utf8"),
      "Настоящий файл managed SDK\n",
    );
    console.log(
      "Extension packages CLI: standalone packed SDK, folder/ZIP install, no untrusted import, exact update/rollback/disable/remove and actual next-startup tools verified",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const [command, ...prefix] = process.argv.slice(2);
  if (!command) throw Error("Укажите ordinary CLI/npm/compiled executable.");
  await smokeExtensionPackages(command, prefix);
}
