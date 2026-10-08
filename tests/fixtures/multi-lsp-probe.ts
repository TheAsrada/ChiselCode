import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspService } from "../../src/lsp/service.js";
import { WorkspacePolicy } from "../../src/security/workspace-policy.js";
import { lspProcessTree, waitForLspProcessExit } from "./lsp-runtime.js";

const examples: Record<string, [string, string, Record<string, string>?]> = {
  python: [
    "example.py",
    'def greet(name: str) -> str:\n    return name\n\nresult: int = "wrong"\n',
  ],
  go: [
    "main.go",
    'package main\nfunc greet() int { return "wrong" }\nfunc main() { greet() }\n',
    { "go.mod": "module example.test/demo\n\ngo 1.26\n" },
  ],
  rust: [
    "main.rs",
    'fn greet() -> i32 { "wrong" }\nfn main() { greet(); }\n',
    {
      "Cargo.toml":
        '[package]\nname = "example"\nversion = "0.1.0"\nedition = "2024"\n[[bin]]\nname = "example"\npath = "main.rs"\n',
    },
  ],
  cpp: [
    "main.cpp",
    'int greet() { return "wrong"; }\nint main() { return greet(); }\n',
  ],
  csharp: [
    "Main.cs",
    'class Example { public int greet() { return "wrong"; } static int Main() { return new Example().greet(); } }\n',
    {
      "Example.csproj":
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
    },
  ],
  java: [
    "Example.java",
    'class Example { int greet() { return "wrong"; } public static void main(String[] args) { new Example().greet(); } }\n',
  ],
  kotlin: ["Example.kt", 'fun greet(): Int = "wrong"\n'],
  lua: [
    "example.lua",
    "local function greet(name)\n return name\nend\nunknown_value()\n",
  ],
  php: ["example.php", '<?php\nfunction greet(): int { return "wrong"; }\n'],
  html: [
    "example.html",
    "<!doctype html><html><body><h1>Hello</h1></body></html>",
  ],
  css: ["example.css", "body { unknown-prop: nope; }\n"],
  json: ["example.json", '{"value": 1, "broken": }'],
  yaml: ["example.yaml", "key: [\n"],
  bash: ["example.sh", "greet() { echo hi; }\ngreet\n"],
  docker: ["Dockerfile", "FROM scratch\nINVALID value\n"],
  dart: ["example.dart", 'int greet() => "wrong";\nvoid main() { greet(); }\n'],
  ruby: ["example.rb", 'def greet(name)\n name\nend\ngreet("hi")\n'],
  swift: [
    "example.swift",
    'func greet() -> Int { return "wrong" }\nlet value = greet()\n',
  ],
};
for (const language of process.argv.slice(2)) {
  const example = examples[language];
  if (!example) throw new Error(`Unknown fixture language: ${language}`);
  const [path, text, files] = example;
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `chisel-real-${language}-`)),
  );
  const service = new LspService(
    root,
    async () => ({ global: { servers: {} }, ignorePatterns: [] }),
    new AbortController().signal,
  );
  let descendants: number[] = [];
  try {
    await writeFile(join(root, path), text);
    for (const [name, bytes] of Object.entries(files ?? {}))
      await writeFile(join(root, name), bytes);
    const port = { policy: new WorkspacePolicy(root, []) };
    const start = Date.now();
    let diagnostic = await service.diagnostics(path, port);
    for (
      let attempt = 0;
      attempt < 3 && diagnostic.freshness === "unavailable";
      ++attempt
    ) {
      await Bun.sleep(250);
      diagnostic = await service.diagnostics(path, port);
    }
    const symbols = await service.documentSymbols(path, port);
    const status = await service.status();
    descendants = await lspProcessTree();
    assert.ok(
      descendants.length > 0,
      `${language}: real server process missing`,
    );
    assert.equal(
      status.state,
      "ready",
      `${language}: initialize must complete`,
    );
    const symbolItems = (symbols as { symbols: unknown[] }).symbols;
    assert.ok(
      symbolItems.length > 0,
      `${language}: actual document symbols missing`,
    );
    let definition: unknown;
    const offset = text.lastIndexOf("greet");
    if (offset >= 0 && status.capabilities?.includes("definition")) {
      const prefix = text.slice(0, offset + 1).split("\n");
      definition = await service.definition(
        path,
        {
          line: prefix.length - 1,
          character: (prefix.at(-1)?.length ?? 1) - 1,
        },
        port,
      );
      if (
        [
          "python",
          "go",
          "rust",
          "cpp",
          "dart",
          "java",
          "csharp",
          "ruby",
          "swift",
        ].includes(language)
      )
        assert.ok(
          (definition as { locations: unknown[] }).locations.length > 0,
          `${language}: actual definition missing`,
        );
    }
    if (
      [
        "python",
        "go",
        "rust",
        "cpp",
        "csharp",
        "java",
        "dart",
        "css",
        "json",
        "yaml",
        "docker",
      ].includes(language)
    ) {
      for (
        let attempt = 0;
        attempt < 60 && !diagnostic.diagnostics.length;
        ++attempt
      ) {
        await Bun.sleep(500);
        diagnostic = await service.diagnostics(path, port);
      }
      assert.ok(
        diagnostic.diagnostics.length > 0,
        `${language}: expected real diagnostic missing`,
      );
      assert.ok(
        ["current", "observed"].includes(diagnostic.freshness),
        `${language}: invalid provenance`,
      );
    }
    const evidence = {
      freshness: diagnostic.freshness,
      diagnostics: diagnostic.diagnostics.length,
      symbols: symbolItems.length,
      definitions: (definition as { locations?: unknown[] } | undefined)
        ?.locations?.length,
      serverId: status.serverId,
      generation: status.generation,
    };
    console.log(language, Date.now() - start, JSON.stringify(evidence));
    if (process.env.GITHUB_ACTIONS)
      console.log(
        `::notice title=Real LSP ${language}::${JSON.stringify(evidence)}`,
      );
  } catch (error) {
    console.log(
      language,
      "FAILED",
      error instanceof Error
        ? [error.message, (error as { details?: unknown }).details]
        : error,
    );
    if (process.env.GITHUB_ACTIONS) {
      const diagnostic = JSON.stringify({
        language,
        error: error instanceof Error ? error.message : String(error),
        details: (error as { details?: unknown })?.details,
      })
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
      console.error(`::error title=Real LSP ${language}::${diagnostic}`);
    }
    process.exitCode = 1;
  } finally {
    await service.dispose();
    await waitForLspProcessExit(descendants);
    assert.equal((await service.status()).state, "disposed");
    await rm(root, { recursive: true, force: true });
  }
}
