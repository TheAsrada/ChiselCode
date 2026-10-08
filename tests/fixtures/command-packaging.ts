import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";

// Test-only linked composition: ordinary package/release builds never contain this fixture.
const root = resolve(import.meta.dir, "../..");
const staging = await mkdtemp(join(tmpdir(), "chisel-command-package-"));
const packageRoot = join(staging, "package");
const installed = join(staging, "installed");
const marker =
  "Command contributions: TUI dispatch, tools, queue, cancellation, checkpoints and artifacts verified";
async function run(file: string, args: string[], cwd = root) {
  const result = await execa(file, args, {
    cwd,
    reject: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `${file} ${args.join(" ")} failed (${result.exitCode}).\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}
try {
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  const manifest = await Bun.file(join(root, "package.json")).json();
  await Bun.write(
    join(packageRoot, "package.json"),
    JSON.stringify({
      ...manifest,
      name: "chiselcode-command-smoke",
      private: true,
      scripts: {},
      files: [...manifest.files, "dist/command-smoke", "dist/lsp-smoke"],
    }),
  );
  for (const file of ["README.md", "LICENSE"])
    await copyFile(join(root, file), join(packageRoot, file));
  // Include actual build assets (not local installed smoke dirs or compiled binaries).
  for (const file of await readdir(join(root, "dist"), { withFileTypes: true }))
    if (file.isFile() && /\.(?:js|gz|scm|wasm)$/.test(file.name))
      await copyFile(
        join(root, "dist", file.name),
        join(packageRoot, "dist", file.name),
      );
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-command-contributions.ts",
    "--outdir",
    join(packageRoot, "dist/command-smoke"),
    "--target",
    "bun",
    "--external",
    "@opentui/core-*",
  ]);
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-lsp-settings.ts",
    "--outdir",
    join(packageRoot, "dist/lsp-smoke"),
    "--target",
    "bun",
    "--external",
    "@opentui/core-*",
  ]);
  const tarball = (
    await run(
      "npm",
      ["pack", "--silent", "--pack-destination", staging],
      packageRoot,
    )
  ).trim();
  await run("npm", [
    "install",
    "--prefix",
    installed,
    join(staging, tarball),
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  const distribution = join(
    installed,
    "node_modules/chiselcode-command-smoke/dist",
  );
  assert.equal(
    (
      await run(process.execPath, [join(distribution, "cli.js"), "--version"])
    ).trim(),
    manifest.version,
  );
  assert.ok(
    (
      await run(process.execPath, [
        join(distribution, "command-smoke/tui-command-contributions.js"),
      ])
    ).includes(marker),
  );
  process.stdout.write("Installed linked TUI command scenario passed.\n");
  const lspMarker =
    "LSP Settings: Auto, custom setup, explicit trust, approval, real analysis, edit, restart, revocation and cleanup passed";
  assert.ok(
    (
      await run(process.execPath, [
        join(distribution, "lsp-smoke/tui-lsp-settings.js"),
      ])
    ).includes(lspMarker),
  );
  process.stdout.write("Installed LSP Settings/real-server scenario passed.\n");
  const binary = join(
    staging,
    process.platform === "win32" ? "linked-tui.exe" : "linked-tui",
  );
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-command-contributions.ts",
    "--compile",
    "--outfile",
    binary,
  ]);
  assert.ok((await run(binary, [])).includes(marker));
  process.stdout.write("Compiled linked TUI command scenario passed.\n");
  const lspBinary = join(
    staging,
    process.platform === "win32" ? "lsp-tui.exe" : "lsp-tui",
  );
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-lsp-settings.ts",
    "--compile",
    "--outfile",
    lspBinary,
  ]);
  assert.ok((await run(lspBinary, [])).includes(lspMarker));
  process.stdout.write("Compiled LSP Settings/real-server scenario passed.\n");
} finally {
  await rm(staging, { recursive: true, force: true });
}
