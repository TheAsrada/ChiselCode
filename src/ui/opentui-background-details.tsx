/** @jsxImportSource @opentui/react */
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useLayoutEffect, useRef, useState } from "react";
import { backgroundActive } from "../background/contracts.js";
import { backgroundStateLabels } from "../background/presentation.js";
import type { Palette } from "./appearance.js";
import { MenuActions, useMenuNavigation } from "./menu-navigation.js";
import { useClipboardActions } from "./opentui-clipboard.js";
import { DialogAction, dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";
import { capturedInputOwner, useUiKeyboard } from "./overlay-input.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import {
  terminalLine,
  terminalSlice,
  terminalTextRows,
} from "./terminal-text.js";
import type {
  TuiPresentationController as TuiController,
  TuiViewState,
} from "./tui-controller.js";
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
  const [deleteId, setDeleteId] = useState<string>();
  const layout = dialogLayout(width, height);
  const tiny = height < 12 || width < 30;
  const rows = Math.max(
    1,
    layout.popupHeight - (layout.tiny ? 5 : tiny ? 7 : layout.roomy ? 11 : 9),
  );
  const inner = Math.max(1, layout.popupWidth - (layout.tiny ? 2 : 4));
  const section = viewer.section;
  const sections = ["output", "info", "result"] as const;
  const active = task ? backgroundActive(task.state) : false;
  const owner = `background-view:${controller.conversationId}:${controller.currentGeneration}`;
  const anchor = `${viewer.id}:${section}`;
  const menuActions = [
    {
      id: "background-detail-back",
      label: "Назад",
      run: () => controller.hideBackground(),
    },
    {
      id: "background-detail-stop",
      label: "Остановить",
      disabled: !active,
      run: () => {
        void controller.stopBackground(viewer.id);
      },
    },
    {
      id: "background-promote",
      label: "В фон",
      disabled: !task?.foreground || !active,
      run: () => {
        void controller.promoteBackground(viewer.id);
      },
    },
    {
      id: "background-copy",
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
    {
      id: "background-previous",
      label: "Ранее",
      disabled: !viewer.page || viewer.page.cursor <= 0,
      run: () => {
        controller.setBackgroundView({ follow: false });
        void controller.loadBackground(
          viewer.id,
          false,
          Math.max(0, (viewer.page?.cursor ?? 0) - 32768),
        );
      },
    },
    {
      id: "background-next",
      label: "Дальше",
      disabled: !viewer.page || viewer.page.next >= viewer.page.end,
      run: () => {
        controller.setBackgroundView({ follow: false });
        void controller.loadBackground(viewer.id, false, viewer.page?.next);
      },
    },
    {
      id: "background-follow",
      label: "В конец / Следить",
      run: () => {
        controller.setBackgroundView({ follow: true });
        void controller.loadBackground(viewer.id, true);
      },
    },
    {
      id: "background-command",
      label: "Копировать команду",
      run: () => {
        void clipboard?.copyText(task?.commandPreview ?? "");
      },
    },
    {
      id: "background-path",
      label: "Копировать путь",
      run: () => {
        void clipboard?.copyText(task?.workspace ?? "");
      },
    },
    {
      id: "background-recover",
      label: "Восстановить очистку",
      disabled: active || !task?.cleanup.recoveryRequired,
      run: () => {
        void controller.recoverBackground(viewer.id);
      },
    },
    {
      id: "background-retry",
      label: "Повторить",
      disabled:
        active ||
        !!task?.cleanup.recoveryRequired ||
        !task?.cleanup.confirmed ||
        !task.replayable ||
        !onRetry,
      run: () => {
        controller.hideBackground();
        controller.hideBackgroundPanel();
        onRetry?.(viewer.id);
      },
    },
    {
      id: "background-history-delete",
      label: "Удалить историю…",
      disabled: active || !task?.cleanup.confirmed,
      run: () => setDeleteId(viewer.id),
    },
  ];
  const navigation = useMenuNavigation(
    ["tabs", "search", "body", "actions"],
    menuActions,
    "body",
  );
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
              ? "Не повторяйте команду. Выберите «Восстановить очистку» для проверки исходного backend; без подтверждения блокировка сохраняется."
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
    if (
      navigation.area !== "search" ||
      ["tab", "escape"].includes(key.name) ||
      deleteId
    ) {
      key.preventDefault();
      key.stopPropagation();
    }
    if (
      navigation.area !== "search" &&
      key.shift &&
      ["left", "right"].includes(key.name)
    ) {
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
    if (deleteId) {
      if (key.name === "escape") setDeleteId(undefined);
      else if (
        ["return", "enter"].includes(key.name) &&
        !key.repeated &&
        deleteId === viewer.id &&
        !active &&
        task?.cleanup.confirmed
      ) {
        const id = deleteId;
        setDeleteId(undefined);
        void controller.deleteBackgroundHistory(id);
      }
      return;
    }
    if (navigation.handle(key)) return;
    if (key.name === "escape") {
      if (navigation.area === "search") {
        navigation.setArea("body");
        if (section === "output")
          void controller.searchBackground(viewer.id, "");
        return;
      }
      controller.hideBackground();
      return;
    }
    if (navigation.area === "search") return;
    if (navigation.area === "tabs" && ["left", "right"].includes(key.name)) {
      controller.setBackgroundView({
        section:
          sections[
            (sections.indexOf(section) + (key.name === "left" ? 2 : 1)) % 3
          ],
      });
    } else if (key.name === "/") navigation.setArea("search");
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
        {sections.map((item) => (
          <DialogAction
            key={item}
            label={
              item === "output"
                ? "Вывод"
                : item === "info"
                  ? "Сведения"
                  : "Итог"
            }
            active={navigation.area === "tabs" && section === item}
            palette={palette}
            onSelect={() => controller.setBackgroundView({ section: item })}
          />
        ))}
      </box>
      <input
        id="background-output-search"
        value={viewer.search ?? ""}
        focused={navigation.area === "search" && !deleteId}
        placeholder="Поиск в выводе…"
        backgroundColor={palette.raised}
        textColor={palette.text}
        onInput={(search) =>
          controller.setBackgroundView({ search, searchOutput: undefined })
        }
        onSubmit={(value) => {
          if (typeof value === "string" && section === "output")
            void controller.searchBackground(viewer.id, value);
          navigation.setArea("body");
        }}
      />
      <TerminalScrollbox
        id="background-output"
        ref={body}
        height={rows}
        flexShrink={0}
        focused={false}
        stickyScroll={viewer.follow && section === "output"}
        stickyStart="bottom"
        onMouseDown={() => {
          navigation.setArea("body");
          controller.setBackgroundView({ follow: false });
        }}
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
      {deleteId ? (
        <text height={1} fg={palette.yellow}>
          {terminalLine("Удалить историю? Enter / Esc", inner)}
        </text>
      ) : (
        <MenuActions
          id="background-detail-actions"
          actions={menuActions}
          navigation={navigation}
          width={inner}
          palette={palette}
          compact
        />
      )}
      {!tiny && (
        <text height={1} fg={palette.muted}>
          {terminalLine(
            viewer.notice ||
              (!viewer.follow && section === "output"
                ? `Новые строки: ${Math.max(0, (task?.outputLines ?? 0) - (viewer.pausedAtLine ?? task?.outputLines ?? 0))} · В конец через действия`
                : undefined) ||
              (navigation.area === "actions"
                ? "←→ действие · Enter · Esc назад"
                : "Tab области · ↑↓ прокрутка · Esc"),
            inner,
          )}
        </text>
      )}
    </OpenTuiDialog>
  );
}
