import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";

// Test-only UI/bundle composition: ordinary package/release builds never contain this fixture.
// CLI scenarios run once per shipped format in the Packaging job, not in this UI harness.
const root = resolve(import.meta.dir, "../..");
const staging = await mkdtemp(join(tmpdir(), "chisel-command-package-"));
const packageRoot = join(staging, "package");
const installed = join(staging, "installed");
const sideMarker = "Side query: real TUI";
const marker =
  "Command contributions: TUI dispatch, tools, queue, cancellation, checkpoints and artifacts verified";
async function run(file: string, args: string[], cwd = root) {
  const result = await execa(file, args, {
    cwd,
    reject: false,
    windowsHide: true,
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
      files: [
        ...manifest.files,
        "dist/command-smoke",
        "dist/lsp-smoke",
        "dist/side-smoke",
        "dist/worktree-smoke",
        "dist/subagent-smoke",
        "dist/background-smoke",
        "dist/ui-smoke",
      ],
    }),
  );
  for (const file of ["README.md", "LICENSE"])
    await copyFile(join(root, file), join(packageRoot, file));
  await mkdir(join(packageRoot, "dist/extension-sdk"), { recursive: true });
  for (const file of ["index.js", "index.d.ts"])
    await copyFile(
      join(root, "dist/extension-sdk", file),
      join(packageRoot, "dist/extension-sdk", file),
    );
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
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-side-query.ts",
    "--outdir",
    join(packageRoot, "dist/side-smoke"),
    "--target",
    "bun",
    "--external",
    "@opentui/core-*",
  ]);
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-worktrees.ts",
    "--outdir",
    join(packageRoot, "dist/worktree-smoke"),
    "--target",
    "bun",
    "--external",
    "@opentui/core-*",
  ]);
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-subagents.ts",
    "--outdir",
    join(packageRoot, "dist/subagent-smoke"),
    "--target",
    "bun",
    "--external",
    "@opentui/core-*",
  ]);
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-background.ts",
    "--outdir",
    join(packageRoot, "dist/background-smoke"),
    "--target",
    "bun",
    "--external",
    "@opentui/core-*",
  ]);
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-ui-contributions.ts",
    "--outdir",
    join(packageRoot, "dist/ui-smoke"),
    "--target",
    "bun",
    "--external",
    "@opentui/core-*",
  ]);
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-external-extensions.ts",
    "--outdir",
    join(packageRoot, "dist/ui-smoke"),
    "--target",
    "bun",
    "--external",
    "@opentui/core-*",
  ]);
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-extension-themes.ts",
    "--outdir",
    join(packageRoot, "dist/ui-smoke"),
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
  assert.ok(
    (
      await run(process.execPath, [
        join(distribution, "side-smoke/tui-side-query.js"),
      ])
    ).includes(sideMarker),
  );
  process.stdout.write(
    "Installed builtin /btw parallel floating TUI scenario passed.\n",
  );
  process.stdout.write("Installed linked TUI command scenario passed.\n");
  assert.ok(
    (
      await run(process.execPath, [
        join(distribution, "worktree-smoke/tui-worktrees.js"),
      ])
    ).includes("Worktree TUI: real detached"),
  );
  process.stdout.write(
    "Installed production worktree TUI with real Git/LSP passed.\n",
  );
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
  assert.ok(
    (
      await run(process.execPath, [
        join(distribution, "subagent-smoke/tui-subagents.js"),
      ])
    ).includes("Subagents TUI: production delegation"),
  );
  process.stdout.write(
    "Установленный пакет: настоящий цикл помощника и правое дерево проверены.\n",
  );
  assert.ok(
    (
      await run(process.execPath, [
        join(distribution, "background-smoke/tui-background.js"),
      ])
    ).includes("Background Tasks TUI:"),
  );
  const uiMarker = "UI contributions: production slots";
  assert.ok(
    (
      await run(process.execPath, [
        join(distribution, "ui-smoke/tui-ui-contributions.js"),
      ])
    ).includes(uiMarker),
  );
  const uiBinary = join(
    staging,
    process.platform === "win32" ? "ui-tui.exe" : "ui-tui",
  );
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-ui-contributions.ts",
    "--compile",
    "--outfile",
    uiBinary,
  ]);
  assert.ok((await run(uiBinary, [])).includes(uiMarker));
  const externalMarker = "External TUI: ordinary loader";
  assert.ok(
    (
      await run(process.execPath, [
        join(distribution, "ui-smoke/tui-external-extensions.js"),
      ])
    ).includes(externalMarker),
  );
  const externalBinary = join(
    staging,
    process.platform === "win32" ? "external-tui.exe" : "external-tui",
  );
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-external-extensions.ts",
    "--compile",
    "--outfile",
    externalBinary,
  ]);
  assert.ok((await run(externalBinary, [])).includes(externalMarker));
  process.stdout.write(
    "Installed/compiled ordinary external TUI loader: внешний .mjs, slots, pages, approval и настоящая запись проверены.\n",
  );
  process.stdout.write(
    "Установленный и compiled UI registry: независимое расширение, native details и own-tool approval проверены.\n",
  );
  const themesMarker = "Extension themes TUI:";
  assert.ok(
    (
      await run(process.execPath, [
        join(distribution, "ui-smoke/tui-extension-themes.js"),
      ])
    ).includes(themesMarker),
  );
  const themesBinary = join(
    staging,
    process.platform === "win32" ? "themes-tui.exe" : "themes-tui",
  );
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-extension-themes.ts",
    "--compile",
    "--outfile",
    themesBinary,
  ]);
  assert.ok((await run(themesBinary, [])).includes(themesMarker));
  process.stdout.write(
    "Installed/compiled extension themes: внешний .mjs, предпросмотр, выбор, сохранение и fallback проверены.\n",
  );
  const backgroundBinary = join(
    staging,
    process.platform === "win32" ? "background-tui.exe" : "background-tui",
  );
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-background.ts",
    "--compile",
    "--outfile",
    backgroundBinary,
  ]);
  assert.ok(
    (await run(backgroundBinary, [process.execPath])).includes(
      "Background Tasks TUI:",
    ),
  );
  process.stdout.write(
    "Установленный и compiled Background Tasks: реальные процессы и native popup проверены.\n",
  );
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
  const sideBinary = join(
    staging,
    process.platform === "win32" ? "side-tui.exe" : "side-tui",
  );
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-side-query.ts",
    "--compile",
    "--outfile",
    sideBinary,
  ]);
  assert.ok((await run(sideBinary, [])).includes(sideMarker));
  process.stdout.write("Compiled builtin /btw floating TUI scenario passed.\n");
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
  const worktreeBinary = join(
    staging,
    process.platform === "win32" ? "worktree-tui.exe" : "worktree-tui",
  );
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-worktrees.ts",
    "--compile",
    "--outfile",
    worktreeBinary,
  ]);
  assert.ok(
    (await run(worktreeBinary, [])).includes("Worktree TUI: real detached"),
  );
  process.stdout.write(
    "Compiled production worktree TUI with real Git/LSP passed.\n",
  );
  const subagentBinary = join(
    staging,
    process.platform === "win32" ? "subagent-tui.exe" : "subagent-tui",
  );
  await run(process.execPath, [
    "build",
    "tests/fixtures/tui-subagents.ts",
    "--compile",
    "--outfile",
    subagentBinary,
  ]);
  assert.ok(
    (await run(subagentBinary, [])).includes(
      "Subagents TUI: production delegation",
    ),
  );
  process.stdout.write(
    "Compiled: настоящие помощники и дерево OpenTUI проверены.\n",
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
