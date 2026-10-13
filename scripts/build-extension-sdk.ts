import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execa } from "execa";

const root = resolve(import.meta.dir, "..");
await mkdir(resolve(root, "dist/extension-sdk"), { recursive: true });
await execa(process.execPath, ["build", "src/extension-sdk/index.ts", "--target", "bun", "--outdir", "dist/extension-sdk"], { cwd: root, stdio: "inherit" });
await execa(process.execPath, ["node_modules/typescript/bin/tsc", "--ignoreConfig", "src/extension-sdk/index.ts", "--declaration", "--emitDeclarationOnly", "--outDir", "dist/extension-sdk", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck"], { cwd: root, stdio: "inherit" });
