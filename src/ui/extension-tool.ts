import type { ToolSource } from "../tools/types.js";
import type { ToolExecutionResult } from "../types/domain.js";
import { terminalSafeText } from "./terminal-text.js";

export function extensionToolLabel(source?: ToolSource): string | undefined {
  return source?.type === "extension"
    ? `[extension] ${terminalSafeText(source.extensionId)} · ${terminalSafeText(source.originalName)}`
    : undefined;
}
export function extensionResultLabel(
  result: ToolExecutionResult,
): string | undefined {
  const source = result.details?.extension;
  if (
    !source ||
    typeof source !== "object" ||
    !("id" in source) ||
    !("tool" in source) ||
    typeof source.id !== "string" ||
    typeof source.tool !== "string"
  )
    return undefined;
  return extensionToolLabel({
    type: "extension",
    extensionId: source.id,
    originalName: source.tool,
  });
}
