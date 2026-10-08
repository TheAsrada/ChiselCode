import { execFile, execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { LspServerConfig } from "../../src/lsp/config.js";

const execute = promisify(execFile);
async function nodeProcesses(): Promise<
  Array<{ pid: number; parent: number }>
> {
  const windows = process.platform === "win32";
  const command = windows
    ? join(
        process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      )
    : "/bin/ps";
  // Only process IDs, ancestry and executable names; never collect argv/env.
  const args = windows
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
      ]
    : ["-e", "-o", "pid=,ppid=,stat=,comm="];
  const { stdout } = await execute(command, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)(?:\s+(\S+)\s+(.+))?\s*$/.exec(line);
    if (!match) return [];
    if (
      !windows &&
      (match[3]?.startsWith("Z") ||
        // Node 24 names its Linux main thread MainThread.
        !["node", "MainThread"].includes(basename((match[4] ?? "").trim())))
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
