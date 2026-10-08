import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { zipSync } from "fflate";
import {
  backendArchivePath,
  extractBackendArchive,
} from "../../src/lsp/archive.js";
import {
  catalogLanguage,
  catalogServer,
  LSP_SERVER_CATALOG,
} from "../../src/lsp/catalog.js";
import {
  customLanguage,
  LspConfigSchema,
  selectLspServer,
  validateLspLaunch,
} from "../../src/lsp/config.js";
import { lspProjectRoot } from "../../src/lsp/project-root.js";
import { catalogLspLaunch } from "../../src/lsp/provision.js";
import { WorkspacePolicy } from "../../src/security/workspace-policy.js";

test("project detection chooses the nearest permitted project and manual scripts cannot run from the repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chisel-language-project-"));
  try {
    const root = join(directory, "workspace");
    const nested = join(root, "app");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "global.json"), "{}");
    await writeFile(join(nested, "Ignored.csproj"), "<Project />");
    await writeFile(join(nested, "App.csproj"), "<Project />");
    await writeFile(join(nested, "Main.cs"), "class Main {}\n");
    expect(
      await lspProjectRoot(
        new WorkspacePolicy(root, ["**/Ignored.csproj"]),
        "app/Main.cs",
        catalogServer("auto-csharp"),
      ),
    ).toBe(nested);
    const server = {
      enabled: true,
      backend: "generic" as const,
      command: process.execPath,
      args: ["./server.mjs"],
      languageIds: ["csharp"],
      extensions: [],
      trustedWorkspaces: [root],
    };
    await expect(
      validateLspLaunch(root, "manual", server),
    ).rejects.toMatchObject({ code: "LSP_UNAVAILABLE" });
    const entry = join(directory, "server.mjs");
    await writeFile(entry, "// A trusted external entry point\n");
    expect(
      (await validateLspLaunch(root, "manual", { ...server, args: [entry] }))
        .args,
    ).toEqual([entry]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("language catalog covers source/config filenames without ambiguous Auto identity", async () => {
  const files = {
    "a.py": "python",
    "main.go": "go",
    "a.rs": "rust",
    "a.c": "c",
    "a.cpp": "cpp",
    "a.cs": "csharp",
    "a.java": "java",
    "a.kt": "kotlin",
    "a.php": "php",
    "a.rb": "ruby",
    "a.swift": "swift",
    "a.lua": "lua",
    "a.dart": "dart",
    "a.mts": "typescript",
    "a.tsx": "typescriptreact",
    "a.html": "html",
    "a.scss": "scss",
    "a.jsonc": "jsonc",
    "a.yaml": "yaml",
    ".bashrc": "shellscript",
    "Dockerfile.dev": "dockerfile",
  };
  for (const [file, language] of Object.entries(files))
    expect(catalogLanguage(file)?.language.id).toBe(language);
  expect(catalogLanguage("missing.unlisted")).toBeUndefined();
  expect(new Set(LSP_SERVER_CATALOG.map((item) => item.id)).size).toBe(
    LSP_SERVER_CATALOG.length,
  );
  const selected = await selectLspServer(
    tmpdir(),
    { global: { servers: {} }, ignorePatterns: [] },
    undefined,
    "main.py",
  );
  expect(selected).toMatchObject({
    state: "stopped",
    id: "auto-python",
    kind: "auto",
  });
  const server = catalogServer("auto-python");
  if (!server) throw new Error("Catalog missing Python");
  const preview = await catalogLspLaunch(tmpdir(), server);
  expect(preview.args.join(" ")).toContain("langserver.index.js");
  expect(preview.fingerprint).not.toContain("OPENAI_API_KEY");
  expect(preview.command).not.toContain("node_modules/.bin");
});
test("manual stdio configuration is typed, strict and can map a new file extension", () => {
  const config = LspConfigSchema.parse({
    mode: "custom",
    servers: {
      notes: {
        enabled: true,
        backend: "generic",
        command: process.execPath,
        args: [],
        languageIds: ["notes"],
        extensions: [".notes"],
        trustedWorkspaces: [],
        settings: { notes: { validate: true } },
      },
    },
  });
  const server = config.servers.notes;
  if (!server) throw new Error("Missing manual server");
  expect(customLanguage(server, "README.notes")).toBe("notes");
  expect(customLanguage(server, "main.py")).toBeUndefined();
  expect(() =>
    LspConfigSchema.parse({ ...config, servers: { "auto-python": server } }),
  ).toThrow();
  expect(() =>
    LspConfigSchema.parse({ servers: { notes: { ...server, shell: true } } }),
  ).toThrow();
  expect(() =>
    LspConfigSchema.parse({
      servers: {
        notes: { ...server, settings: { secret: "x".repeat(65536) } },
      },
    }),
  ).toThrow();
});
test("verified archives use byte limits and safe regular paths, with no traversal/links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chisel-archive-"));
  try {
    for (const path of [
      "../escape",
      "/escape",
      "a/../../escape",
      "a\\escape",
      "a:stream",
      "a/\0",
    ])
      expect(() => backendArchivePath(path)).toThrow();
    expect(backendArchivePath("package/./dist/main.js")).toBe(
      "package/dist/main.js",
    );
    await extractBackendArchive(
      zipSync({ "server/main": new TextEncoder().encode("é") }),
      "zip",
      directory,
    );
    expect(await readFile(join(directory, "server/main"), "utf8")).toBe("é");
    await expect(
      extractBackendArchive(
        zipSync({ "../outside": new Uint8Array([1]) }),
        "zip",
        directory,
      ),
    ).rejects.toThrow();
    const next = join(directory, "gzip");
    await mkdir(next);
    await extractBackendArchive(gzipSync(Buffer.from("backend")), "gz", next);
    expect(await readFile(join(next, "server"), "utf8")).toBe("backend");
    const controller = new AbortController();
    controller.abort();
    await expect(
      extractBackendArchive(
        gzipSync(Buffer.from("x")),
        "gz",
        next,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
