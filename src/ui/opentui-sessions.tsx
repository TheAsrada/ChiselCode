/** @jsxImportSource @opentui/react */

import { useKeyboard, usePaste } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../sessions/project-store.js";
import type { Session } from "../types/domain.js";
import { type Palette, THEMES } from "./appearance.js";
import { cleanSettingsInput } from "./opentui-settings-input.js";
import { terminalSafeText } from "./opentui-transcript.js";
import { filterSessions } from "./session-filter.js";
import { clipText, terminalLine } from "./terminal-text.js";

export interface OpenTuiSessionsActions {
  load(): Promise<SessionSummary[]>;
  preview(id: string): Promise<Session>;
  resume(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
  activeId(): string | undefined;
}

function previewLines(session: Session): Array<{ id: number; line: string }> {
  const result: Array<{ id: number; line: string }> = [];
  for (
    let id = session.messages.length - 1;
    id >= 0 && result.length < 3;
    id--
  ) {
    const message = session.messages[id];
    if (!message) continue;
    const text = message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join(" ");
    if (text)
      result.push({
        id,
        line: `${message.role === "user" ? "Вы" : "Ассистент"}: ${terminalSafeText(text, 140).replace(/\s+/g, " ")}`,
      });
  }
  return result.reverse();
}

export function OpenTuiSessions({
  actions,
  width,
  height,
  palette = THEMES.obsidian,
  onClose,
}: {
  actions: OpenTuiSessionsActions;
  width: number;
  height: number;
  palette?: Palette;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(0);
  const [preview, setPreview] = useState<Session>();
  const [mode, setMode] = useState<"search" | "rename" | "delete">("search");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const previewTicket = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    void actions
      .load()
      .then((items) => {
        if (live) setSessions(items);
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      });
    return () => {
      live = false;
      mounted.current = false;
      previewTicket.current++;
    };
  }, [actions]);

  const filtered = useMemo(
    () => filterSessions(sessions, query),
    [sessions, query],
  );
  const selected = filtered[Math.min(selection, filtered.length - 1)];
  const changeSelection = (next: number) => {
    setSelection(Math.max(0, Math.min(filtered.length - 1, next)));
    previewTicket.current++;
    setPreview(undefined);
  };
  const run = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    void work()
      .catch((cause) => {
        if (mounted.current) setError(String(cause));
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  useKeyboard((key) => {
    if (busy) return;
    const name = key.name.toLowerCase();
    if (mode === "delete") {
      if ((name === "y" || name === "н") && selected)
        run(async () => {
          await actions.delete(selected.id);
          const items = await actions.load();
          if (!mounted.current) return;
          setSessions(items);
          changeSelection(0);
          setMode("search");
        });
      else setMode("search");
      return;
    }
    if (mode === "rename") {
      if (name === "escape") setMode("search");
      else if (name === "return" && selected)
        run(async () => {
          const title = draft.trim();
          if (!title) throw new Error("Название не может быть пустым");
          await actions.rename(selected.id, title);
          const items = await actions.load();
          if (!mounted.current) return;
          setSessions(items);
          setMode("search");
        });
      else if (name === "backspace" || name === "delete")
        setDraft((value) => clipText(value, value.length - 1));
      else if (
        !key.ctrl &&
        !key.meta &&
        [...key.sequence].length === 1 &&
        cleanSettingsInput(key.sequence)
      )
        setDraft((value) => value + key.sequence);
      return;
    }
    if (name === "escape") {
      if (query) {
        setQuery("");
        changeSelection(0);
      } else onClose();
    } else if (name === "up") changeSelection(selection - 1);
    else if (name === "down") changeSelection(selection + 1);
    else if (name === "return" && selected)
      run(async () => {
        await actions.resume(selected.id);
        onClose();
      });
    else if (key.ctrl && name === "r" && selected) {
      setDraft(selected.title);
      setMode("rename");
    } else if (key.ctrl && name === "d" && selected) setMode("delete");
    else if (name === "space" && selected) {
      const ticket = ++previewTicket.current;
      if (preview?.id === selected.id) setPreview(undefined);
      else
        run(async () => {
          const item = await actions.preview(selected.id);
          if (mounted.current && ticket === previewTicket.current)
            setPreview(item);
        });
    } else if (name === "backspace" || name === "delete") {
      setQuery((value) => clipText(value, value.length - 1));
      changeSelection(0);
    } else if (
      !key.ctrl &&
      !key.meta &&
      [...key.sequence].length === 1 &&
      cleanSettingsInput(key.sequence)
    ) {
      setQuery((value) => value + key.sequence);
      changeSelection(0);
    }
  });

  usePaste((event) => {
    event.preventDefault();
    if (busy || mode === "delete") return;
    const text = cleanSettingsInput(new TextDecoder().decode(event.bytes));
    if (mode === "rename") setDraft((value) => value + text);
    else {
      setQuery((value) => value + text);
      changeSelection(0);
    }
  });

  const listHeight = Math.max(1, height - (preview ? 10 : 7));
  const start = Math.max(
    0,
    Math.min(
      selection - Math.floor(listHeight / 2),
      filtered.length - listHeight,
    ),
  );
  return (
    <box
      width={width}
      height={height}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={palette.bg}
    >
      <text fg={palette.accent}>Возобновить сессию</text>
      <text fg={palette.text}>Поиск: {terminalSafeText(query, 120)}|</text>
      <text fg={palette.muted}>{filtered.length} сессий</text>
      <box height={listHeight} flexDirection="column">
        {filtered.length === 0 && (
          <text fg={palette.muted}>Сессий нет. Начните новый разговор.</text>
        )}
        {filtered.slice(start, start + listHeight).map((item, index) => (
          <text
            key={item.id}
            fg={start + index === selection ? palette.accent : palette.muted}
          >
            {start + index === selection ? "> " : "  "}
            {terminalLine(
              item.title.replace(/\s+/g, " "),
              Math.max(8, width - 29),
            )}{" "}
            | {item.messageCount} сообщ.{" "}
            {item.id === actions.activeId() ? "*" : ""}
          </text>
        ))}
      </box>
      {selected && (
        <text fg={palette.muted}>
          {terminalSafeText(selected.model, 60)} | {selected.providerId} |{" "}
          {selected.totalTokens.inputTokens + selected.totalTokens.outputTokens}{" "}
          токенов
        </text>
      )}
      {preview &&
        previewLines(preview).map(({ id, line }) => (
          <text key={`${preview.id}:${id}`} fg={palette.muted}>
            {line}
          </text>
        ))}
      {mode === "rename" && (
        <text fg={palette.yellow}>
          Новое название: {terminalSafeText(draft, 120)}|
        </text>
      )}
      {mode === "delete" && (
        <text fg={palette.yellow}>
          Удалить '{terminalSafeText(selected?.title ?? "", 80)}'? [y/N]
        </text>
      )}
      {error && <text fg={palette.red}>{terminalSafeText(error, 200)}</text>}
      <text fg={palette.muted}>
        {width < 80
          ? "Up/Down выбор | Enter | Space | Ctrl+R/D | Esc"
          : "Up/Down выбор | Enter продолжить | Space просмотр | Ctrl+R имя | Ctrl+D удалить | Esc"}
      </text>
    </box>
  );
}
