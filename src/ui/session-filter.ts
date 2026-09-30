import type { SessionSummary } from "../sessions/project-store.js";

export function filterSessions(
  sessions: readonly SessionSummary[],
  query: string,
): SessionSummary[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return sessions
    .filter((item) => {
      const haystack = [
        item.title,
        item.lastUserMessage,
        item.gitBranch,
        item.model,
        item.providerId,
        item.id,
      ]
        .join(" ")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
