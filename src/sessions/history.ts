import {
  ProjectSessionStore,
  SessionProjectRegistry,
  type SessionSummary,
} from "./project-store.js";

export type HistorySummary = SessionSummary & {
  sessionId: string;
  projectName: string;
  projectPath: string;
};

export interface HistoryEntry {
  summary: HistorySummary;
  store: ProjectSessionStore;
}

/** Application history reads existing stores without admitting roots or repairing indexes. */
export class SessionHistoryCatalog {
  private entries = new Map<string, HistoryEntry>();

  async list(): Promise<HistoryEntry[]> {
    const entries: HistoryEntry[] = [];
    for (const project of await new SessionProjectRegistry().list()) {
      const store = new ProjectSessionStore(project);
      for (const summary of await store.listReadonly()) {
        if (summary.subagentOwnerId || summary.backgroundOwnerId) continue;
        entries.push({
          store,
          summary: {
            ...summary,
            id: `${project.id}:${summary.id}`,
            sessionId: summary.id,
            projectName: project.name,
            projectPath: project.path,
          },
        });
      }
    }
    entries.sort((a, b) =>
      b.summary.updatedAt.localeCompare(a.summary.updatedAt),
    );
    this.entries = new Map(entries.map((entry) => [entry.summary.id, entry]));
    return entries;
  }

  async resolve(ref: string): Promise<HistoryEntry> {
    // Composite refs preserve project identity even when legacy UUIDs were copied.
    const cached = this.entries.get(ref);
    if (cached) return cached;
    const value = ref.trim().toLowerCase();
    if (!/^[\da-f-]+(?::[\da-f-]+)?$/.test(value))
      throw new Error("Некорректный ID сессии.");
    const matches = (await this.list()).filter(
      ({ summary }) =>
        summary.id.toLowerCase() === value ||
        summary.sessionId.toLowerCase().startsWith(value),
    );
    if (!matches.length) throw new Error(`Сессия «${ref}» не найдена.`);
    if (matches.length > 1)
      throw new Error(
        `Префикс «${ref}» неоднозначен: ${matches.length} сессий.`,
      );
    return matches[0] as HistoryEntry;
  }
}
