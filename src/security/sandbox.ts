import { ManagedProcess } from "../processes/managed.js";
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
/** Compatibility wrapper over the same managed process backend. */
export class HostSandboxExecutor implements SandboxExecutor {
  async execute(command: PreparedCommand): Promise<ProcessResult> {
    if (command.signal?.aborted)
      throw new RuntimeError("CANCELLED", "Команда отменена.");
    const chunks: Buffer[] = [];
    let bytes = 0;
    let handle!: ManagedProcess;
    handle = new ManagedProcess({
      ...command,
      deadline: Date.now() + command.timeout,
      capture: {
        async write(_stream, data) {
          bytes += data.byteLength;
          if (bytes > 32 * 1024 * 1024) {
            void handle.stop("output_limit");
            return;
          }
          chunks.push(Buffer.from(data));
        },
        async close() {},
      },
    });
    await handle.ready;
    const outcome = await handle.done;
    if (!outcome.cleanup)
      throw new RuntimeError(
        "BACKGROUND_RECOVERY_REQUIRED",
        "Завершение процессов не подтверждено.",
      );
    if (outcome.reason === "cancelled")
      throw new RuntimeError("CANCELLED", "Команда отменена.");
    if (outcome.reason === "timed_out")
      throw new RuntimeError("TOOL_TIMEOUT", "Время команды истекло.", {
        cleanupPhase: handle.cleanupPhase,
        cleanupDetail: handle.cleanupDetail,
      });
    if (outcome.reason === "output_limit")
      throw new RuntimeError(
        "TOOL_EXECUTION_FAILURE",
        "Лимит вывода команды превышен.",
      );
    return {
      output: `Command exited ${outcome.exitCode ?? 1}.\n${Buffer.concat(chunks).toString("utf8")}`,
      exitCode: outcome.exitCode ?? 1,
      sandboxed: false,
    };
  }
}
