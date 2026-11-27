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
    messages.reduce(
      (total, message) =>
        total +
        message.content.reduce(
          (sum, block) =>
            sum +
            (block.type === "image"
              ? 128 +
                170 *
                  Math.ceil(block.image.width / 512) *
                  Math.ceil(block.image.height / 512)
              : 0),
          0,
        ),
      0,
    ) +
    estimateTokens(tools) +
    messages.length * 8 +
    16
  );
}
