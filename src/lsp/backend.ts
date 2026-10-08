import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { chiselHomeDir } from "../paths/home.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import backendAsset from "./backend/typescript.json.gz" with { type: "file" };
import { AUTO_BACKEND } from "./backend/version.js";
import type { LspLaunch } from "./config.js";

export const AUTO_SERVER_ID = "auto";
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const pending = new Map<string, Promise<void>>();
const outside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};
async function canonicalDestination(path: string): Promise<string> {
  const missing: string[] = [];
  let parent = resolve(path);
  for (;;) {
    try {
      return resolve(await realpath(parent), ...missing.reverse());
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        dirname(parent) === parent
      )
        throw error;
      missing.push(relative(dirname(parent), parent));
      parent = dirname(parent);
    }
  }
}

/** Predictable, core-owned launch. Status/prepare never extract assets or start a process. */
export async function autoLspLaunch(root: string): Promise<LspLaunch> {
  const cache = await canonicalDestination(
    join(
      chiselHomeDir(),
      "lsp",
      `typescript-${AUTO_BACKEND.typescript}-${AUTO_BACKEND.sha256.slice(0, 16)}`,
    ),
  );
  if (!outside(root, cache))
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "ChiselCode LSP data must be outside the analysed workspace.",
    );
  const command = process.execPath;
  const args = [
    join(cache, "typescript-language-server/lib/cli.mjs"),
    "--stdio",
  ];
  const typescriptPath = join(cache, "typescript/lib/tsserver.js");
  return {
    id: AUTO_SERVER_ID,
    kind: "auto",
    backend: "typescript",
    command,
    args,
    typescriptPath,
    serverVersion: AUTO_BACKEND.server,
    typescriptVersion: AUTO_BACKEND.typescript,
    fingerprint: JSON.stringify([
      AUTO_SERVER_ID,
      command,
      args,
      typescriptPath,
      AUTO_BACKEND.sha256,
    ]),
  };
}

/** Extract only the pinned application payload; no download, project package, or install scripts. */
export async function prepareAutoBackend(
  root: string,
  signal?: AbortSignal,
): Promise<LspLaunch> {
  cancelled(signal);
  const launch = await autoLspLaunch(root);
  if (!launch.typescriptPath)
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "Bundled TypeScript runtime is missing.",
    );
  const cache = dirname(dirname(launch.typescriptPath));
  const destination = dirname(cache);
  let work = pending.get(destination);
  if (!work) {
    work = materialize(root, destination).finally(() => {
      pending.delete(destination);
    });
    pending.set(destination, work);
  }
  try {
    await work;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "Не удалось подготовить стандартный backend. Проверьте установку ChiselCode и доступ к каталогу данных.",
    );
  }
  cancelled(signal);
  return launch;
}
async function materialize(root: string, destination: string): Promise<void> {
  const assetPath = isAbsolute(backendAsset)
    ? backendAsset
    : fileURLToPath(new URL(backendAsset, import.meta.url));
  const bytes = new Uint8Array(await Bun.file(assetPath).arrayBuffer());
  if (hash(bytes) !== AUTO_BACKEND.sha256)
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "Bundled LSP payload failed its integrity check.",
    );
  const files = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8"),
  ) as Record<string, string>;
  const entries = Object.entries(files);
  if (
    entries.length > 256 ||
    entries.some(
      ([name, text]) =>
        !/^(?:typescript|typescript-language-server)\/(?:lib\/)?[a-zA-Z0-9._-]+$/.test(
          name,
        ) || typeof text !== "string",
    )
  )
    throw new RuntimeError("LSP_UNAVAILABLE", "Invalid bundled LSP layout.");
  const intact = async () => {
    try {
      const canonical = await realpath(destination);
      if (canonical !== destination || !outside(root, canonical)) return false;
      for (const [name, text] of entries) {
        const path = join(destination, name);
        const info = await lstat(path);
        if (!info.isFile() || info.size !== Buffer.byteLength(text))
          return false;
        const actual = await realpath(path);
        if (
          actual !== path ||
          !outside(root, actual) ||
          hash(await readFile(path)) !== hash(text)
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  if (await intact()) return;
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (
    (await canonicalDestination(destination)) !== destination ||
    !outside(root, await realpath(parent))
  )
    throw new RuntimeError("LSP_UNAVAILABLE", "Unsafe bundled LSP data path.");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const previous = `${destination}.${randomUUID()}.old`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const [name, text] of entries) {
      const path = join(temporary, name);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, text, { mode: 0o600, flag: "wx" });
    }
    // Another process may have prepared the same immutable version in the meantime.
    if (await intact()) return;
    try {
      await rename(destination, previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!(await intact())) throw error;
    }
    if (!(await intact()))
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "Bundled LSP cache failed validation.",
      );
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
  }
}
