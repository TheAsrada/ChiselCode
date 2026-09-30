import { randomUUID } from "node:crypto";
import type { Session } from "../types/domain.js";
import { partitionTranscript } from "./partition.js";
import { summarize } from "./summary.js";
import { estimateTokens } from "./tokenizer.js";
export function compactProjection(
  session: Session,
  keepRecentTokens: number,
): boolean {
  const old = session.context?.activeCheckpoint;
  const units = partitionTranscript(session.messages).filter(
    (unit) => unit.end > (old?.throughMessageIndex ?? 0),
  );
  let retained = 0;
  let boundary = session.messages.length;
  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index];
    if (!unit) continue;
    const size = estimateTokens(unit.messages);
    // Preserve the newest user turn and every unresolved invocation even in emergency compaction.
    if (
      unit.pending ||
      index === units.length - 1 ||
      retained + size <= keepRecentTokens
    ) {
      retained += size;
      boundary = unit.start;
    } else break;
  }
  if (boundary <= (old?.throughMessageIndex ?? 0)) return false;
  const summary = summarize(
    session.messages.slice(old?.throughMessageIndex ?? 0, boundary),
    old?.summary,
  );
  for (const entry of session.undoStack)
    summary.changedFiles[entry.path] =
      entry.after === null
        ? "deleted"
        : entry.before === null
          ? "created"
          : "updated";
  session.context ??= {};
  session.context.activeCheckpoint = {
    id: randomUUID(),
    summary,
    throughMessageIndex: boundary,
    createdAt: new Date().toISOString(),
    estimatedTokens: estimateTokens(summary),
  };
  return true;
}
