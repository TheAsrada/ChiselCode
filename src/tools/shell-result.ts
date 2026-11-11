import type { ManagedOutcome } from "../processes/managed.js";
import { shellFailureHint } from "../processes/shell.js";
import type { ToolExecutionResult } from "../types/domain.js";

/** One projection for managed foreground and the compatibility sandbox path.
 * The log is already sanitized by ProcessLog; status never becomes log content. */
export function shellResult(input: {
  outcome: ManagedOutcome;
  output: string;
  command: string;
  timeoutMs: number;
  captureComplete: boolean;
  infrastructureError?: boolean;
}): ToolExecutionResult {
  const { outcome } = input;
  const reason = !outcome.cleanup
    ? "cleanup_unknown"
    : (outcome.reason ??
      (input.infrastructureError ||
      !input.captureComplete ||
      outcome.captureFailed
        ? "infrastructure_failed"
        : outcome.signal
          ? "signal"
          : outcome.exitCode === 0
            ? "exited"
            : outcome.exitCode === null
              ? "infrastructure_failed"
              : "nonzero_exit"));
  const labels = {
    exited: "Команда завершена",
    nonzero_exit: "Ненулевой выход команды",
    signal: "Команда завершена сигналом",
    timed_out: "Тайм-аут команды",
    cancelled: "Команда отменена",
    output_limit: "Достигнут лимит захвата вывода",
    capture_failed: "Сбой захвата вывода",
    infrastructure_failed: "Инфраструктурный сбой команды",
    cleanup_unknown:
      "Завершение процессов не подтверждено; workspace остаётся занят",
  };
  const captureComplete = input.captureComplete && !outcome.captureFailed;
  const timing = outcome.timing;
  const summary = `${labels[reason]}${!outcome.cleanup && outcome.reason ? ` (${labels[outcome.reason]})` : ""}. Exit code: ${outcome.exitCode ?? "null"}; сигнал: ${outcome.signal ?? "null"}.${timing ? ` Ожидание: ${timing.waitMs} мс; лимит: ${input.timeoutMs} мс; cleanup: ${timing.cleanupMs} мс.` : ""} Захват ${captureComplete ? "полный" : "неполный"}.`;
  const isError = reason !== "exited";
  const hint = isError
    ? shellFailureHint(input.command, input.output)
    : undefined;
  return {
    output: `${summary}\n${input.output}${hint ? `\n${hint}` : ""}`,
    rawOutput: input.output,
    isError,
    errorCode: isError
      ? reason === "cancelled"
        ? "CANCELLED"
        : reason === "timed_out"
          ? "TOOL_TIMEOUT"
          : reason === "cleanup_unknown"
            ? "BACKGROUND_RECOVERY_REQUIRED"
            : "TOOL_EXECUTION_FAILURE"
      : undefined,
    details: {
      exitCode: outcome.exitCode,
      shell: {
        reason,
        ...(outcome.reason ? { stopReason: outcome.reason } : {}),
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timeoutMs: input.timeoutMs,
        ...timing,
        cleanupConfirmed: outcome.cleanup,
        captureComplete,
        captureFailed: outcome.captureFailed ?? false,
        summary,
      },
    },
    sandboxed: false,
  };
}

export function shellSummary(result: ToolExecutionResult): string | undefined {
  const shell = result.details?.shell;
  if (!shell || typeof shell !== "object") return;
  const summary = (shell as Record<string, unknown>).summary;
  return typeof summary === "string" ? summary : undefined;
}
