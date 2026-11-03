/** @jsxImportSource @opentui/react */
import { basename } from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";
import { WorkspaceAdmissionError } from "../projects/admission.js";
import type { DirectoryPage } from "../projects/navigation.js";
import type { Palette } from "./appearance.js";
import {
  type MenuAction,
  MenuActions,
  useMenuNavigation,
} from "./menu-navigation.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { useUiKeyboard } from "./overlay-input.js";
import { terminalLine } from "./terminal-text.js";

export interface OpenTuiProjectsActions {
  base: string;
  draftPath?: string;
  cached?(path: string): DirectoryPage | undefined;
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
  const pathRef = useRef(path);
  const [page, setPage] = useState<DirectoryPage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>();
  const mounted = useRef(true);
  const ticket = useRef(0);
  const opening = useRef(false);
  const readyPath = useRef<string | undefined>(undefined);
  const browsing = useRef<AbortController | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopBrowsing = useCallback(() => {
    clearTimeout(timer.current);
    browsing.current?.abort();
    ++ticket.current;
  }, []);
  const close = () => {
    mounted.current = false;
    stopBrowsing();
    actions.cancel();
    onClose();
  };
  const { innerWidth, popupHeight, tiny } = dialogLayout(width, height, 24, 88);
  const roomy = popupHeight >= 18;
  const fixedHeight =
    (roomy ? 2 : 1) +
    (height >= 14 ? 1 : 0) +
    1 +
    (height >= 16 ? (roomy ? 2 : 1) : 0) +
    (error && height >= 16 ? 2 : 1) +
    (height >= 16 ? 2 : 1) +
    (height >= 14 ? 1 : 0) +
    (message && height >= 16 ? 1 : 0);
  const listHeight = Math.max(
    1,
    popupHeight - (tiny ? 0 : 2) - (roomy ? 2 : 0) - fixedHeight,
  );
  const rows = page
    ? [
        ...(page.path !== page.parent && !page.filter
          ? [{ path: page.parent, label: ".. На уровень выше" }]
          : []),
        ...page.directories.map((dir) => ({
          path: dir,
          label: `${basename(dir)}/`,
        })),
      ]
    : [];
  const index = Math.max(
    0,
    rows.findIndex((row) => row.path === selected),
  );
  const first = Math.max(
    0,
    Math.min(index - Math.floor(listHeight / 2), rows.length - listHeight),
  );
  const browse = useCallback(
    (value: string, offset = 0) => {
      stopBrowsing();
      readyPath.current = undefined;
      const abort = new AbortController();
      browsing.current = abort;
      const id = ticket.current;
      const cached = offset === 0 ? actions.cached?.(value) : undefined;
      setLoading(true);
      setError("");
      setPage(cached);
      setSelected(undefined);
      void (async () => {
        let next = await actions.browse(value, abort.signal, offset);
        let directories = next.directories;
        // Sparse matches can lie beyond the first I/O batch. Yield between batches;
        // keep memory bounded and never report an empty first batch as no matches.
        while (next.more && directories.length < 100) {
          if (!mounted.current || id !== ticket.current || abort.signal.aborted)
            return;
          next = await actions.browse(value, abort.signal, next.offset);
          directories = [...directories, ...next.directories];
        }
        if (!mounted.current || id !== ticket.current || abort.signal.aborted)
          return;
        readyPath.current = value;
        setPage({
          ...next,
          directories: directories.sort((a, b) =>
            basename(a).localeCompare(basename(b), "ru", { numeric: true }),
          ),
        });
        setLoading(false);
      })().catch((cause) => {
        if (!mounted.current || id !== ticket.current || abort.signal.aborted)
          return;
        setLoading(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [actions, stopBrowsing],
  );
  useEffect(() => {
    mounted.current = true;
    browse(pathRef.current);
    return () => {
      mounted.current = false;
      stopBrowsing();
      actions.cancel();
    };
  }, [actions, browse, stopBrowsing]);
  const edit = (value: string) => {
    if (value === pathRef.current || opening.current) return;
    pathRef.current = value;
    readyPath.current = undefined;
    actions.draftPath = value;
    setPath(value);
    stopBrowsing();
    setError("");
    setSelected(undefined);
    const cached = actions.cached?.(value);
    setPage(cached);
    setLoading(true);
    timer.current = setTimeout(() => browse(value), 120);
  };
  const navigate = (value: string) => {
    if (opening.current) return;
    pathRef.current = value;
    actions.draftPath = value;
    setPath(value);
    browse(value);
  };
  const open = () => {
    if (
      opening.current ||
      loading ||
      !page ||
      page.filter ||
      readyPath.current !== path ||
      pathRef.current !== path
    )
      return;
    opening.current = true;
    stopBrowsing();
    setBusy(true);
    setError("");
    void actions
      .open(page.path)
      .then(() => {
        if (mounted.current) onClose();
      })
      .catch((cause) => {
        if (!mounted.current) return;
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
        opening.current = false;
        if (mounted.current) setBusy(false);
      });
  };
  const menu: MenuAction[] = [
    {
      id: "project-open",
      label: "Открыть папку",
      shortLabel: "Открыть",
      primary: true,
      run: open,
      disabled: busy || loading || !page || !!page.filter,
    },
    ...(page?.more
      ? [
          {
            id: "project-more",
            label: "Ещё папки",
            run: () => browse(pathRef.current, page.offset),
            disabled: busy || loading,
          },
        ]
      : []),
    { id: "project-cancel", label: "Отмена", run: close },
  ];
  const navigation = useMenuNavigation(
    ["path", "list", "actions"],
    menu,
    "path",
  );
  const move = (delta: number) => {
    if (busy || loading) return;
    navigation.setArea("list");
    setSelected(
      rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.path,
    );
  };
  useUiKeyboard((key) => {
    const name = key.name.toLowerCase();
    if (name === "escape" || (key.ctrl && name === "c")) {
      key.preventDefault();
      key.stopPropagation();
      close();
      return;
    }
    if (navigation.handle(key)) return;
    if (busy) return;
    if (
      navigation.area === "list" &&
      ["up", "down", "pageup", "pagedown", "home", "end"].includes(name)
    ) {
      key.preventDefault();
      key.stopPropagation();
      move(
        name === "home"
          ? -rows.length
          : name === "end"
            ? rows.length
            : name === "up"
              ? -1
              : name === "down"
                ? 1
                : name === "pageup"
                  ? -listHeight
                  : listHeight,
      );
    } else if (name === "return" || name === "enter") {
      key.preventDefault();
      key.stopPropagation();
      if (key.repeated) return;
      if (navigation.area === "list" && !loading && rows[index])
        navigate(rows[index].path);
      else if (navigation.area === "path") {
        if (!page || loading) browse(pathRef.current);
        navigation.setArea("list");
      }
    }
  });
  const status =
    error ||
    (busy
      ? "Открытие… Esc — отмена"
      : loading
        ? "Чтение папок…"
        : page?.filter
          ? `Совпадения: ${page.directories.length}${page.more ? "+" : ""}`
          : page?.directories.length === 0
            ? "В этой папке нет подпапок"
            : "");
  return (
    <OpenTuiDialog
      id="projects"
      width={width}
      height={height}
      maxWidth={88}
      maxHeight={24}
      palette={palette}
      onClose={close}
    >
      <box height={roomy ? 2 : 1} flexShrink={0}>
        <text fg={palette.text}>
          <strong>Открыть папку</strong>
        </text>
      </box>
      {message && height >= 16 && (
        <text fg={palette.muted} height={1}>
          {terminalLine(message, innerWidth)}
        </text>
      )}
      {height >= 14 && (
        <text
          fg={navigation.area === "path" ? palette.accent : palette.muted}
          height={1}
          flexShrink={0}
        >
          {navigation.area === "path" ? "> Путь" : "Путь"}
        </text>
      )}
      <input
        id="project-path"
        value={path}
        onInput={edit}
        focused={navigation.area === "path" && !busy}
        width="100%"
        flexShrink={0}
        backgroundColor={palette.raised}
        focusedBackgroundColor={palette.raised}
        textColor={palette.text}
        cursorColor={palette.accent}
      />
      {height >= 16 && (
        <text fg={palette.muted} height={roomy ? 2 : 1} flexShrink={0}>
          {terminalLine(
            page?.filter ? `Папки в ${page.path}` : "Папки",
            innerWidth,
          )}
        </text>
      )}
      <box
        id="project-directories"
        flexGrow={1}
        minHeight={1}
        flexDirection="column"
        onMouseScroll={(event) => {
          move(event.scroll?.direction === "up" ? -1 : 1);
          event.stopPropagation();
        }}
      >
        {rows.slice(first, first + listHeight).map((row, position) => {
          const active =
            navigation.area === "list" && first + position === index;
          return (
            <DialogAction
              key={row.path}
              id={`project-row-directory-${row.path}`}
              active={active}
              label={terminalLine(
                `${active ? "> " : "  "}${row.label}`,
                innerWidth - 2,
              )}
              palette={palette}
              disabled={busy || loading}
              onSelect={() => {
                navigation.setArea("list");
                setSelected(row.path);
                navigate(row.path);
              }}
            />
          );
        })}
        {!loading && !error && page?.filter && !page.directories.length && (
          <text fg={palette.muted}>Папки не найдены</text>
        )}
      </box>
      <text
        id="project-open-status"
        fg={error ? palette.red : palette.muted}
        height={error && height >= 16 ? 2 : 1}
        flexShrink={0}
      >
        {terminalLine(status, innerWidth * (error && height >= 16 ? 2 : 1))}
      </text>
      <box
        border={height >= 16 ? ["top"] : []}
        borderColor={palette.border}
        height={height >= 16 ? 2 : 1}
        flexShrink={0}
      >
        <MenuActions
          id="project-actions"
          actions={menu}
          navigation={navigation}
          width={innerWidth}
          palette={palette}
        />
      </box>
      {height >= 14 && (
        <text fg={palette.muted} height={1} flexShrink={0}>
          {terminalLine(
            navigation.area === "actions"
              ? "←/→ действие · Enter выбрать · Esc отмена"
              : "Tab фокус · Enter перейти · Esc отмена",
            innerWidth,
          )}
        </text>
      )}
    </OpenTuiDialog>
  );
}
