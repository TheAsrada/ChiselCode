/** @jsxImportSource @opentui/react */
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useLayoutEffect, useRef, useState } from "react";
import type { UiTone } from "../extensions/ui-types.js";
import type { Palette } from "./appearance.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiPresentationController as TuiController } from "./tui-controller.js";

export function uiTone(palette: Palette, tone?: UiTone): string {
  return tone === "error"
    ? palette.red
    : tone === "warning"
      ? palette.yellow
      : tone === "success"
        ? palette.green
        : tone === "accent"
          ? palette.accent
          : palette.muted;
}

export function OpenTuiExtensionDetails({
  controller,
  width,
  height,
  palette,
}: {
  controller: TuiController;
  width: number;
  height: number;
  palette: Palette;
}) {
  const view = controller.snapshot.extensionView;
  const binding = controller.uiBinding;
  const [expanded, setExpanded] = useState(false);
  const [actionIndex, setActionIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState(view?.search ?? "");
  const scroll = useRef<ScrollBoxRenderable>(null);
  const layout = dialogLayout(width, height);
  const compact = layout.popupHeight < 16;
  const owner = `extension-view:${controller.conversationId}:${controller.currentGeneration}`;
  const page = view?.page;
  const rows = page?.rows ?? [];
  const mountedRows = Math.max(1, 64 - (page?.fields?.length ?? 0));
  const selected = rows.findIndex((row) => row.id === view?.selected);
  const selectedRow = rows[Math.max(0, selected)];
  const selectedRowId = selectedRow?.id;
  const actions = page?.actions ?? [];
  const close = () => binding?.close();
  const viewKey = view?.key;
  useLayoutEffect(() => {
    const body = scroll.current;
    if (!body || !viewKey) return;
    body.scrollTo(controller.uiPresentation.get(viewKey)?.scroll ?? 0);
    return () => {
      controller.uiPresentation.set(viewKey, {
        ...controller.uiPresentation.get(viewKey),
        scroll: body.scrollTop,
      });
    };
  }, [controller, viewKey]);
  useLayoutEffect(() => {
    if (selectedRowId)
      scroll.current?.scrollChildIntoView(`extension-row-${selectedRowId}`);
  }, [selectedRowId]);
  useUiKeyboard((key) => {
    if (capturedInputOwner(key) !== owner) return;
    if (key.ctrl && key.name === "c" && !key.shift) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.ctrl || key.meta || key.option) return;
    if (searching) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "escape") setSearching(false);
      else if (key.name === "return" || key.name === "enter") {
        setSearching(false);
        void binding?.loadPage(undefined, search);
      } else if (key.name === "backspace")
        setSearch((text) => [...text].slice(0, -1).join(""));
      else if (key.sequence && !key.sequence.startsWith("\x1b"))
        setSearch((text) => [...(text + key.sequence)].slice(0, 120).join(""));
      return;
    }
    if (key.name === "/") {
      key.preventDefault();
      key.stopPropagation();
      setSearching(true);
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      if (expanded) setExpanded(false);
      else close();
    } else if (
      ["up", "down", "home", "end", "pageup", "pagedown"].includes(key.name)
    ) {
      key.preventDefault();
      key.stopPropagation();
      const next =
        key.name === "home"
          ? 0
          : key.name === "end"
            ? rows.length - 1
            : Math.max(0, selected) +
              (key.name === "up" || key.name === "pageup" ? -1 : 1) *
                (key.name.startsWith("page") ? Math.max(1, height - 6) : 1);
      const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (row) {
        binding?.select(row.id);
        setExpanded(false);
        scroll.current?.scrollChildIntoView(`extension-row-${row.id}`);
      }
    } else if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      setActionIndex(
        (index) =>
          (index + (key.shift ? -1 : 1) + actions.length + 3) %
          (actions.length + 3),
      );
    } else if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      key.stopPropagation();
      if (selectedRow && actionIndex === 0) {
        if (selectedRow.action && view && page)
          void binding?.dispatch(
            view.key,
            selectedRow.action,
            page.revision,
            true,
          );
        else setExpanded((value) => !value);
      } else if (actionIndex >= 3 && actions[actionIndex - 3] && view && page)
        void binding?.dispatch(
          view.key,
          actions[actionIndex - 3]!,
          page.revision,
          true,
        );
      else if (actionIndex === 1) void binding?.loadPage(page?.nextCursor);
      else if (actionIndex === 2) close();
    }
  });
  if (!view) return null;
  const inner = layout.innerWidth;
  return (
    <OpenTuiDialog
      id="extension-details"
      width={width}
      height={height}
      palette={palette}
      onClose={close}
    >
      <text
        height={1}
        attributes={TextAttributes.BOLD}
        fg={palette.accent}
        content={terminalLine(view.title, inner)}
      />
      {!compact && (
        <text
          height={1}
          fg={palette.muted}
          content={terminalLine(
            `Источник: ${view.extensionId} · ${view.loading ? "Загрузка" : page?.state === "unavailable" ? "Данные недоступны" : page?.state === "stale" ? "Данные устарели" : "Подробности"}`,
            inner,
          )}
        />
      )}
      {searching && (
        <text
          height={1}
          fg={palette.accent}
          content={terminalLine(`Поиск: ${search}`, inner)}
        />
      )}
      <TerminalScrollbox
        id="extension-details-body"
        ref={scroll}
        flexGrow={1}
        minHeight={0}
        focused={false}
        viewportCulling
      >
        {page?.summary && (!compact || rows.length === 0) && (
          <text
            fg={uiTone(palette, page.state === "error" ? "error" : "muted")}
            content={page.summary}
          />
        )}
        {!compact &&
          (page?.fields ?? []).map((row) => (
            <text
              key={row.id}
              fg={palette.text}
              content={`${row.label}: ${row.value ?? ""}`}
            />
          ))}
        {expanded && selectedRow ? (
          <text
            fg={palette.text}
            content={
              selectedRow.detail ?? selectedRow.value ?? selectedRow.label
            }
          />
        ) : (
          rows
            .slice(
              Math.max(0, selected - 45),
              Math.max(0, selected - 45) + mountedRows,
            )
            .map((row) => (
              <DialogAction
                key={row.id}
                id={`extension-row-${row.id}`}
                label={terminalLine(
                  `${row.label}${row.value ? ` · ${row.value}` : ""}`,
                  inner - 2,
                )}
                active={row.id === view.selected}
                tone={row.tone}
                palette={palette}
                onSelect={() => {
                  binding?.select(row.id);
                  setExpanded(true);
                }}
              />
            ))
        )}
        {!view.loading && page?.state === "empty" && !page.summary && (
          <text fg={palette.muted}>Пока нет данных</text>
        )}
        {view.notice && <text fg={palette.yellow} content={view.notice} />}
      </TerminalScrollbox>
      <box flexShrink={0} flexDirection="row" flexWrap="wrap">
        <DialogAction
          id="extension-refresh"
          label={
            compact
              ? "Ещё"
              : page?.nextCursor
                ? "Следующая страница"
                : "Обновить"
          }
          active={actionIndex === 1}
          palette={palette}
          onSelect={() => {
            setExpanded(false);
            void binding?.loadPage(page?.nextCursor);
          }}
        />
        <DialogAction
          id="extension-close"
          label="Назад"
          active={actionIndex === 2}
          palette={palette}
          onSelect={close}
        />
        {actions.slice(0, layout.tiny ? 1 : 6).map((use, index) => (
          <DialogAction
            key={use.id}
            label={terminalLine(
              binding?.subscription.action(view.key, use, page!.revision, true)
                ?.label ?? "Недоступно",
              inner - 2,
            )}
            active={actionIndex === index + 3}
            palette={palette}
            onSelect={() => {
              void binding?.dispatch(view.key, use, page!.revision, true);
            }}
          />
        ))}
      </box>
      {!layout.tiny && (
        <text height={1} fg={palette.muted}>
          ↑↓ выбор · Enter подробности · / поиск · Tab действия · Esc назад
        </text>
      )}
    </OpenTuiDialog>
  );
}
