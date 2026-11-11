import { estimateTokens } from "../context/tokenizer.js";
import type { ToolResultStore } from "../context/tool-result-store.js";
import { runtimeError } from "../runtime/errors.js";
import type { ToolExecutionResult } from "../types/domain.js";
import { clipText, failureLine, utf8Prefix } from "../utils/text.js";
import { shellSummary } from "./shell-result.js";
export function failure(error: unknown): ToolExecutionResult {
  const typed = runtimeError(error);
  const rollback =
    typed.code === "PATCH_PARTIAL_FAILURE"
      ? `\nApplied: ${JSON.stringify(typed.details?.applied ?? [])}\nRolled back: ${JSON.stringify(typed.details?.rolledBack ?? [])}\nRollback failed: ${JSON.stringify(typed.details?.rollbackFailed ?? [])}`
      : "";
  return {
    output: `${typed.code}: ${typed.message}${rollback}`,
    isError: true,
    errorCode: typed.code,
    details: typed.details,
  };
}
export async function normalizeResult(
  result: ToolExecutionResult,
  store: ToolResultStore,
  maxTokens = 10_000,
): Promise<ToolExecutionResult> {
  const summary = shellSummary(result);
  if (summary && !result.output.startsWith(summary))
    result = { ...result, output: `${summary}\n${result.output}` };
  const raw = result.rawOutput ?? result.output;
  const { rawOutput: _raw, ...normalized } = result;
  if (
    estimateTokens(raw) <= maxTokens &&
    estimateTokens(result.output) <= maxTokens
  )
    return normalized;
  const artifact = await store.put(raw, result.contentTrust);
  // A short failure must remain visible even when its traceback is in the artifact.
  const failureReason = result.isError
    ? clipText(failureLine(raw) ?? "", 400)
    : "";
  const shell = result.details?.shell as Record<string, unknown> | undefined;
  const suffix = shell
    ? `\nПоказан фрагмент. ${shell.captureComplete ? "Полный захваченный лог" : "Сохранённая часть лога; захват неполный"}: ${artifact.uri}\nИспользуйте read_tool_result с диапазоном строк.`
    : `\nOutput offloaded. Full output: ${artifact.uri}\nUse read_tool_result with a line range.`;
  const prefix = summary ? `${summary}\n` : "";
  let preview = utf8Prefix(
    summary ? result.output.slice(prefix.length) : result.output,
    Math.max(
      0,
      Math.min(4000, maxTokens * 3 - Buffer.byteLength(prefix + suffix)),
    ),
  );
  while (preview && estimateTokens(prefix + preview + suffix) > maxTokens)
    preview = clipText(preview, preview.length - 1);
  return {
    ...normalized,
    details: {
      ...normalized.details,
      ...(failureReason ? { failureReason } : {}),
      ...(shell ? { shell: { ...shell, outputOffloaded: true } } : {}),
    },
    output: prefix + preview + suffix,
    artifact,
  };
}
