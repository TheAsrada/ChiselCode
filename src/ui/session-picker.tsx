import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { SessionSummary } from "../sessions/project-store.js";
import type { Session } from "../types/domain.js";

export function filterSessions(
  sessions: SessionSummary[],
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
        item.provider,
        item.id,
      ]
        .join(" ")
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function relativeTime(iso: string): string {
  const delta = Math.max(0, Date.now() - Date.parse(iso));
  if (delta < 60_000) return "сейчас";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} мин`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} ч`;
  return `${Math.floor(delta / 86_400_000)} д`;
}
function previewLines(session: Session): string[] {
  return session.messages
    .filter((message) => message.content.some((item) => item.type === "text"))
    .slice(-3)
    .map(
      (message) =>
        `${message.role === "user" ? "Вы" : "Ассистент"}: ${message.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join(" ")
          .slice(0, 140)}`,
    );
}
export interface SessionPickerProps {
  sessions: SessionSummary[];
  activeId?: string;
  rows: number;
  onClose(): void;
  onResume(id: string): Promise<void>;
  onPreview(id: string): Promise<Session>;
  onRename(id: string, title: string): Promise<void>;
  onDelete(id: string): Promise<void>;
  onRefresh(): Promise<void>;
}
export function SessionPicker(props: SessionPickerProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(0);
  const [preview, setPreview] = useState<Session>();
  const [mode, setMode] = useState<"search" | "rename" | "delete">("search");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const filtered = useMemo(
    () => filterSessions(props.sessions, query),
    [props.sessions, query],
  );
  const selected = filtered[Math.min(selection, filtered.length - 1)];
  useInput((character, key) => {
    if (mode === "rename") {
      if (key.escape) {
        setMode("search");
        return;
      }
      if (key.return) {
        if (selected)
          void props
            .onRename(selected.id, draft)
            .then(() => props.onRefresh())
            .then(() => setMode("search"))
            .catch((cause) => setError(String(cause)));
        return;
      }
      if (key.backspace || key.delete) setDraft((value) => value.slice(0, -1));
      else if (!key.ctrl && !key.meta && character)
        setDraft((value) => value + character);
      return;
    }
    if (mode === "delete") {
      if (character.toLowerCase() === "y" || character.toLowerCase() === "н") {
        if (selected)
          void props
            .onDelete(selected.id)
            .then(() => props.onRefresh())
            .then(() => {
              setSelection(0);
              setPreview(undefined);
              setMode("search");
            })
            .catch((cause) => setError(String(cause)));
      } else setMode("search");
      return;
    }
    if (key.escape) {
      if (query) {
        setQuery("");
        setSelection(0);
      } else props.onClose();
      return;
    }
    if (key.upArrow) {
      setSelection((value) => Math.max(0, value - 1));
      setPreview(undefined);
      return;
    }
    if (key.downArrow) {
      setSelection((value) =>
        Math.max(0, Math.min(filtered.length - 1, value + 1)),
      );
      setPreview(undefined);
      return;
    }
    if (key.return) {
      if (selected)
        void props
          .onResume(selected.id)
          .catch((cause) => setError(String(cause)));
      return;
    }
    if (key.ctrl && character.toLowerCase() === "r") {
      if (selected) {
        setDraft(selected.title);
        setMode("rename");
      }
      return;
    }
    if (key.ctrl && character.toLowerCase() === "d") {
      if (selected) setMode("delete");
      return;
    }
    if (character === " ") {
      if (selected)
        void props
          .onPreview(selected.id)
          .then((item) =>
            setPreview(preview?.id === item.id ? undefined : item),
          )
          .catch((cause) => setError(String(cause)));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((value) => value.slice(0, -1));
      setSelection(0);
      return;
    }
    if (!key.ctrl && !key.meta && character) {
      setQuery((value) => value + character);
      setSelection(0);
      setPreview(undefined);
    }
  });
  const maxItems = Math.max(1, Math.min(filtered.length, props.rows - 13));
  const start = Math.max(
    0,
    Math.min(selection - Math.floor(maxItems / 2), filtered.length - maxItems),
  );
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width="100%"
      height={Math.max(8, props.rows - 1)}
    >
      <Text bold>Возобновить сессию</Text>
      <Text>Поиск: {query}█</Text>
      <Text dimColor>{filtered.length} сессий</Text>
      {filtered.length === 0 ? (
        <Text dimColor>Сессий нет. Начните новый разговор.</Text>
      ) : (
        filtered.slice(start, start + maxItems).map((item, index) => (
          <Text
            key={item.id}
            color={start + index === selection ? "cyan" : undefined}
            wrap="truncate-end"
          >
            {start + index === selection ? "❯" : " "} {item.title}{" "}
            {item.gitBranch ? `· ${item.gitBranch}` : ""} ·{" "}
            {relativeTime(item.updatedAt)} · {item.messageCount} сообщ.{" "}
            {item.id === props.activeId ? "● текущая" : ""}
          </Text>
        ))
      )}
      {selected ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{selected.title}</Text>
          <Text dimColor>
            {selected.model} · {selected.provider} ·{" "}
            {selected.gitBranch ?? "без ветки"} ·{" "}
            {selected.totalTokens.inputTokens +
              selected.totalTokens.outputTokens}{" "}
            токенов
          </Text>
        </Box>
      ) : null}
      {preview ? (
        <Box flexDirection="column">
          <Text dimColor>
            ID: {preview.id} · Создана: {preview.createdAt} · Обновлена:{" "}
            {preview.updatedAt}
          </Text>
          {previewLines(preview).map((line) => (
            <Text key={line} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      {mode === "rename" ? (
        <Text color="yellow">Новое название: {draft}█</Text>
      ) : null}
      {mode === "delete" ? (
        <Text color="yellow">
          Удалить «{selected?.title}»? Файлы проекта останутся. [y/N]
        </Text>
      ) : null}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        ↑/↓ выбор · Enter продолжить · Space просмотр · Ctrl+R имя · Ctrl+D
        удалить · Esc закрыть
      </Text>
    </Box>
  );
}
