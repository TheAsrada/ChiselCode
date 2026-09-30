import { RuntimeError } from "../runtime/errors.js";
import type { ChatMessage } from "../types/domain.js";
export interface ProtocolUnit {
  start: number;
  end: number;
  messages: ChatMessage[];
  pending: boolean;
}
export function partitionTranscript(messages: ChatMessage[]): ProtocolUnit[] {
  const units: ProtocolUnit[] = [];
  const pending = new Set<string>();
  let start = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    for (const item of message.content) {
      if (item.type === "tool_use") {
        if (message.role !== "assistant" || pending.has(item.id))
          throw new RuntimeError(
            "PROTOCOL_ERROR",
            "Invalid assistant tool-call protocol.",
          );
        pending.add(item.id);
      } else if (item.type === "tool_result") {
        if (message.role !== "user" || !pending.delete(item.toolUseId))
          throw new RuntimeError(
            "PROTOCOL_ERROR",
            `Orphan tool result: ${item.toolUseId}`,
          );
      }
    }
    if (pending.size === 0) {
      units.push({
        start,
        end: index + 1,
        messages: messages.slice(start, index + 1),
        pending: false,
      });
      start = index + 1;
    }
  }
  if (start < messages.length)
    units.push({
      start,
      end: messages.length,
      messages: messages.slice(start),
      pending: true,
    });
  return units;
}
