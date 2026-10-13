import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { VERSION } from "../src/version.js";
import { DESKTOP_PROTOCOL } from "../src/desktop/protocol.js";
const root = process.argv[2] ?? "dist/release-artifacts";
const files = (await readdir(root)).filter((name) => name.startsWith("chisel-engine-") || name.startsWith("chisel-desktop-sdk-"));
const assets: Record<string, { name: string; sha256: string }> = {};
for (const name of files) {
  const target = name.endsWith("skills.tgz") ? "skills" : name.includes("desktop-sdk") ? "sdk" : name.replace("chisel-engine-", "").replace(/\.exe$/, "");
  assets[target] = { name, sha256: createHash("sha256").update(await readFile(join(root, name))).digest("hex") };
}
for (const target of ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64", "sdk", "skills"]) if (!assets[target]) throw new Error(`Missing engine asset: ${target}`);
await writeFile(join(root, "engine-manifest.json"), JSON.stringify({ schemaVersion: 1, repository: "TheAsrada/ChiselCode", tag: `v${VERSION}`, engineVersion: VERSION, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), protocol: DESKTOP_PROTOCOL, assets }, null, 2) + "\n");
