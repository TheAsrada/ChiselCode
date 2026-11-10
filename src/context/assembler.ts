import { RuntimeError } from "../runtime/errors.js";
import type { ChatMessage, Session } from "../types/domain.js";
import { partitionTranscript } from "./partition.js";
import { summaryText } from "./summary.js";

/** Resume can append B after A/C. Order provider results without rewriting history. */
function orderToolResults(messages: ChatMessage[]): ChatMessage[] {
  return partitionTranscript(messages).flatMap((unit) => {
    if (unit.pending) return unit.messages;
    const content = unit.messages.flatMap((message) => message.content);
    const results = new Map(
      content
        .filter((item) => item.type === "tool_result")
        .map((item) => [item.toolUseId, item]),
    );
    if (results.size < 2) return unit.messages;
    const ordered = content
      .filter((item) => item.type === "tool_use")
      .map((item) => results.get(item.id));
    let next = 0;
    return unit.messages.map((message) => ({
      ...message,
      content: message.content.map((item) =>
        item.type === "tool_result" ? (ordered[next++] ?? item) : item,
      ),
    }));
  });
}
export function assembleMessages(session: Session) {
  const checkpoint = session.context?.activeCheckpoint;
  const pinnedIndex = checkpoint?.preservedUserMessageIndex;
  const pinned =
    pinnedIndex === undefined ? undefined : session.messages[pinnedIndex];
  const tail = orderToolResults(
    session.messages.slice(checkpoint?.throughMessageIndex ?? 0),
  );
  const hasNewerUserRequest = tail.some(
    (message) =>
      message.role === "user" &&
      message.content.length > 0 &&
      message.content.every((item) => item.type === "text"),
  );
  if (
    pinnedIndex !== undefined &&
    (!checkpoint ||
      pinnedIndex >= checkpoint.throughMessageIndex ||
      pinned?.role !== "user" ||
      pinned.content.some((item) => item.type !== "text"))
  )
    throw new RuntimeError(
      "PROTOCOL_ERROR",
      "Invalid preserved user request in context checkpoint.",
    );
  if (
    checkpoint &&
    checkpoint.throughMessageIndex !== 0 &&
    !partitionTranscript(session.messages).some(
      (unit) => !unit.pending && unit.end === checkpoint.throughMessageIndex,
    )
  )
    throw new RuntimeError(
      "PROTOCOL_ERROR",
      "Context checkpoint splits a tool protocol unit.",
    );
  return checkpoint
    ? [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: `The earlier conversation was compacted. Continue the same task using this handoff and the recent messages below.\n<context_summary>\n${summaryText(checkpoint.summary)}\n</context_summary>`,
            },
          ],
        },
        ...(pinned && !hasNewerUserRequest ? [pinned] : []),
        ...tail,
      ]
    : tail;
}
