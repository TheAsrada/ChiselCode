/** @jsxImportSource @opentui/react */
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useLayoutEffect, useRef, useState } from "react";
import { backgroundActive } from "../background/contracts.js";
import { backgroundStateLabels } from "../background/presentation.js";
import type { Palette } from "./appearance.js";
import { DialogAction } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { elapsedSeconds } from "./request-timing.js";
import { useElapsedClock } from "./subagent-elapsed.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine, terminalTextRows } from "./terminal-text.js";
import type {
  TuiPresentationController as TuiController,
  TuiViewState,
} from "./tui-controller.js";
export function BackgroundTaskList({
  controller,
  view,
  width,
  height,
  palette,
  focused,
  onBack,
}: {
  controller: TuiController;
  view: TuiViewState;
  width: number;
  height: number;
  palette: Palette;
  focused: boolean;
  onBack(): void;
}) {
  const renderer = useRenderer();
  const tiny = height < 12 || width < 30;
  const pressed = useRef<string | undefined>(undefined);
  const body = useRef<ScrollBoxRenderable>(null);
  const [action, setAction] = useState(0);
  const [searching, setSearching] = useState(false);
  const [windowStart, setWindowStart] = useState(0);
  const [stopSet, setStopSet] =
    useState<readonly { id: string; label: string }[]>();
  const list = view.backgroundList ?? { filter: "all", search: "" };
  const all = (view.backgroundTasks ?? []).filter(
    (task) =>
      !task.outputExpired &&
      (!task.foreground || task.cleanup.recoveryRequired),
  );
  const active = all.filter((task) => backgroundActive(task.state)).length;
  const errors = all.filter((task) =>
    [
      "failed",
      "cleanup_unknown",
      "lost",
      "interrupted",
      "output_limit",
      "timed_out",
      "start_failed",
    ].includes(task.state),
  ).length;
  const now = useElapsedClock(active > 0);
  const filtered = all.filter(
    (task) =>
      (!list.childId || task.childId === list.childId) &&
      (list.filter === "all" ||
        backgroundActive(task.state) === (list.filter === "active")) &&
      `${task.label} ${task.commandPreview}`
        .toLowerCase()
        .includes(list.search.toLowerCase()),
  );
  const groups = [...new Set(filtered.map((task) => task.childId ?? "main"))];
  const tasks = groups.flatMap((group) =>
    filtered.filter((task) => (task.childId ?? "main") === group),
  );
  const selected = tasks.find((task) => task.id === list.selected);
  const index = tasks.findIndex((task) => task.id === list.selected);
  const start = Math.max(
    0,
    Math.min(windowStart, Math.max(0, tasks.length - 64)),
  );
  const shown = tasks.slice(start, start + 64);
  const shownGroups = [...new Set(shown.map((task) => task.childId ?? "main"))];
  const rowHeight = tiny ? 1 : height >= 20 ? 6 : 3;
  const rows = Math.max(1, height - (tiny ? 2 : 5) - (list.childId ? 1 : 0));
  const actions = [
    () => {
      if (selected) void controller.openBackground(selected.id);
    },
    () => {
      if (selected && backgroundActive(selected.state))
        void controller.stopBackground(selected.id);
    },
    onBack,
  ];
  // biome-ignore lint/correctness/useExhaustiveDependencies: Stable selection scrolling depends on row identity and layout, not output batches.
  useLayoutEffect(() => {
    if (!list.selected && tasks[0])
      controller.setBackgroundList({ selected: tasks[0].id });
    if (index >= 0 && (index < start || index >= start + 64))
      setWindowStart(Math.max(0, index - 32));
    const scroll = body.current;
    if (scroll && index >= 0) {
      const y =
        index * rowHeight + groups.indexOf(selected?.childId ?? "main") + 1;
      if (y < scroll.scrollTop) scroll.scrollTo(y);
      else if (y + rowHeight > scroll.scrollTop + rows)
        scroll.scrollTo(y + rowHeight - rows);
    }
  }, [index, list.selected, tasks[0]?.id, rows, rowHeight, controller, start]);
  const owner = `background:${controller.conversationId}:${controller.currentGeneration}`;
  useUiKeyboard((key) => {
    if (!focused || capturedInputOwner(key) !== owner) return;
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.ctrl || key.meta || key.option) return;
    if (stopSet) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "escape") setStopSet(undefined);
      else if (["return", "enter"].includes(key.name)) {
        const captured = stopSet.map((task) => task.id);
        setStopSet(undefined);
        void controller.stopBackgroundSet(captured);
      }
      return;
    }
    if (searching) {
      key.preventDefault();
      key.stopPropagation();
      if (["escape", "return", "enter"].includes(key.name)) setSearching(false);
      else if (key.name === "backspace")
        controller.setBackgroundList({
          search: [...list.search].slice(0, -1).join(""),
        });
      else if (
        key.sequence &&
        [...key.sequence].length === 1 &&
        list.search.length < 120
      )
        controller.setBackgroundList({ search: list.search + key.sequence });
      return;
    }
    if (
      ![
        "escape",
        "tab",
        "return",
        "enter",
        "up",
        "down",
        "j",
        "k",
        "home",
        "end",
        "pageup",
        "pagedown",
        "s",
        "f",
        "/",
        "a",
      ].includes(key.name)
    )
      return;
    key.preventDefault();
    key.stopPropagation();
    if (key.name === "a")
      setStopSet(
        all
          .filter((task) => backgroundActive(task.state))
          .map((task) => ({ id: task.id, label: task.label })),
      );
    else if (key.name === "escape") onBack();
    else if (key.name === "tab")
      setAction((current) => (current + (key.shift ? 3 : 1)) % 4);
    else if (["return", "enter"].includes(key.name))
      actions[Math.max(0, action - 1)]?.();
    else if (key.name === "s") actions[1]?.();
    else if (key.name === "/") setSearching(true);
    else if (key.name === "f")
      controller.setBackgroundList({
        filter:
          list.filter === "all"
            ? "active"
            : list.filter === "active"
              ? "terminal"
              : "all",
      });
    else {
      const delta =
        (["up", "k", "pageup"].includes(key.name) ? -1 : 1) *
        (key.name.startsWith("page")
          ? Math.max(1, Math.floor(rows / rowHeight))
          : 1);
      controller.setBackgroundList({
        selected:
          tasks[
            key.name === "home"
              ? 0
              : key.name === "end"
                ? tasks.length - 1
                : Math.max(0, Math.min(tasks.length - 1, index + delta))
          ]?.id,
      });
    }
  });
  return (
    <box
      id="background-list"
      width={width}
      height={height}
      flexDirection="column"
      backgroundColor={palette.surface}
    >
      <text
        height={1}
        flexShrink={0}
        attributes={TextAttributes.BOLD}
        fg={errors ? palette.yellow : palette.text}
      >
        {terminalLine(
          `${tiny ? "Работают" : "РАБОТАЮТ"} ${active}${errors ? ` · ошибок ${errors}` : " · без ошибок"}`,
          width,
        )}
      </text>
      {!tiny && (
        <text height={1} flexShrink={0} fg={palette.muted}>
          {terminalLine(
            searching
              ? `Поиск: ${list.search}_`
              : `${list.filter === "all" ? "Все" : list.filter === "active" ? "Работают" : "Завершены"} · F фильтр · / поиск ${list.search}`,
            width,
          )}
        </text>
      )}
      {list.childId && (
        <DialogAction
          label="Все владельцы"
          id="background-filter-reset"
          palette={palette}
          onSelect={() => controller.setBackgroundList({ childId: undefined })}
        />
      )}
      {stopSet && (
        <box
          height={tiny ? 1 : 3}
          flexShrink={0}
          flexDirection="column"
          backgroundColor={palette.raised}
        >
          <text height={1} fg={palette.yellow}>
            {terminalLine(
              tiny
                ? `Все ${stopSet.length}? Enter / Esc`
                : `Остановить все: ${stopSet.length} · текущий разговор`,
              width,
            )}
          </text>
          {!tiny && (
            <text height={1} fg={palette.muted}>
              {terminalLine(
                stopSet.map((task) => task.label).join(", "),
                width,
              )}
            </text>
          )}
          {!tiny && (
            <box height={1} flexDirection="row">
              <DialogAction
                label="Да, остановить"
                palette={palette}
                onSelect={() => {
                  const ids = stopSet.map((task) => task.id);
                  setStopSet(undefined);
                  void controller.stopBackgroundSet(ids);
                }}
              />
              <DialogAction
                label="Отмена"
                palette={palette}
                onSelect={() => setStopSet(undefined)}
              />
            </box>
          )}
        </box>
      )}
      <TerminalScrollbox
        ref={body}
        id="background-tree"
        height={Math.max(1, rows - (stopSet ? (tiny ? 1 : 3) : 0))}
        flexShrink={0}
        focused={false}
        onMouseScroll={() => {
          const top = body.current?.scrollTop ?? 0;
          const item = Math.floor(top / rowHeight);
          if (item < start + 8 || item > start + 48)
            setWindowStart(Math.max(0, item - 16));
        }}
        viewportCulling
        scrollbarOptions={{ visible: false }}
      >
        {!tasks.length && (
          <text fg={palette.muted}>
            {all.length ? "По фильтру задач нет" : "Фоновых задач пока нет"}
          </text>
        )}
        {start > 0 && (
          <box
            height={
              start * rowHeight + groups.indexOf(shown[0]?.childId ?? "main")
            }
            flexShrink={0}
          />
        )}
        {shownGroups.map((group) => (
          <box key={group} flexDirection="column" flexShrink={0}>
            <text height={1} fg={palette.muted}>
              {terminalLine(
                group === "main"
                  ? "Основной агент"
                  : (tasks.find((task) => task.childId === group)?.ownerLabel ??
                      "Помощник"),
                width,
              )}
            </text>
            {shown
              .filter((task) => (task.childId ?? "main") === group)
              .map((task) => {
                const picked = task.id === list.selected;
                const live = backgroundActive(task.state);
                const color = [
                  "failed",
                  "cleanup_unknown",
                  "lost",
                  "interrupted",
                  "output_limit",
                  "timed_out",
                  "start_failed",
                ].includes(task.state)
                  ? palette.red
                  : task.state === "completed"
                    ? palette.green
                    : [
                          "queued",
                          "awaiting_approval",
                          "waiting_resources",
                        ].includes(task.state)
                      ? palette.yellow
                      : live
                        ? palette.accent
                        : palette.muted;
                const elapsed = elapsedSeconds(
                  Math.max(
                    0,
                    (live
                      ? now
                      : Date.parse(task.finishedAt ?? task.updatedAt)) -
                      Date.parse(task.acceptedAt),
                  ),
                );
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: Rows also have captured keyboard selection.
                  <box
                    key={task.id}
                    id={`background-row-${task.id}`}
                    height={rowHeight}
                    flexShrink={0}
                    flexDirection="column"
                    backgroundColor={picked ? palette.raised : palette.surface}
                    onMouseDown={(event) => {
                      if (
                        event.button === 0 &&
                        !renderer.getSelection()?.getSelectedText()
                      )
                        pressed.current = task.id;
                    }}
                    onMouseUp={(event) => {
                      const id = pressed.current;
                      pressed.current = undefined;
                      if (
                        event.button === 0 &&
                        id === task.id &&
                        !event.isDragging &&
                        !renderer.getSelection()?.getSelectedText()
                      )
                        controller.setBackgroundList({ selected: id });
                    }}
                    onMouseDrag={() => {
                      pressed.current = undefined;
                    }}
                  >
                    <text
                      height={1}
                      fg={picked ? palette.accent : palette.text}
                    >
                      {terminalLine(
                        tiny
                          ? `${picked ? ">" : " "} ${terminalLine(task.label, Math.max(3, width - 14))} ${backgroundStateLabels[task.state]}`
                          : `${picked ? "▸" : " "} ${task.kind === "service" ? "[Сервис]" : "[Проверка]"} ${task.label}`,
                        width,
                      )}
                    </text>
                    {!tiny && (
                      <text height={1} fg={color}>
                        {terminalLine(
                          `  ${backgroundStateLabels[task.state]} · ${elapsed}`,
                          width,
                        )}
                      </text>
                    )}
                    {!tiny && (
                      <text height={1} fg={palette.muted}>
                        {terminalLine(
                          `  ${task.ownerLabel} · ${task.workspaceLabel}`,
                          width,
                        )}
                      </text>
                    )}
                    {rowHeight === 6 &&
                      terminalTextRows(
                        task.tail.slice(-3).join("\n"),
                        task.outputBytes,
                      ).map(({ line, key }) => (
                        <text key={key} height={1} fg={palette.muted}>
                          {terminalLine(`  ${line}`, width)}
                        </text>
                      ))}
                  </box>
                );
              })}
          </box>
        ))}
        {start + shown.length < tasks.length && (
          <box
            height={
              (tasks.length - start - shown.length) * rowHeight +
              groups.length -
              groups.indexOf(shown.at(-1)?.childId ?? "main") -
              1
            }
            flexShrink={0}
          />
        )}
      </TerminalScrollbox>
      {!tiny && (
        <box height={2} flexShrink={0} flexDirection="column">
          <text height={1} fg={palette.muted}>
            {terminalLine(
              selected
                ? `${selected.ownerLabel} · ${selected.workspaceLabel}`
                : list.selected
                  ? "Выбранная задача скрыта фильтром"
                  : "↑↓ выбор · Enter вывод · S остановить",
              width,
            )}
          </text>
          <text
            height={1}
            fg={
              selected?.cleanup.recoveryRequired ? palette.red : palette.muted
            }
          >
            {terminalLine(
              selected
                ? selected.cleanup.recoveryRequired
                  ? "Завершение процессов не подтверждено"
                  : selected.readiness === "signal_seen"
                    ? "Сигнал готовности получен"
                    : selected.kind === "service" &&
                        backgroundActive(selected.state)
                      ? "Запущен · готовность неизвестна"
                      : backgroundStateLabels[selected.state]
                : "",
              width,
            )}
          </text>
        </box>
      )}
      <box height={1} flexShrink={0} flexDirection="row">
        {[tiny ? "Откр." : "Открыть", tiny ? "Стоп" : "Стоп S", "Назад"].map(
          (label, i) => (
            <DialogAction
              key={label}
              id={`background-action-${i}`}
              label={label}
              palette={palette}
              active={action === i + 1}
              disabled={
                i < 2 &&
                (!selected || (i === 1 && !backgroundActive(selected.state)))
              }
              onSelect={actions[i]!}
            />
          ),
        )}
        {!tiny && (
          <DialogAction
            label="Все A"
            palette={palette}
            disabled={!active}
            onSelect={() =>
              setStopSet(
                all
                  .filter((task) => backgroundActive(task.state))
                  .map((task) => ({ id: task.id, label: task.label })),
              )
            }
          />
        )}
      </box>
    </box>
  );
}
