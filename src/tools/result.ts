import { estimateTokens } from "../context/tokenizer.js";
import type { ToolResultStore } from "../context/tool-result-store.js";
import { runtimeError } from "../runtime/errors.js";
import type { ToolExecutionResult } from "../types/domain.js";
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
  const raw = result.rawOutput ?? result.output;
  const { rawOutput: _raw, ...normalized } = result;
  if (
    estimateTokens(raw) <= maxTokens &&
    estimateTokens(result.output) <= maxTokens
  )
    return normalized;
  const artifact = await store.put(raw, result.contentTrust);
  const suffix = `\nOutput offloaded. Full output: ${artifact.uri}\nUse read_tool_result with a line range.`;
  let preview = Buffer.from(result.output)
    .subarray(
      0,
      Math.max(0, Math.min(4000, maxTokens * 3 - Buffer.byteLength(suffix))),
    )
    .toString("utf8");
  while (preview && estimateTokens(preview + suffix) > maxTokens)
    preview = preview.slice(0, -1);
  return {
    ...normalized,
    output: preview + suffix,
    artifact,
  };
}
