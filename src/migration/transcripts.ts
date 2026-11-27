import type { ChatMessage } from "../types/domain.js";
import type { ForeignSession } from "./contracts.js";
import { file, record, string } from "./files.js";

export function date(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result.toISOString() : undefined;
}

export function addText(
  messages: ChatMessage[],
  role: unknown,
  parts: unknown,
) {
  if (role !== "user" && role !== "assistant") return;
  const values = Array.isArray(parts) ? parts : [parts];
  const content = values.flatMap((value) => {
    const block = record(value);
    const text =
      string(value) ??
      (["text", "input_text", "output_text"].includes(String(block.type)) &&
      !block.synthetic &&
      !block.ignored
        ? string(block.text)
        : undefined);
    return text &&
      !/^\s*(?:<local-command|<command-name>|<environment_context>|<user_instructions>|# AGENTS\.md instructions for)/.test(
        text,
      )
      ? [{ type: "text" as const, text }]
      : [];
  });
  if (content.length) messages.push({ role, content });
}

export async function readJsonlSession(
  path: string,
  source: "claude" | "codex",
): Promise<ForeignSession | undefined> {
  const data = await file(path, 32 * 1024 * 1024);
  const session: ForeignSession = { id: "", path: "", messages: [] };
  for (const line of data.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      // The other CLI may still be appending the last event.
      continue;
    }
    if (source === "claude") {
      if (event.isSidechain) continue;
      session.id ||= string(event.sessionId) ?? "";
      session.path ||= string(event.cwd) ?? "";
      session.title = string(event.customTitle) ?? session.title;
      const message = record(event.message);
      if (event.type === "assistant")
        session.model = string(message.model) ?? session.model;
      if (
        (event.type === "user" || event.type === "assistant") &&
        !event.isMeta &&
        !event.isCompactSummary
      )
        addText(session.messages, event.type, message.content);
    } else {
      const payload = record(event.payload);
      if (event.type === "session_meta") {
        session.id ||= string(payload.id) ?? "";
        session.path ||= string(payload.cwd) ?? "";
        session.created ??= date(payload.timestamp);
        session.provider ??= string(payload.model_provider);
      } else if (event.type === "turn_context") {
        session.path ||= string(payload.cwd) ?? "";
        session.model = string(payload.model) ?? session.model;
      } else if (event.type === "response_item" && payload.type === "message")
        addText(session.messages, payload.role, payload.content);
    }
    session.created ??= date(event.timestamp);
    session.updated = date(event.timestamp) ?? session.updated;
  }
  return session.id && session.path && session.messages.length
    ? session
    : undefined;
}
