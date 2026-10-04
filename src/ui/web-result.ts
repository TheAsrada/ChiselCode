import type { ToolExecutionResult } from "../types/domain.js";
import { terminalSafeText } from "./opentui-transcript.js";

/** Transcript metadata is durable; page text belongs in artifacts/model tool results. */
export function webResultSummary(
  result: ToolExecutionResult,
): string | undefined {
  const web = result.details?.web;
  if (!web || typeof web !== "object") return;
  const data = web as Record<string, unknown>;
  const suffix = result.artifact ? " · полный текст в artifact" : "";
  if (data.action === "search" && Array.isArray(data.results))
    return `Поиск в интернете · ${data.results.length} результатов\n  ${terminalSafeText(String(data.query ?? ""), 240)}${suffix}`;
  if (
    data.action === "fetch" &&
    data.source &&
    typeof data.source === "object"
  ) {
    const source = data.source as Record<string, unknown>;
    const url = terminalSafeText(String(source.finalUrl ?? ""), 4096);
    let domain = "Web";
    try {
      domain = new URL(url).hostname;
    } catch {}
    const size =
      typeof data.extractedBytes === "number"
        ? ` · ${(data.extractedBytes / 1024).toFixed(1)} KB`
        : "";
    return `Открыто · ${domain}${data.cached ? " · из кеша" : ""}\n  ${terminalSafeText(String(source.title ?? domain), 240)}${size}\n  ${url}${suffix}`;
  }
}
