import type { ChatMessage, ToolDefinition } from "../types/domain.js";
/** Conservative UTF-8 estimate, explicitly not a claim about an unknown model's window. */
export function estimateTokens(value: string | unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(Buffer.byteLength(text ?? "", "utf8") / 3);
}
export function requestTokens(
  system: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
): number {
  return (
    estimateTokens(system) +
    estimateTokens(messages) +
    estimateTokens(tools) +
    messages.length * 8 +
    16
  );
}
