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
  const snapshot = state.contextSnapshot ?? usage?.contextSnapshot;
  const preferMetadata =
    snapshot?.windowSource !== "provider" &&
    state.modelCapabilities?.limitsSource === "provider";
  const window = preferMetadata
    ? (state.modelCapabilities?.contextWindow ?? snapshot?.contextWindow)
    : (snapshot?.contextWindow ?? state.modelCapabilities?.contextWindow);
  const windowSource = preferMetadata
    ? state.modelCapabilities?.limitsSource
    : (snapshot?.windowSource ?? state.modelCapabilities?.limitsSource);
  const progress = contextProgress(
    snapshot ? { ...snapshot, contextWindow: window } : undefined,
  );
  const selection = state.modelSelection;
  const barWidth = Math.max(4, Math.min(20, width - 12));
  const filled =
    (progress.barPercent ?? 0) > 0
      ? Math.max(1, Math.round(((progress.barPercent ?? 0) / 100) * barWidth))
      : 0;
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
      <text fg={palette.text}>
        {safeLine(selection?.model ?? usage?.model ?? "-", width - 2)}
      </text>
      <text fg={quiet}>
        {safeLine(
          `${selection?.provider ?? usage?.provider ?? "-"}${selection?.profileId ? ` / ${selection.profileId}` : ""}`,
          width - 2,
        )}
      </text>
      <text fg={quiet}>
        {window
          ? `Окно: ${window.toLocaleString("ru-RU")}${windowSource === "catalog" ? " (каталог)" : windowSource === "config" ? " (настройки)" : ""}`
          : "Размер окна неизвестен"}
      </text>
      <text fg={quiet}>{snapshot ? progress.label : "Заполнение: —"}</text>
      {progress.barPercent !== undefined && (
        <text fg={title}>
          <span bg={title}>{" ".repeat(filled)}</span>
          <span bg={palette.border}>{" ".repeat(barWidth - filled)}</span>
        </text>
      )}
      {snapshot?.status === "estimated" && (
        <text fg={quiet}>~ приблизительная оценка</text>
      )}
      {usage && (
        <text fg={quiet}>
          Расход сессии: {totalTokens.toLocaleString("ru-RU")}
        </text>
      )}
      {state.sideSpend && (
        <text fg={quiet}>
          {safeLine(
            `Побочные: ${state.sideSpend.usage.inputTokens + state.sideSpend.usage.outputTokens} ток.${state.sideSpend.unknownUsage ? " · часть неизвестна" : ""}`,
            width - 2,
          )}
        </text>
      )}
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
