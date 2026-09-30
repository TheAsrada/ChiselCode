import { RuntimeError } from "../runtime/errors.js";
import type { Session } from "../types/domain.js";
import { partitionTranscript } from "./partition.js";
import { summaryText } from "./summary.js";
export function assembleMessages(session: Session) {
  const checkpoint = session.context?.activeCheckpoint;
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
            { type: "text" as const, text: summaryText(checkpoint.summary) },
          ],
        },
        ...session.messages.slice(checkpoint.throughMessageIndex),
      ]
    : session.messages.slice();
}
