import { execa } from "execa";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Explicit CI/developer test setup, never imported by the application or release entry point.
const installation = resolve(process.env.CHISEL_TEST_LSP_ROOT ?? join(tmpdir(), "chiselcode-lsp-test-runtime"));
await execa("npm", ["install", "--prefix", installation, "--ignore-scripts", "--no-audit", "--no-fund", "typescript-language-server@6.0.1", "typescript@6.0.3"], { stdio: "inherit" });
process.stdout.write("Pinned external LSP test runtime prepared (language-server 6.0.1, TypeScript 6.0.3).\n");
