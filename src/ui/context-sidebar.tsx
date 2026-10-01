/** @jsxImportSource @opentui/react */
import { basename } from "node:path";
import React from "react";
import { contextProgress } from "../core/context-usage.js";
import { type Palette, THEMES } from "./appearance.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiViewState } from "./tui-controller.js";

function safeLine(value: string, limit = 35): string {
  return terminalLine(value, limit);
}

export function ContextSidebar({
  state,
  width = 40,
  height = 24,
  focused = false,
  palette = THEMES.obsidian,
}: {
  state: TuiViewState;
  width?: number;
  height?: number;
  focused?: boolean;
  palette?: Palette;
}) {
  const quiet = palette.muted;
  const title = palette.accent;
  const usage = state.usage;
  const progress = contextProgress(usage?.contextSnapshot);
  const files = state.gitChanges?.files ?? [];
  const totalTokens = usage
    ? usage.totalTokens.inputTokens + usage.totalTokens.outputTokens
    : 0;
  const maxFiles = Math.max(0, Math.min(8, height - 15));
  return (
    <box
      width={width}
      height={height}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={palette.surface}
    >
      <text fg={title}>{focused ? "> Контекст" : "Контекст"}</text>
      <text fg={quiet}>
        {safeLine(`${usage?.provider ?? "-"} / ${usage?.model ?? "-"}`)}
      </text>
      <text fg={quiet}>
        Последний запрос:{" "}
        {progress.label.replaceAll("—", "-").replaceAll("·", "|")}
      </text>
      {progress.barPercent !== undefined && (
        <text fg={title}>
          {"#".repeat(Math.round(progress.barPercent / 10))}
          {".".repeat(10 - Math.round(progress.barPercent / 10))}
        </text>
      )}
      <text fg={title}>Сессия</text>
      <text fg={quiet}>{totalTokens.toLocaleString("ru-RU")} токенов</text>
      {usage &&
        usage.totalCost !== undefined &&
        Number.isFinite(usage.totalCost) &&
        usage.totalCost > 0 && (
          <text fg={quiet}>${usage.totalCost.toFixed(4)}</text>
        )}
      <text fg={title}>Проект</text>
      <text fg={quiet}>{safeLine(state.projectPath)}</text>
      <text fg={quiet}>
        {state.gitChanges
          ? safeLine(state.gitChanges.branch)
          : "Без репозитория"}
      </text>
      {state.gitChanges && (
        <React.Fragment>
          <text fg={title}>Изменения | {state.gitChanges.totalFiles}</text>
          {files.length === 0 && <text fg={quiet}>Нет изменений</text>}
          {files.slice(0, maxFiles).map((file) => (
            <text key={file.path} fg={quiet}>
              {safeLine(basename(file.path), 25)} +{file.additions} -
              {file.deletions}
            </text>
          ))}
          {state.gitChanges.totalFiles > maxFiles && (
            <text fg={quiet}>
              ...ещё {state.gitChanges.totalFiles - maxFiles}
            </text>
          )}
        </React.Fragment>
      )}
      {(state.toolActivity || state.overlay) && (
        <React.Fragment>
          <text fg={title}>Активность</text>
          <text fg={palette.yellow}>
            {safeLine(state.overlay ?? state.toolActivity ?? "")}
          </text>
        </React.Fragment>
      )}
    </box>
  );
}
