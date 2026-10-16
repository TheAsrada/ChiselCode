/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { backgroundActive } from "../background/contracts.js";
import { backgroundStateLabels } from "../background/presentation.js";
import type { Palette } from "./appearance.js";
import { BackgroundTaskList } from "./background-task-list.js";
import { dialogLayout, OpenTuiDialog } from "./opentui-dialog.js";

import { terminalLine } from "./terminal-text.js";
import type { TuiController, TuiViewState } from "./tui-controller.js";
export function OpenTuiBackgroundTasks({
  controller,
  view,
  width,
  height,
  palette,
}: {
  controller: TuiController;
  view: TuiViewState;
  width: number;
  height: number;
  palette: Palette;
}) {
  const layout = dialogLayout(width, height);
  const tiny = height < 12 || width < 30;
  const inner = Math.max(1, layout.popupWidth - (layout.tiny ? 2 : 4));
  const contentHeight = Math.max(
    1,
    layout.popupHeight - (layout.tiny ? 1 : layout.roomy ? 5 : 3),
  );
  const split = inner >= 72 && contentHeight >= 16;
  const listWidth = split ? Math.floor(inner * 0.58) : inner;
  const detailWidth = inner - listWidth - 3;
  const task = view.backgroundTasks?.find(
    (task) => task.id === view.backgroundList?.selected,
  );
  const color =
    task?.state === "completed"
      ? palette.green
      : task?.cleanup.recoveryRequired || task?.state === "failed"
        ? palette.red
        : task && backgroundActive(task.state)
          ? palette.accent
          : palette.muted;
  const used = task ? Math.min(1, task.outputBytes / task.outputLimit) : 0;
  const barWidth = Math.max(1, detailWidth - 2);
  return (
    <OpenTuiDialog
      id="background-tasks"
      width={width}
      height={height}
      palette={palette}
      onClose={() => controller.hideBackgroundPanel()}
    >
      <text
        height={1}
        flexShrink={0}
        attributes={TextAttributes.BOLD}
        fg={palette.accent}
      >
        {terminalLine(tiny ? "Фоновые задачи" : "ФОНОВЫЕ ЗАДАЧИ", inner)}
      </text>
      <box flexDirection="row" height={contentHeight} flexShrink={0}>
        <BackgroundTaskList
          controller={controller}
          view={view}
          width={listWidth}
          height={contentHeight}
          palette={palette}
          focused
          onBack={() => controller.hideBackgroundPanel()}
        />
        {split && (
          <>
            <box
              width={1}
              marginLeft={1}
              marginRight={1}
              height={contentHeight}
              backgroundColor={palette.border}
            />
            <box
              width={detailWidth}
              height={contentHeight}
              flexDirection="column"
            >
              <text
                height={1}
                attributes={TextAttributes.BOLD}
                fg={palette.muted}
              >
                ВЫБРАННАЯ ЗАДАЧА
              </text>
              <box height={1} />
              <text
                height={1}
                fg={palette.text}
                attributes={TextAttributes.BOLD}
              >
                {terminalLine(
                  task?.label ?? "Выберите команду слева",
                  detailWidth,
                )}
              </text>
              <text height={1} fg={color}>
                {task ? `● ${backgroundStateLabels[task.state]}` : ""}
              </text>
              <box height={1} />
              <text height={1} fg={palette.muted}>
                ВЛАДЕЛЕЦ / ПРОЕКТ
              </text>
              <text height={1} fg={palette.text}>
                {terminalLine(task?.ownerLabel ?? "", detailWidth)}
              </text>
              <text height={1} fg={palette.text}>
                {terminalLine(task?.workspaceLabel ?? "", detailWidth)}
              </text>
              <box height={1} />
              <text height={2} fg={color}>
                {task?.cleanup.recoveryRequired
                  ? "Завершение процессов\nне подтверждено"
                  : task?.readiness === "signal_seen"
                    ? "Сигнал готовности получен"
                    : task?.kind === "service" && backgroundActive(task.state)
                      ? "Сервис запущен\nГотовность не проверена"
                      : task?.exitCode != null
                        ? `Реальный код выхода: ${task.exitCode}`
                        : "Ожидаем результат команды"}
              </text>
              <box height={1} />
              <text height={1} fg={palette.muted}>
                СОХРАНЁННЫЙ ВЫВОД
              </text>
              <text height={1} fg={palette.accent}>
                {"━".repeat(Math.round(used * barWidth))}
                <span fg={palette.border}>
                  {"─".repeat(barWidth - Math.round(used * barWidth))}
                </span>
              </text>
              <text height={1} fg={palette.muted}>
                {task
                  ? `${(task.outputBytes / 1024).toFixed(1)} KiB · ${(used * 100).toFixed(1)}% лимита`
                  : ""}
              </text>
              <box flexGrow={1} />
              <text height={2} fg={palette.muted}>
                {"Закрытие окна сохраняет\nработающую команду"}
              </text>
            </box>
          </>
        )}
      </box>
    </OpenTuiDialog>
  );
}
