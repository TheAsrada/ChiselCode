import { execFile, execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LspServerConfig } from "../../src/lsp/config.js";

const execute = promisify(execFile);
async function windowsNodeProcesses(): Promise<
  Array<{ pid: number; parent: number }>
> {
  const { dlopen, ptr } = await import("bun:ffi");
  const library = dlopen(
    join(
      process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
      "System32/kernel32.dll",
    ),
    {
      CreateToolhelp32Snapshot: { args: ["u32", "u32"], returns: "u64" },
      Process32FirstW: { args: ["u64", "ptr"], returns: "u32" },
      Process32NextW: { args: ["u64", "ptr"], returns: "u32" },
      CloseHandle: { args: ["u64"], returns: "u32" },
    },
  );
  const api = library.symbols;
  const snapshot = api.CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
  const invalid = !snapshot || BigInt(snapshot) === (1n << 64n) - 1n;
  try {
    if (invalid) throw new Error("Windows process snapshot failed.");
    const entry = Buffer.alloc(568); // PROCESSENTRY32W on 64-bit Windows
    entry.writeUInt32LE(entry.length);
    const result: Array<{ pid: number; parent: number }> = [];
    let present = api.Process32FirstW(snapshot, ptr(entry));
    if (!present)
      throw new Error("Windows process snapshot could not be read.");
    let scanned = 0;
    while (present) {
      if (++scanned > 4096)
        throw new Error("Windows process snapshot exceeded test budget.");
      if (
        entry
          .subarray(44, 564)
          .toString("utf16le")
          .split("\0")[0]
          ?.toLowerCase() === "node.exe"
      )
        result.push({
          pid: entry.readUInt32LE(8),
          parent: entry.readUInt32LE(32),
        });
      present = api.Process32NextW(snapshot, ptr(entry));
    }
    return result;
  } finally {
    if (!invalid) api.CloseHandle(snapshot);
    library.close();
  }
}
async function nodeProcesses(): Promise<
  Array<{ pid: number; parent: number }>
> {
  if (process.platform === "win32") return windowsNodeProcesses();
  // Only process IDs, ancestry and executable names; never collect argv/env.
  const args = ["-e", "-ww", "-o", "pid=,ppid=,stat=,comm="];
  const { stdout } = await execute("/bin/ps", args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(\S+)\s+(.+))?\s*$/.exec(line);
    if (!match) return [];
    if (
      match[3]?.startsWith("Z") ||
      // Node 24 names its Linux main thread MainThread.
      !["node", "MainThread"].includes(basename((match[4] ?? "").trim()))
    )
      return [];
    return [{ pid: Number(match[1]), parent: Number(match[2]) }];
  });
}

/** Observe the real TLS/tsserver descendants without adding a production PID port. */
export async function lspProcessTree(): Promise<number[]> {
  const processes = await nodeProcesses();
  const parents = new Set([process.pid]);
  for (let index = 0; index < processes.length; ++index)
    for (const item of processes)
      if (parents.has(item.parent)) parents.add(item.pid);
  parents.delete(process.pid);
  return [...parents];
}

export async function waitForLspProcessExit(pids: number[]): Promise<void> {
  const deadline = Date.now() + 5000;
  do {
    if (!(await nodeProcesses()).some((item) => pids.includes(item.pid)))
      return;
    await Bun.sleep(30);
  } while (Date.now() < deadline);
  throw new Error("Language server or tsserver descendants did not exit.");
}

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
