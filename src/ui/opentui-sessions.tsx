/** @jsxImportSource @opentui/react */

import type { InputRenderable } from "@opentui/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../sessions/project-store.js";
import type { Session } from "../types/domain.js";
import { type Palette, THEMES } from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { FormattedMessage } from "./opentui-message.js";
import { cleanSettingsInput } from "./opentui-settings-input.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { filterSessions } from "./session-filter.js";
import { terminalLine, terminalSafeText } from "./terminal-text.js";

export type HistorySummary = SessionSummary & {
  sessionId?: string;
  projectName?: string;
  projectPath?: string;
  archive?: boolean;
};
export interface OpenTuiSessionsActions {
  load(): Promise<HistorySummary[]>;
  preview(id: string): Promise<Session>;
  resume(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
  activeId(): string | undefined;
}

function excerpts(session: Session) {
  return session.messages
    .map((message, index) => ({
      index,
      role: message.role === "user" ? "ВЫ" : "АССИСТЕНТ",
      text: message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(" "),
    }))
    .filter((message) => message.text)
    .slice(-3);
}

function dateLabel(value: string) {
  return new Date(value).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  const layout = dialogLayout(width, height, 34, 116);
  const innerHeight =
    layout.popupHeight - (layout.tiny ? 0 : 2) - (layout.roomy ? 2 : 0);
  const [sessions, setSessions] = useState<HistorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(0);
  const [preview, setPreview] = useState<{
    ref: string;
    session?: Session;
    error?: string;
  }>();
  const [readonlySession, setReadonlySession] = useState<Session>();
  const [mode, setMode] = useState<"search" | "rename" | "delete">("search");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(-1);
  const input = useRef<InputRenderable>(null);
  const life = useRef({ mounted: true, busy: false });
  useEffect(() => {
    if (!layout.roomy) setFocus(-1);
  }, [layout.roomy]);
  useEffect(() => {
    if (mode === "rename") input.current?.gotoBufferEnd();
  }, [mode]);

  useEffect(() => {
    life.current.mounted = true;
    let live = true;
    void actions
      .load()
      .then((items) => {
        if (live) setSessions(items);
      })
      .catch((cause) => {
        if (live) setError(String(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      life.current.mounted = false;
    };
  }, [actions]);

  const filtered = useMemo(
    () => filterSessions(sessions, query),
    [sessions, query],
  );
  const index = Math.max(0, Math.min(selection, filtered.length - 1));
  const selected = filtered[index];
  const headerRows = layout.roomy ? 2 : 1;
  const searchRows = layout.roomy ? 3 : 1;
  const footerRows = layout.roomy ? 3 : 1;
  const statusRows = error || mode !== "search" ? 2 : 0;
  const bodyHeight = Math.max(
    1,
    innerHeight - headerRows - searchRows - footerRows - statusRows - 1,
  );
  const wide = layout.innerWidth >= 92 && bodyHeight >= 9;
  const listWidth = wide
    ? Math.floor(layout.innerWidth * 0.53)
    : layout.innerWidth;
  const rowHeight = layout.roomy ? 3 : bodyHeight >= 4 ? 2 : 1;
  const pageSize = Math.max(1, Math.floor(bodyHeight / rowHeight));
  const start = Math.max(
    0,
    Math.min(index - Math.floor(pageSize / 2), filtered.length - pageSize),
  );
  const move = (next: number) => {
    setSelection(Math.max(0, Math.min(filtered.length - 1, next)));
    setError("");
  };
  const close = () => {
    if (!life.current.busy) onClose();
  };

  // Preview never opens a runtime. An obsolete read cannot replace the current selection.
  useEffect(() => {
    if (!selected || !wide) return;
    let live = true;
    setPreview({ ref: selected.id });
    void actions
      .preview(selected.id)
      .then((session) => {
        if (live) setPreview({ ref: selected.id, session });
      })
      .catch((cause) => {
        if (live) setPreview({ ref: selected.id, error: String(cause) });
      });
    return () => {
      live = false;
    };
  }, [actions, selected, wide]);

  const run = (work: () => Promise<void>) => {
    if (life.current.busy) return;
    life.current.busy = true;
    setBusy(true);
    setError("");
    void work()
      .catch((cause) => {
        if (life.current.mounted)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        life.current.busy = false;
        if (life.current.mounted) setBusy(false);
      });
  };
  const viewHistory = () => {
    if (!selected) return;
    run(async () => {
      const session =
        preview?.ref === selected.id && preview.session
          ? preview.session
          : await actions.preview(selected.id);
      if (life.current.mounted) setReadonlySession(session);
    });
  };
  const choose = () => {
    if (!selected) return;
    if (selected.archive) return viewHistory();
    run(async () => {
      try {
        await actions.resume(selected.id);
        if (life.current.mounted) onClose();
      } catch (cause) {
        if (life.current.mounted)
          setError(cause instanceof Error ? cause.message : String(cause));
        const session = await actions.preview(selected.id);
        if (life.current.mounted) setReadonlySession(session);
      }
    });
  };
  const rename = () => {
    if (!selected || selected.archive) return;
    setDraft(selected.title);
    setMode("rename");
    setFocus(-1);
  };
  const remove = () => {
    if (selected && !selected.archive) setMode("delete");
  };
  const refresh = async () => {
    const items = await actions.load();
    if (life.current.mounted) {
      setSessions(items);
      setMode("search");
      setFocus(-1);
    }
  };
  const buttons = [choose, viewHistory, rename, remove];

  useUiKeyboard((key) => {
    const owner = capturedInputOwner(key);
    if (owner && owner !== "dialog") return;
    const name = key.name.toLowerCase();
    if (readonlySession) {
      if (name === "escape" || (key.ctrl && name === "c")) {
        key.preventDefault();
        key.stopPropagation();
        setReadonlySession(undefined);
      }
      return;
    }
    if (name === "escape" || (key.ctrl && name === "c")) {
      key.preventDefault();
      key.stopPropagation();
      if (life.current.busy) return;
      if (mode !== "search") setMode("search");
      else if (query) {
        setQuery("");
        setSelection(0);
      } else close();
      return;
    }
    if (busy || loading) {
      key.preventDefault();
      return;
    }
    if (mode === "delete") {
      key.preventDefault();
      key.stopPropagation();
      if ((name === "y" || name === "н") && selected)
        run(async () => {
          await actions.delete(selected.id);
          await refresh();
          move(0);
        });
      else setMode("search");
      return;
    }
    if (mode === "rename") {
      if (name === "return") {
        key.preventDefault();
        const title = (input.current?.plainText ?? draft).trim();
        if (selected)
          run(async () => {
            if (!title) throw new Error("Название не может быть пустым");
            await actions.rename(selected.id, title);
            await refresh();
          });
      }
      return;
    }
    if (name === "tab" && layout.roomy) {
      key.preventDefault();
      setFocus((value) => ((value + (key.shift ? 5 : 2)) % 5) - 1);
      return;
    }
    if (["up", "down", "pageup", "pagedown"].includes(name)) {
      key.preventDefault();
      move(
        index +
          (name === "up"
            ? -1
            : name === "down"
              ? 1
              : name === "pageup"
                ? -pageSize
                : pageSize),
      );
    } else if (name === "return") {
      key.preventDefault();
      (focus < 0 ? choose : buttons[focus])?.();
    } else if (name === "f3" || (key.ctrl && name === "p")) {
      key.preventDefault();
      viewHistory();
    } else if (key.ctrl && (name === "r" || name === "d")) {
      key.preventDefault();
      if (name === "r") rename();
      else remove();
    }
  });

  const line = (text: string, columns = layout.innerWidth) =>
    terminalLine(
      terminalSafeText(text, 2000).replace(/\s+/g, " "),
      Math.max(1, columns),
    );
  const selectedPreview = preview?.ref === selected?.id ? preview : undefined;
  const detailWidth = layout.innerWidth - listWidth - 3;

  return (
    <OpenTuiDialog
      id="resume"
      width={width}
      height={height}
      maxWidth={116}
      maxHeight={34}
      palette={palette}
      onClose={close}
    >
      {readonlySession ? (
        <box
          id="readonly-history"
          flexGrow={1}
          minHeight={1}
          flexDirection="column"
        >
          <text height={1} fg={palette.accent}>
            <strong>История · только просмотр</strong>
          </text>
          {innerHeight >= 6 && (
            <text height={2} fg={palette.muted}>
              {line(readonlySession.projectPath)}
            </text>
          )}
          {error && (
            <text height={2} fg={palette.yellow}>
              {terminalSafeText(error, 400)}
            </text>
          )}
          <scrollbox flexGrow={1} minHeight={1} focused>
            {readonlySession.messages.map((message, index) => (
              <box
                // biome-ignore lint/suspicious/noArrayIndexKey: Immutable history is never reordered.
                key={index}
                width="100%"
                flexDirection="column"
                flexShrink={0}
                marginBottom={1}
              >
                <text
                  fg={message.role === "user" ? palette.accent : palette.muted}
                >
                  {message.role === "user"
                    ? "Вы"
                    : message.role === "assistant"
                      ? "Ассистент"
                      : "Результат инструмента"}
                </text>
                <FormattedMessage
                  width={layout.innerWidth}
                  palette={palette}
                  content={message.content
                    .map((block) =>
                      block.type === "text"
                        ? block.text
                        : block.type === "tool_result"
                          ? typeof block.content === "string"
                            ? block.content
                            : JSON.stringify(block.content)
                          : block.type === "tool_use"
                            ? `${block.name}\n${JSON.stringify(block.input)}`
                            : "",
                    )
                    .join("\n")}
                />
              </box>
            ))}
          </scrollbox>
          <text height={1} fg={palette.muted}>
            {line("↑/↓ прокрутка · Esc к выбору сессии")}
          </text>
        </box>
      ) : (
        <>
          <box height={headerRows} flexShrink={0} flexDirection="row" gap={2}>
            <box flexGrow={1} flexDirection="column">
              <text height={1} fg={palette.text}>
                <strong>
                  {line(
                    "Продолжить разговор",
                    layout.innerWidth - (layout.innerWidth >= 48 ? 10 : 0),
                  )}
                </strong>
              </text>
              {layout.roomy && (
                <text height={1} fg={palette.muted}>
                  История всех проектов
                </text>
              )}
            </box>
            {layout.innerWidth >= 48 && (
              <text height={1} fg={palette.accent}>
                /resume
              </text>
            )}
          </box>
          <box
            height={searchRows}
            flexShrink={0}
            flexDirection="row"
            alignItems="center"
            paddingLeft={1}
            paddingRight={1}
            border={layout.roomy ? true : []}
            borderColor={focus < 0 ? palette.accent : palette.border}
            backgroundColor={palette.raised}
          >
            <text width={2} fg={palette.accent}>
              ⌕{" "}
            </text>
            <input
              ref={input}
              id="resume-search"
              key={mode === "rename" ? "rename" : "search"}
              flexGrow={1}
              focused={!busy && !loading && focus < 0 && mode !== "delete"}
              value={mode === "rename" ? draft : query}
              placeholder={
                mode === "rename"
                  ? "Новое название"
                  : "Название, проект, путь или сообщение…"
              }
              textColor={palette.text}
              backgroundColor={palette.raised}
              focusedBackgroundColor={palette.raised}
              cursorColor={palette.accent}
              onInput={(value) => {
                setError("");
                if (mode === "rename") setDraft(cleanSettingsInput(value));
                else {
                  setQuery(cleanSettingsInput(value));
                  setSelection(0);
                }
              }}
            />
          </box>
          <text height={1} flexShrink={0} fg={palette.muted}>
            {line(
              loading
                ? "Загрузка истории…"
                : `Сессий: ${filtered.length}  ·  Проектов: ${new Set(filtered.map((item) => item.projectPath)).size}${filtered.length ? `  ·  ${index + 1}/${filtered.length}` : ""}`,
            )}
          </text>
          <box
            height={bodyHeight}
            flexShrink={0}
            flexDirection="row"
            overflow="hidden"
          >
            <box
              width={listWidth}
              flexDirection="column"
              overflow="hidden"
              onMouseScroll={(event) =>
                move(index + (event.scroll?.direction === "up" ? -1 : 1))
              }
            >
              {!loading && !filtered.length && (
                <box
                  flexGrow={1}
                  justifyContent="center"
                  flexDirection="column"
                  paddingLeft={1}
                >
                  <text fg={palette.accent}>
                    {query ? "Ничего не найдено" : "Сессий нет"}
                  </text>
                  {bodyHeight >= 4 && (
                    <text fg={palette.muted}>
                      {line(
                        query
                          ? "Измените запрос или нажмите Esc."
                          : "Начните разговор — он появится здесь.",
                        listWidth - 2,
                      )}
                    </text>
                  )}
                </box>
              )}
              {filtered.slice(start, start + pageSize).map((item, offset) => {
                const active = start + offset === index;
                const current =
                  (item.sessionId ?? item.id) === actions.activeId();
                return (
                  <box
                    key={item.id}
                    id={`resume-row-${item.id}`}
                    height={rowHeight}
                    flexShrink={0}
                    flexDirection="column"
                    paddingRight={wide ? 1 : 0}
                  >
                    <DialogAction
                      palette={palette}
                      active={active}
                      disabled={busy}
                      onSelect={() => move(start + offset)}
                      label={line(
                        `${active ? "▸" : " "} ${item.title || "Без названия"}${current ? " · открыта" : ""}`,
                        listWidth - 3,
                      )}
                      subtitle={
                        rowHeight >= 2
                          ? line(
                              `${item.archive ? "Архив · " : ""}${item.projectName ?? "Проект"} · ${dateLabel(item.updatedAt)}`,
                              listWidth - 3,
                            )
                          : undefined
                      }
                    />
                  </box>
                );
              })}
            </box>
            {wide && (
              <box
                width={layout.innerWidth - listWidth}
                border={["left"]}
                borderColor={palette.border}
                paddingLeft={2}
                flexDirection="column"
                overflow="hidden"
              >
                <text height={1} fg={palette.accent}>
                  К РАЗГОВОРУ
                </text>
                {selected && (
                  <>
                    <text height={2} fg={palette.text}>
                      <strong>{terminalSafeText(selected.title, 200)}</strong>
                    </text>
                    <text height={2} fg={palette.muted}>
                      {terminalSafeText(selected.projectPath ?? "", 400)}
                    </text>
                    <text height={1} fg={palette.muted}>
                      {line(
                        `${selected.messageCount} сообщ. · ${selected.model}`,
                        detailWidth,
                      )}
                    </text>
                    <text height={1} fg={palette.muted}>
                      {line(
                        `${selected.gitBranch ? `⑂ ${selected.gitBranch} · ` : ""}${selected.providerId}`,
                        detailWidth,
                      )}
                    </text>
                    <box height={1} flexShrink={0} />
                    <scrollbox flexGrow={1} minHeight={1}>
                      {selectedPreview?.session ? (
                        excerpts(selectedPreview.session).map((message) => (
                          <box
                            key={message.index}
                            flexDirection="column"
                            flexShrink={0}
                            marginBottom={1}
                          >
                            <text height={1} fg={palette.accent}>
                              {message.role}
                            </text>
                            <text fg={palette.text}>
                              {terminalSafeText(message.text, 240).replace(
                                /\s+/g,
                                " ",
                              )}
                            </text>
                          </box>
                        ))
                      ) : (
                        <text
                          fg={
                            selectedPreview?.error
                              ? palette.yellow
                              : palette.muted
                          }
                        >
                          {selectedPreview?.error
                            ? terminalSafeText(selectedPreview.error, 200)
                            : "Читаем последние сообщения…"}
                        </text>
                      )}
                    </scrollbox>
                  </>
                )}
              </box>
            )}
          </box>
          {!!statusRows && (
            <box height={statusRows} flexShrink={0} flexDirection="column">
              <text
                height={2}
                fg={mode === "delete" ? palette.red : palette.yellow}
              >
                {terminalSafeText(
                  error ||
                    (mode === "rename"
                      ? `Новое название: ${draft}`
                      : `Удалить «${selected?.title}»? y — удалить · Esc — отмена`),
                  400,
                )}
              </text>
            </box>
          )}
          {layout.roomy && (
            <box
              height={2}
              flexShrink={0}
              alignItems="center"
              flexDirection="row"
              gap={1}
            >
              {[
                selected?.archive
                  ? "Просмотр ↵"
                  : busy
                    ? "Открываем…"
                    : "Продолжить ↵",
                "Просмотр F3",
                "Имя ^R",
                "Удалить ^D",
              ].map((label, button) => (
                <DialogAction
                  key={label}
                  label={label}
                  palette={palette}
                  primary={button === 0}
                  active={focus === button}
                  disabled={
                    busy || !selected || (button >= 2 && selected.archive)
                  }
                  onSelect={() => buttons[button]?.()}
                />
              ))}
            </box>
          )}
          <text height={1} flexShrink={0} fg={palette.muted}>
            {line(
              layout.roomy
                ? "↑↓ выбор · PgUp/PgDn страницы · Tab действия · Esc назад"
                : "↑↓ · Enter открыть · F3 просмотр · ^R/^D · Esc",
            )}
          </text>
        </>
      )}
    </OpenTuiDialog>
  );
}
