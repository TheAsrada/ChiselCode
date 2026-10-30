/** @jsxImportSource @opentui/react */
import { basename } from "node:path";
import type { ScrollBoxRenderable } from "@opentui/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { WorkspaceAdmissionError } from "../projects/admission.js";
import type { DirectoryPage } from "../projects/navigation.js";
import type { ProjectMetadata } from "../sessions/project-store.js";
import type { Palette } from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { useUiKeyboard } from "./overlay-input.js";
import { terminalLine } from "./terminal-text.js";

export interface OpenTuiProjectsActions {
  base: string;
  draftPath?: string;
  recent(): Promise<ProjectMetadata[]>;
  browse(
    path: string,
    signal: AbortSignal,
    offset?: number,
  ): Promise<DirectoryPage>;
  open(path: string): Promise<void>;
  cancel(): void;
}

export function OpenTuiProjects({
  actions,
  width,
  height,
  palette,
  onClose,
  message,
}: {
  actions: OpenTuiProjectsActions;
  width: number;
  height: number;
  palette: Palette;
  onClose(): void;
  message?: string;
}) {
  const [path, setPath] = useState(actions.draftPath ?? actions.base);
  const [page, setPage] = useState<DirectoryPage>();
  const [recent, setRecent] = useState<ProjectMetadata[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(0);
  const [selected, setSelected] = useState<string>();
  const mounted = useRef(true);
  const ticket = useRef(0);
  const editRevision = useRef(0);
  const browsing = useRef<AbortController | undefined>(undefined);
  const list = useRef<ScrollBoxRenderable>(null);
  const close = () => {
    actions.cancel();
    browsing.current?.abort();
    onClose();
  };
  const browse = useCallback(
    (value: string, offset = 0) => {
      browsing.current?.abort();
      const abort = new AbortController();
      browsing.current = abort;
      const id = ++ticket.current;
      const revision = ++editRevision.current;
      setPath(value);
      setError("");
      void actions
        .browse(value, abort.signal, offset)
        .then((next) => {
          if (!mounted.current || id !== ticket.current || abort.signal.aborted)
            return;
          setPage(next);
          if (revision === editRevision.current) setPath(next.path);
          setSelected(undefined);
        })
        .catch((cause) => {
          if (mounted.current && id === ticket.current && !abort.signal.aborted)
            setError(String(cause));
        });
    },
    [actions],
  );
  useEffect(() => {
    mounted.current = true;
    browse(actions.draftPath ?? actions.base);
    void actions
      .recent()
      .then((items) => {
        if (mounted.current) setRecent(items);
      })
      .catch((cause) => {
        if (mounted.current) setError(String(cause));
      });
    return () => {
      mounted.current = false;
      ++ticket.current;
      browsing.current?.abort();
      actions.cancel();
    };
  }, [actions, browse]);
  const open = (value = path) => {
    const id = ++ticket.current;
    setBusy(true);
    setError("");
    void actions
      .open(value)
      .then(() => {
        if (mounted.current && id === ticket.current) onClose();
      })
      .catch((cause) => {
        if (mounted.current && id === ticket.current)
          setError(
            cause instanceof WorkspaceAdmissionError
              ? cause.message.replace(
                  " Выберите рабочую папку или укажите --cwd <путь>.",
                  "",
                )
              : cause instanceof Error
                ? cause.message
                : String(cause),
          );
      })
      .finally(() => {
        if (mounted.current && id === ticket.current) setBusy(false);
      });
  };
  const rows = useMemo(
    () => [
      ...recent.map((item) => ({
        path: item.path,
        label: `${item.name} · ${item.lastOpenedAt.slice(0, 10)}`,
        recent: true,
      })),
      ...(page
        ? [
            {
              path: page.parent,
              label: ".. Родительская папка",
              recent: false,
            },
            ...page.directories.map((dir) => ({
              path: dir,
              label: basename(dir),
              recent: false,
            })),
          ]
        : []),
    ],
    [recent, page],
  );
  const index = Math.max(
    0,
    rows.findIndex((row) => row.path === selected),
  );
  const { innerWidth } = dialogLayout(width, height);
  const wide = width >= 110 && height >= 30;
  const listWidth = wide ? Math.floor(innerWidth * 0.55) : innerWidth;
  const rowHeight = width >= 80 && height >= 24 ? 2 : 1;
  const visible = Math.max(1, Math.floor((height - 12) / rowHeight));
  const rowId = rows[index]
    ? `project-row-${rows[index].recent ? "recent" : "directory"}-${rows[index].path}`
    : undefined;
  useLayoutEffect(() => {
    if (rowId) list.current?.scrollChildIntoView(rowId);
  }, [rowId]);
  useUiKeyboard((key) => {
    const name = key.name.toLowerCase();
    if (name === "escape" || (key.ctrl && name === "c")) {
      key.preventDefault();
      key.stopPropagation();
      close();
      return;
    }
    if (name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      const count = page?.more ? 5 : 4;
      setFocus((current) => (current + (key.shift ? count - 1 : 1)) % count);
      return;
    }
    if (focus === 1 && ["up", "down", "pageup", "pagedown"].includes(name)) {
      key.preventDefault();
      key.stopPropagation();
      const delta =
        name === "up"
          ? -1
          : name === "down"
            ? 1
            : name === "pageup"
              ? -visible
              : visible;
      setSelected(
        rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.path,
      );
      return;
    }
    if (name === "return" || name === "enter") {
      key.preventDefault();
      key.stopPropagation();
      const row = rows[index];
      if (focus === 1 && row) {
        if (row.recent) open(row.path);
        else browse(row.path);
      } else if (focus === 3) browse(path);
      else if (focus === 4 && page?.more) browse(page.path, page.offset);
      else if (!busy) open();
    }
  });
  return (
    <OpenTuiDialog
      id="projects"
      width={width}
      height={height}
      palette={palette}
      onClose={close}
    >
      <text fg={palette.text} height={1} flexShrink={0}>
        <strong>Открыть папку</strong>
      </text>
      {height >= 16 && (
        <text fg={palette.muted} height={1} flexShrink={0}>
          {message ?? "Выберите рабочую папку для следующей задачи"}
        </text>
      )}
      <input
        id="project-path"
        value={path}
        onInput={(value) => {
          editRevision.current++;
          actions.draftPath = value;
          setPath(value);
        }}
        focused={focus === 0 && !busy}
        width="100%"
        flexShrink={0}
        backgroundColor={palette.raised}
        textColor={palette.text}
      />
      <text fg={palette.muted} height={1} flexShrink={0}>
        {terminalLine(`Навигация: ${page?.path ?? actions.base}`, innerWidth)}
      </text>
      <box flexDirection="row" flexGrow={1} minHeight={1} width="100%">
        <scrollbox
          ref={list}
          width={listWidth}
          flexGrow={1}
          flexShrink={1}
          minHeight={1}
          focused={focus === 1}
        >
          {rows.map((row) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: Tab/arrows select the same native list rows.
            <box
              key={`${row.recent}:${row.path}`}
              id={`project-row-${row.recent ? "recent" : "directory"}-${row.path}`}
              flexDirection="column"
              height={rowHeight}
              flexShrink={0}
              onMouseUp={() => {
                setSelected(row.path);
                setPath(row.path);
                setFocus(1);
              }}
            >
              <text fg={selected === row.path ? palette.accent : palette.text}>
                {terminalLine(
                  `${selected === row.path ? "> " : "  "}${row.recent ? "Недавний: " : ""}${row.label}`,
                  listWidth,
                )}
              </text>
              {width >= 80 && height >= 24 && (
                <text fg={palette.muted}>
                  {terminalLine(row.path, listWidth)}
                </text>
              )}
            </box>
          ))}
        </scrollbox>
        {wide && (
          <scrollbox
            width={innerWidth - listWidth - 1}
            paddingLeft={1}
            minHeight={1}
          >
            <text fg={palette.accent} height={1}>
              Полный путь
            </text>
            <text fg={palette.text} width="100%" flexShrink={0} selectable>
              {focus === 1 ? (rows[index]?.path ?? path) : path}
            </text>
            <text fg={palette.muted} width="100%" flexShrink={0}>
              Папка навигации станет проектом после явного открытия. Файлы и
              инструкции при просмотре каталогов не загружаются.
            </text>
          </scrollbox>
        )}
      </box>
      {page?.more && (
        <DialogAction
          label="Следующие папки"
          palette={palette}
          onSelect={() => browse(page.path, page.offset)}
          active={focus === 4}
        />
      )}
      <text
        id="project-open-status"
        fg={error ? palette.red : palette.muted}
        height={error ? (height >= 16 ? 3 : 2) : 1}
        flexShrink={0}
      >
        {error ||
          (busy
            ? "Проверка и открытие… Esc — отмена"
            : "Enter — открыть · Tab — фокус · Esc — отмена")}
      </text>
      <box flexDirection="row" height={1} gap={2}>
        <DialogAction
          id="project-open"
          label={width < 60 ? "Открыть" : "Открыть эту папку"}
          palette={palette}
          onSelect={() => open()}
          active={focus === 2}
        />
        <DialogAction
          label={width < 60 ? "Папки" : "Просмотр папок"}
          palette={palette}
          onSelect={() => browse(path)}
          active={focus === 3}
        />
      </box>
    </OpenTuiDialog>
  );
}
