import { execa } from "execa";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Explicit CI/developer test setup, never imported by the application or release entry point.
const installation = resolve(process.env.CHISEL_TEST_LSP_ROOT ?? join(tmpdir(), "chiselcode-lsp-test-runtime"));
await execa("npm", ["install", "--prefix", installation, "--ignore-scripts", "--no-audit", "--no-fund", "typescript-language-server@6.0.1", "typescript@6.0.3"], { stdio: "inherit" });
process.stdout.write("Pinned external LSP test runtime prepared (language-server 6.0.1, TypeScript 6.0.3).\n");

// Standard servers needed by unconditional real integration tests. This is test
// setup, not application activation: ordinary listing remains filesystem-only.
const { catalogServer } = await import("../src/lsp/catalog.js");
const { catalogLspLaunch } = await import("../src/lsp/provision.js");
const { RuntimeError } = await import("../src/runtime/errors.js");
for (const id of ["auto-python", "auto-lua"]) {
  const descriptor = catalogServer(id);
  if (!descriptor) throw new Error(`Missing catalog server ${id}`);
  for (let attempt = 0; ; attempt++) {
    try {
      await catalogLspLaunch(join(tmpdir(), "chisel-test-project"), descriptor, true);
      break;
    } catch (error) {
      if (attempt >= 2 || !(error instanceof RuntimeError) || error.code !== "WEB_TIMEOUT") throw error;
      console.warn(`${id}: таймаут скачивания; повтор ${attempt + 1}/2 с прежней проверкой integrity.`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
process.stdout.write("Pinned Auto Pyright/Lua test backends prepared.\n");
