import type { ToolExecutionResult } from "../types/domain.js";
import type { McpCallResult } from "./connection.js";
import type { McpRedactor } from "./redaction.js";

export function normalizeMcpResult(
  result: McpCallResult,
  redactor: McpRedactor,
  display: { server: string; tool: string },
): ToolExecutionResult {
  const pieces: string[] = [];
  for (const content of result.content ?? []) {
    if (content.type === "text" && content.text) pieces.push(content.text);
    else if (content.type === "resource" && content.resource?.text)
      pieces.push(content.resource.text);
    else if (content.type === "resource_link")
      pieces.push(`Resource: ${content.uri ?? ""}`);
    else
      pieces.push(
        `[${content.type}${content.mimeType ? ` · ${content.mimeType}` : ""}: binary content omitted]`,
      );
  }
  if (result.structuredContent !== undefined)
    pieces.push(
      JSON.stringify(redactor.value(result.structuredContent), null, 2),
    );
  const output = redactor.text(
    pieces.join("\n\n") ||
      (result.isError
        ? "MCP server reported a tool failure."
        : "Operation completed."),
  );
  // Structured content remains readable in the same artifact as text. Do not
  // duplicate an arbitrarily large object in persisted invocation metadata.
  return {
    output,
    isError: result.isError,
    errorCode: result.isError ? "MCP_TOOL_CALL_FAILED" : undefined,
    details: { mcp: display, retryable: false },
  };
}
