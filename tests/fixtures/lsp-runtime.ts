import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LspServerConfig } from "../../src/lsp/config.js";

export async function installedLsp(): Promise<LspServerConfig> {
  const installation = resolve(
    process.env.CHISEL_TEST_LSP_ROOT ??
      join(tmpdir(), "chiselcode-lsp-test-runtime"),
  );
  try {
    const server = JSON.parse(
      await readFile(
        join(
          installation,
          "node_modules/typescript-language-server/package.json",
        ),
        "utf8",
      ),
    );
    const typescript = JSON.parse(
      await readFile(
        join(installation, "node_modules/typescript/package.json"),
        "utf8",
      ),
    );
    if (server.version !== "6.0.1" || typescript.version !== "6.0.3")
      throw new Error();
    const command =
      process.env.CHISEL_TEST_LSP_NODE ??
      execFileSync("node", ["-p", "process.execPath"], {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
    return {
      enabled: true,
      backend: "typescript",
      command: await realpath(command),
      args: [
        join(
          installation,
          "node_modules/typescript-language-server/lib/cli.mjs",
        ),
        "--stdio",
      ],
      typescriptPath: join(
        installation,
        "node_modules/typescript/lib/tsserver.js",
      ),
      trustedWorkspaces: [],
    };
  } catch {
    throw new Error(
      "Real LSP tests require pinned external dependencies. Run: bun scripts/prepare-lsp-tests.ts (Node >=22.22.2 must be installed). Tests are not skipped.",
    );
  }
}
