import { execa } from "execa";
import { RuntimeError } from "../runtime/errors.js";
export interface PreparedCommand {
  command: string;
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
}
export interface ProcessResult {
  output: string;
  exitCode: number;
  sandboxed: boolean;
}
export interface SandboxExecutor {
  execute(command: PreparedCommand): Promise<ProcessResult>;
}
export class HostSandboxExecutor implements SandboxExecutor {
  async execute(command: PreparedCommand): Promise<ProcessResult> {
    if (command.signal?.aborted)
      throw new RuntimeError("CANCELLED", "Shell command cancelled.");
    const child = execa(command.command, {
      cwd: command.cwd,
      shell: true,
      reject: false,
      all: true,
      detached: process.platform !== "win32",
      maxBuffer: 32 * 1024 * 1024,
    });
    let timedOut = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const killTree = (force: boolean) => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        void execa("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          reject: false,
        }).catch(() => child.kill());
      } else {
        try {
          process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        } catch {
          /* The process group has exited. */
        }
      }
    };
    const terminate = () => {
      killTree(false);
      forceTimer ??= setTimeout(() => killTree(true), 1000);
    };
    command.signal?.addEventListener("abort", terminate, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, command.timeout);
    try {
      const result = await child;
      if (command.signal?.aborted)
        throw new RuntimeError("CANCELLED", "Shell command cancelled.");
      if (timedOut)
        throw new RuntimeError("TOOL_TIMEOUT", "Shell command timed out.");
      return {
        output: `Command exited ${result.exitCode}.\n${result.all ?? ""}`,
        exitCode: result.exitCode ?? 1,
        sandboxed: false,
      };
    } catch (error) {
      if (command.signal?.aborted)
        throw new RuntimeError("CANCELLED", "Shell command cancelled.");
      if (timedOut)
        throw new RuntimeError("TOOL_TIMEOUT", "Shell command timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
      if (forceTimer) {
        killTree(true);
        clearTimeout(forceTimer);
      }
      command.signal?.removeEventListener("abort", terminate);
    }
  }
}
