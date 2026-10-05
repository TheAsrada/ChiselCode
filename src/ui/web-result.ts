import type { ToolExecutionResult } from "../types/domain.js";
import { searchBackendLabel } from "../web/search.js";
import { terminalSafeText } from "./opentui-transcript.js";

/** Transcript metadata is durable; page text belongs in artifacts/model tool results. */
export function webResultSummary(
  result: ToolExecutionResult,
): string | undefined {
  const web = result.details?.web;
  if (!web || typeof web !== "object") return;
  const data = web as Record<string, unknown>;
  const suffix = result.artifact ? " · полный текст в artifact" : "";
  if (data.action === "search" && Array.isArray(data.results)) {
    const routing =
      data.routing && typeof data.routing === "object"
        ? (data.routing as Record<string, unknown>)
        : undefined;
    const switched =
      routing?.mode === "auto" &&
      Array.isArray(routing.attempted) &&
      routing.attempted.length > 1;
    const service = data.provider
      ? ` · ${terminalSafeText(searchBackendLabel(String(data.provider)), 32)}`
      : "";
    return `Поиск в интернете${service}${switched ? " · Авто" : ""} · ${data.results.length} результатов\n  ${terminalSafeText(String(data.query ?? ""), 240)}${suffix}`;
  }
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
