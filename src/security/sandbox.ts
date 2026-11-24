import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessLog } from "../processes/log.js";
import { type ManagedOutcome, ManagedProcess } from "../processes/managed.js";
import { recheckShellCwd, shellStartError } from "../processes/shell-cwd.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { SENSITIVE_KEY, SecretRedactor } from "./redaction.js";
import type { WorkspacePolicy } from "./workspace-policy.js";
export interface PreparedCommand {
  command: string;
  cwd: string;
  timeout: number;
  workspace?: WorkspacePolicy;
  signal?: AbortSignal;
}
export interface ProcessResult {
  output: string;
  exitCode: number | null;
  outcome?: ManagedOutcome;
  captureComplete?: boolean;
  diagnostic?: string;
  sandboxed: boolean;
}
export interface SandboxExecutor {
  execute(command: PreparedCommand): Promise<ProcessResult>;
}
/** Compatibility wrapper over the same managed process backend. */
export class HostSandboxExecutor implements SandboxExecutor {
  async execute(command: PreparedCommand): Promise<ProcessResult> {
    if (command.signal?.aborted)
      throw new RuntimeError("CANCELLED", "Команда отменена.");
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "chisel-shell-")),
    );
    const redactor = new SecretRedactor();
    for (const [key, value] of Object.entries(process.env))
      if (value && SENSITIVE_KEY.test(key)) redactor.add(value);
    let handle!: ManagedProcess;
    const log = new ProcessLog(
      join(directory, "output"),
      32 * 1024 * 1024,
      redactor,
      () => {},
      () => {
        void handle.stop("output_limit");
      },
    );
    try {
      await log.create();
      await recheckShellCwd(command.cwd, command.workspace);
      cancelled(command.signal);
      handle = new ManagedProcess({
        ...command,
        deadline: Date.now() + command.timeout,
        capture: log,
      });
      await handle.ready.catch(() => {});
      const outcome = await handle.done;
      const startError = await shellStartError(command.cwd, outcome);
      if (startError && outcome.cleanup)
        throw new RuntimeError(
          startError.code,
          redactor.text(startError.message),
        );
      const pages: string[] = [];
      let cursor = 0;
      let captureComplete = !log.truncated && !outcome.captureFailed;
      try {
        while (cursor < log.size) {
          const page = await log.read(cursor, 64 * 1024);
          if (page.next <= cursor) {
            captureComplete = false;
            break;
          }
          pages.push(page.text);
          cursor = page.next;
        }
      } catch {
        captureComplete = false;
      }
      return {
        output: pages.join(""),
        exitCode: outcome.exitCode,
        outcome,
        captureComplete,
        diagnostic: startError && redactor.text(startError.message),
        sandboxed: false,
      };
    } finally {
      await log.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  }
}
