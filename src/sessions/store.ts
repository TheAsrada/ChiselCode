import { createHash, randomUUID } from "node:crypto";
import { sessionsRootDir } from "../paths/home.js";
import type { Session } from "../types/domain.js";
import { assertSessionId, projectSessionStore } from "./project-store.js";

export function sessionsDirectory(): string {
  return sessionsRootDir();
}
export function createSession(
  projectPath: string,
  provider: Session["provider"],
  model: string,
): Session {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectPath,
    messages: [],
    provider,
    model,
    title: "Без названия",
    titleSource: "auto",
    totalTokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    totalCost: 0,
    undoStack: [],
    createdAt: now,
    updatedAt: now,
  };
}
export async function saveSession(session: Session): Promise<void> {
  await (await projectSessionStore(session.projectPath)).save(session);
}
export async function loadSession(
  id: string,
  projectPath = process.cwd(),
): Promise<Session> {
  return (await projectSessionStore(projectPath)).load(assertSessionId(id));
}
export async function listSessions(
  projectPath = process.cwd(),
): Promise<Session[]> {
  const store = await projectSessionStore(projectPath);
  const summaries = await store.list();
  const results = await Promise.allSettled(
    summaries.map((item) => store.load(item.id)),
  );
  return results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
}
export async function deleteSession(
  id: string,
  projectPath = process.cwd(),
): Promise<void> {
  await (await projectSessionStore(projectPath)).delete(assertSessionId(id));
}
export function estimateCost(
  provider: Session["provider"],
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (provider !== "anthropic") return 0;
  const rates = model.includes("opus")
    ? { input: 5, output: 25 }
    : model.includes("sonnet")
      ? { input: 2, output: 10 }
      : { input: 1, output: 5 };
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

export function stableSessionFingerprint(session: Session): string {
  return createHash("sha256")
    .update(JSON.stringify(session.messages))
    .digest("hex")
    .slice(0, 12);
}

/** Короткий id для показа: первые 8 символов UUID. */
export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

/** Название сессии из промпта: первая строка, до 60 символов. */
export function sessionTitleForPrompt(prompt: string): string {
  const first = prompt.split("\n", 1)[0]?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

function formatSessionDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${day}.${month} ${hours}:${minutes}`;
}

/** Человекочитаемый список сессий для `/sessions` (порядок — как в хранилище). */
export function formatSessionList(sessions: Session[]): string {
  if (sessions.length === 0)
    return "Сессий этого проекта пока нет. Новое сообщение начнёт первую.";
  const lines = sessions.map((session, index) => {
    const title = session.title?.trim() || "без названия";
    const tokens =
      session.totalTokens.inputTokens + session.totalTokens.outputTokens;
    return (
      `${index + 1}. ${title} · ${session.model} · ` +
      `${session.messages.length} сообщ. · ${tokens} токенов · ` +
      `${formatSessionDate(session.updatedAt)} · ${shortSessionId(session.id)}`
    );
  });
  return ["Сессии проекта:", ...lines].join("\n");
}

/**
 * Поиск сессии по номеру из `/sessions` (1-based) или префиксу id.
 * Возвращает undefined, если ничего не подошло.
 */
export function resolveSessionRef(
  sessions: Session[],
  ref: string,
): Session | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  const byIndex = Number.parseInt(trimmed, 10);
  if (
    Number.isInteger(byIndex) &&
    String(byIndex) === trimmed &&
    byIndex >= 1 &&
    byIndex <= sessions.length
  )
    return sessions[byIndex - 1];
  const lowered = trimmed.toLowerCase();
  return sessions.find((session) =>
    session.id.toLowerCase().startsWith(lowered),
  );
}
