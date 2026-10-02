import { RuntimeError } from "../runtime/errors.js";
import type { Session } from "../types/domain.js";
import { partitionTranscript } from "./partition.js";
import { summaryText } from "./summary.js";
export function assembleMessages(session: Session) {
  const checkpoint = session.context?.activeCheckpoint;
  const pinnedIndex = checkpoint?.preservedUserMessageIndex;
  const pinned =
    pinnedIndex === undefined ? undefined : session.messages[pinnedIndex];
  const tail = session.messages.slice(checkpoint?.throughMessageIndex ?? 0);
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
    : session.messages.slice();
}
