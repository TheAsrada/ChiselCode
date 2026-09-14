import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "../types/domain.js";

function userDataDir(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA
      ? join(process.env.APPDATA, "chiselcode")
      : join(process.env.USERPROFILE ?? process.cwd(), ".chiselcode");
  }
  return join(
    process.env.XDG_CONFIG_HOME ??
      join(process.env.HOME ?? process.cwd(), ".config"),
    "chiselcode",
  );
}

export function sessionsDirectory(): string {
  return join(userDataDir(), "sessions");
}

export function sessionPath(id: string): string {
  return join(sessionsDirectory(), `${id}.json`);
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
  await mkdir(sessionsDirectory(), { recursive: true });
  session.updatedAt = new Date().toISOString();
  const destination = sessionPath(session.id);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

export async function loadSession(id: string): Promise<Session> {
  const source = await readFile(sessionPath(id), "utf8");
  return JSON.parse(source) as Session;
}

export async function listSessions(projectPath?: string): Promise<Session[]> {
  const directory = sessionsDirectory();
  try {
    const files = await Array.fromAsync(
      new Bun.Glob("*.json").scan({ cwd: directory, absolute: true }),
    );
    const sessions = await Promise.all(
      files.map(
        async (file) => JSON.parse(await readFile(file, "utf8")) as Session,
      ),
    );
    return sessions
      .filter((session) => !projectPath || session.projectPath === projectPath)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function deleteSession(id: string): Promise<void> {
  await rm(sessionPath(id), { force: true });
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
