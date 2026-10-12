/** @jsxImportSource @opentui/react */
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useLayoutEffect, useRef, useState } from "react";
import { backgroundActive } from "../background/contracts.js";
import { backgroundStateLabels } from "../background/presentation.js";
import type { Palette } from "./appearance.js";
import { useClipboardActions } from "./opentui-clipboard.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import {
  terminalLine,
  terminalSlice,
  terminalTextRows,
} from "./terminal-text.js";
import type { TuiController, TuiViewState } from "./tui-controller.js";
export function OpenTuiBackgroundDetails({
  controller,
  view,
  width,
  height,
  palette,
  onRetry,
}: {
  controller: TuiController;
  view: TuiViewState;
  width: number;
  height: number;
  palette: Palette;
  onRetry?(id: string): void;
}) {
  const viewer = view.backgroundView!;
  const task = view.backgroundTasks?.find((task) => task.id === viewer.id);
  const renderer = useRenderer();
  const clipboard = useClipboardActions();
  const body = useRef<ScrollBoxRenderable>(null);
  const [action, setAction] = useState(0);
  const [secondary, setSecondary] = useState(false);
  const [searching, setSearching] = useState(false);
  const [deleteId, setDeleteId] = useState<string>();
  const layout = dialogLayout(width, height);
  const tiny = height < 12 || width < 30;
  const rows = Math.max(
    1,
    layout.popupHeight -
      (layout.tiny ? 3 : tiny ? 5 : 8) -
      (secondary && !tiny ? 1 : 0),
  );
  const inner = Math.max(1, layout.popupWidth - (layout.tiny ? 2 : 4));
  const section = viewer.section;
  const sections = ["output", "info", "result"] as const;
  const active = task ? backgroundActive(task.state) : false;
  const owner = `background-view:${controller.conversationId}:${controller.currentGeneration}`;
  const anchor = `${viewer.id}:${section}`;
  const actions = [
    { label: "Назад", run: () => controller.hideBackground() },
    ...(active
      ? [
          {
            label: tiny ? "Стоп" : "Остановить S",
            run: () => {
              void controller.stopBackground(viewer.id);
            },
          },
        ]
      : []),
    ...(task?.foreground && active
      ? [
          {
            label: "В фон",
            run: () => {
              void controller.promoteBackground(viewer.id);
            },
          },
        ]
      : []),
    ...(!tiny
      ? [
          {
            label: "Копировать",
            run: () => {
              void clipboard?.copyText(
                renderer.getSelection()?.getSelectedText() ||
                  viewer.searchOutput ||
                  viewer.page?.text ||
                  "",
              );
            },
          },
          { label: "Ещё", run: () => setSecondary((value) => !value) },
        ]
      : []),
  ];
  const lines =
    section === "output"
      ? (viewer.searchOutput ?? viewer.page?.text ?? "").split("\n")
      : section === "info"
        ? [
            task?.commandPreview ?? "Команда недоступна",
            `Владелец: ${task?.ownerLabel ?? "неизвестен"}`,
            `Папка: ${task?.workspace ?? ""}`,
            `ID: ${viewer.id}`,
            `Копия: ${task?.worktree?.base ?? "Текущий проект"}`,
            `Принято: ${task?.acceptedAt}`,
            `Срок: ${task?.deadline}`,
            `Готовность: ${task?.readiness === "signal_seen" ? "Сигнал готовности получен" : task?.readiness === "verified_probe" ? "Сервис проверен" : "Не проверена"}`,
            ...(task?.resources.map(
              (resource) => `${resource.mode}: ${resource.resource}`,
            ) ?? []),
          ]
        : [
            `${task ? backgroundStateLabels[task.state] : "Запись недоступна"}${task?.exitCode != null ? ` · код ${task.exitCode}` : ""}`,
            `Сигнал: ${task?.signal ?? "нет"}`,
            `Завершение процессов: ${task?.cleanup.confirmed ? "подтверждён" : "не подтверждён"}`,
            `Вывод: ${task?.outputBytes ?? 0} / ${task?.outputLimit ?? 0} байт`,
            task?.truncated ? "Часть вывода не сохранена" : "",
            task?.error ?? "",
            task?.cleanup.recoveryRequired
              ? "Не повторяйте команду. H — проверить подтверждение исходного backend; при его отсутствии блокировка сохраняется."
              : "",
          ];
  const visible = (
    viewer.search && viewer.searchOutput === undefined
      ? lines.filter((line) =>
          line.toLowerCase().includes(viewer.search!.toLowerCase()),
        )
      : lines
  ).slice(-512);
  // biome-ignore lint/correctness/useExhaustiveDependencies: New pages restore the saved viewport and follow mode.
  useLayoutEffect(() => {
    const scroll = body.current;
    if (!scroll) return;
    scroll.scrollTo(
      viewer.follow && section === "output"
        ? scroll.scrollHeight
        : (controller.backgroundPresentation.scroll.get(anchor) ?? 0),
    );
    return () => {
      controller.backgroundPresentation.scroll.set(anchor, scroll.scrollTop);
    };
  }, [anchor, viewer.page, section, viewer.follow, controller]);
  useUiKeyboard((key) => {
    if (capturedInputOwner(key) !== owner) return;
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.ctrl || key.meta || key.option) return;
    key.preventDefault();
    key.stopPropagation();
    if (key.shift && ["left", "right"].includes(key.name)) {
      controller.setBackgroundView({
        horizontal: Math.max(
          0,
          Math.min(
            32768,
            (viewer.horizontal ?? 0) +
              (key.name === "left" ? -1 : 1) *
                Math.max(1, Math.floor(inner / 2)),
          ),
        ),
      });
      return;
    }
    if (searching) {
      if (["escape", "return", "enter"].includes(key.name)) {
        setSearching(false);
        if (section === "output")
          void controller.searchBackground(
            viewer.id,
            key.name === "escape" ? "" : (viewer.search ?? ""),
          );
      } else if (key.name === "backspace")
        controller.setBackgroundView({
          search: [...(viewer.search ?? "")].slice(0, -1).join(""),
          searchOutput: undefined,
        });
      else if (
        key.sequence &&
        [...key.sequence].length === 1 &&
        (viewer.search?.length ?? 0) < 120
      )
        controller.setBackgroundView({
          search: (viewer.search ?? "") + key.sequence,
          searchOutput: undefined,
        });
      return;
    }
    if (key.name === "escape") {
      setDeleteId(undefined);
      controller.hideBackground();
    } else if (
      key.name === "d" &&
      deleteId === viewer.id &&
      !active &&
      task?.cleanup.confirmed
    ) {
      setDeleteId(undefined);
      void controller.deleteBackgroundHistory(viewer.id);
    } else if (key.name === "s" && active)
      void controller.stopBackground(viewer.id);
    else if (key.name === "h" && !active && task?.cleanup.recoveryRequired)
      void controller.recoverBackground(viewer.id);
    else if (key.name === "b" && task?.foreground && active)
      void controller.promoteBackground(viewer.id);
    else if (key.name === "tab")
      setAction(
        (current) =>
          (current + (key.shift ? actions.length : 1)) % (actions.length + 1),
      );
    else if (["enter", "return"].includes(key.name))
      actions[Math.max(0, action - 1)]?.run();
    else if (["left", "right"].includes(key.name))
      controller.setBackgroundView({
        section:
          sections[
            (sections.indexOf(section) + (key.name === "left" ? 2 : 1)) % 3
          ],
      });
    else if (key.name === "/") setSearching(true);
    else if (
      ["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name)
    ) {
      controller.setBackgroundView({ follow: false });
      const scroll = body.current;
      if (scroll) {
        scroll.scrollTo(
          key.name === "home"
            ? 0
            : key.name === "end"
              ? scroll.scrollHeight
              : Math.max(
                  0,
                  scroll.scrollTop +
                    (["up", "pageup"].includes(key.name) ? -1 : 1) *
                      (key.name.startsWith("page") ? rows : 1),
                ),
        );
        controller.backgroundPresentation.scroll.set(anchor, scroll.scrollTop);
      }
    }
  });
  return (
    <OpenTuiDialog
      id="background-details"
      width={width}
      height={height}
      palette={palette}
      onClose={() => controller.hideBackground()}
    >
      <text height={1} attributes={TextAttributes.BOLD} fg={palette.text}>
        {terminalLine(task?.label ?? "Фоновая задача недоступна", inner)}
      </text>
      <box height={1} flexShrink={0} flexDirection="row">
        {(tiny ? [section] : sections).map((item) => (
          <DialogAction
            key={item}
            label={
              item === "output"
                ? "Вывод"
                : item === "info"
                  ? "Сведения"
                  : "Итог"
            }
            active={section === item}
            palette={palette}
            onSelect={() => controller.setBackgroundView({ section: item })}
          />
        ))}
      </box>
      {!tiny && (
        <text height={1} fg={palette.muted}>
          {terminalLine(
            viewer.notice ??
              `${task?.ownerLabel ?? ""} · ${task?.workspaceLabel ?? ""}${viewer.loading ? " · Чтение…" : ""}${viewer.search ? ` · Поиск: ${viewer.search}` : ""}`,
            inner,
          )}
        </text>
      )}
      <TerminalScrollbox
        id="background-output"
        ref={body}
        height={rows}
        flexShrink={0}
        focused={false}
        stickyScroll={viewer.follow && section === "output"}
        stickyStart="bottom"
        onMouseDown={() => controller.setBackgroundView({ follow: false })}
        onMouseScroll={() => {
          controller.setBackgroundView({ follow: false });
          if (body.current)
            controller.backgroundPresentation.scroll.set(
              anchor,
              body.current.scrollTop,
            );
        }}
      >
        {viewer.page?.expired && section === "output" && (
          <text fg={palette.yellow}>Ранний вывод не сохранён</text>
        )}
        {terminalTextRows(visible.join("\n"), viewer.page?.cursor ?? 0).map(
          ({ line, key }) => (
            <text
              key={`${section}:${key}`}
              height={1}
              fg={palette.text}
              selectable
            >
              {terminalSlice(line, viewer.horizontal ?? 0, inner)}
            </text>
          ),
        )}
        {!visible.some(Boolean) && (
          <text fg={palette.muted}>
            {viewer.loading ? "Чтение сохранённого вывода…" : "Вывода пока нет"}
          </text>
        )}
      </TerminalScrollbox>
      {!tiny && section === "output" && (
        <box height={1} flexShrink={0} flexDirection="row">
          <DialogAction
            label="Раньше"
            disabled={!viewer.page?.cursor}
            palette={palette}
            onSelect={() => {
              controller.setBackgroundView({ follow: false });
              void controller.loadBackground(
                viewer.id,
                false,
                Math.max(0, (viewer.page?.cursor ?? 0) - 32768),
              );
            }}
          />
          <DialogAction
            label="Дальше"
            disabled={!viewer.page || viewer.page.next >= viewer.page.end}
            palette={palette}
            onSelect={() => {
              controller.setBackgroundView({ follow: false });
              void controller.loadBackground(
                viewer.id,
                false,
                viewer.page?.next,
              );
            }}
          />
          <DialogAction
            label={
              viewer.follow
                ? "Следить"
                : `Новые строки: ${Math.max(0, (task?.outputLines ?? 0) - (viewer.pausedAtLine ?? task?.outputLines ?? 0))} / В конец`
            }
            palette={palette}
            active={viewer.follow}
            onSelect={() => {
              controller.setBackgroundView({ follow: true });
              void controller.loadBackground(viewer.id, true);
            }}
          />
        </box>
      )}
      {secondary && !tiny && (
        <box height={1} flexShrink={0} flexDirection="row">
          <DialogAction
            label="Команда"
            palette={palette}
            onSelect={() => {
              void clipboard?.copyText(task?.commandPreview ?? "");
            }}
          />
          <DialogAction
            label="Путь"
            palette={palette}
            onSelect={() => {
              void clipboard?.copyText(task?.workspace ?? "");
            }}
          />
          <DialogAction
            label={task?.cleanup.recoveryRequired ? "Проверить H" : "Повторить"}
            disabled={
              active ||
              (!task?.cleanup.recoveryRequired &&
                (!task?.cleanup.confirmed || !task.replayable))
            }
            palette={palette}
            onSelect={() => {
              if (task?.cleanup.recoveryRequired) {
                void controller.recoverBackground(viewer.id);
                return;
              }
              controller.hideBackground();
              controller.hideBackgroundPanel();
              onRetry?.(viewer.id);
            }}
          />
          <DialogAction
            label="Удалить историю"
            disabled={active || !task?.cleanup.confirmed}
            palette={palette}
            onSelect={() => {
              setDeleteId(viewer.id);
              controller.setBackgroundView({
                notice:
                  "Удаление истории и сохранённых логов: повторно нажмите D для подтверждения.",
              });
            }}
          />
        </box>
      )}
      <box height={1} flexShrink={0} flexDirection="row">
        {actions.map((item, i) => (
          <DialogAction
            key={item.label}
            label={item.label}
            active={action === i + 1}
            palette={palette}
            onSelect={item.run}
          />
        ))}
      </box>
    </OpenTuiDialog>
  );
}
