import { mkdir, writeFile } from "node:fs/promises";
import { execa } from "execa";
await mkdir("dist/desktop-sdk", { recursive: true });
await execa(process.execPath, ["build", "src/desktop/client.ts", "--target", "browser", "--outfile", "dist/desktop-sdk/index.js"], { stdio: "inherit" });
await execa(process.execPath, ["node_modules/typescript/bin/tsc", "--ignoreConfig", "src/desktop/client.ts", "--declaration", "--emitDeclarationOnly", "--outDir", "dist/desktop-sdk", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck"], { stdio: "inherit" });
await writeFile("dist/desktop-sdk/index.d.ts", 'export * from "./client.js";\n');
await writeFile("dist/desktop-sdk/package.json", JSON.stringify({ name: "@chiselcode/desktop-sdk", version: "1.0.0", type: "module", main: "index.js", types: "index.d.ts", exports: { ".": { types: "./index.d.ts", import: "./index.js" } }, files: ["*.js", "*.d.ts"], license: "MIT" }, null, 2));
