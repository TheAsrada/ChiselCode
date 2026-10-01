/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import { AGENT_MODE_LABELS, type AgentMode } from "../runtime/agent-mode.js";
import {
  APPROVAL_MODE_LABELS,
  APPROVAL_MODES,
  type ApprovalMode,
} from "../security/approval-mode.js";
import type { Palette } from "./appearance.js";
import { terminalSafeText } from "./opentui-transcript.js";

/** Shared composer surface; the native textarea keeps ownership of editing. */
export function OpenTuiPrompt({
  children,
  palette,
  width,
  focused,
  hasDraft,
  busy,
  model,
  agentMode,
  runningMode,
  approvalMode,
  runningApprovalMode,
  onToggleMode,
  onApprovalModeChange,
  onModelSelect,
  onSubmit,
}: {
  children: ReactNode;
  palette: Palette;
  width: number;
  focused: boolean;
  hasDraft: boolean;
  busy?: boolean;
  model?: string;
  agentMode: AgentMode;
  runningMode?: AgentMode;
  approvalMode: ApprovalMode;
  runningApprovalMode?: ApprovalMode;
  onToggleMode: () => void;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  onModelSelect?: () => void;
  onSubmit: () => void;
}) {
  const modeColor = agentMode === "plan" ? palette.yellow : palette.accent;
  const differentRun =
    !!runningMode &&
    (runningMode !== agentMode ||
      (!!runningApprovalMode && runningApprovalMode !== approvalMode));
  const activity = busy
    ? !runningMode
      ? "в очереди"
      : differentRun
        ? `сейчас ${AGENT_MODE_LABELS[runningMode]}${runningApprovalMode ? ` · ${APPROVAL_MODE_LABELS[runningApprovalMode]}` : ""}`
        : agentMode === "plan"
          ? "планирует"
          : "отвечает"
    : "";
  const caption = (busy && differentRun ? [activity, model] : [model, activity])
    .filter(Boolean)
    .join(" · ");
  return (
    <box
      id="prompt"
      width="100%"
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={focused ? modeColor : palette.border}
      backgroundColor={palette.surface}
      title={hasDraft ? " Черновик " : " Сообщение "}
      titleColor={palette.muted}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      flexDirection="column"
    >
      {children}
      <box
        height={1}
        width="100%"
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <box flexDirection="row" height={1} flexGrow={1} minWidth={0} gap={1}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Shift+Tab also switches modes. */}
          <box
            id="prompt-agent-mode"
            height={1}
            flexShrink={0}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={palette.raised}
            onMouseUp={(event) => {
              event.stopPropagation();
              onToggleMode();
            }}
          >
            <text fg={modeColor} height={1} selectable={false}>
              <strong>{AGENT_MODE_LABELS[agentMode]}</strong>
            </text>
          </box>
          <box flexDirection="row" height={1} gap={1}>
            {APPROVAL_MODES.filter(
              (mode) => width >= 35 || mode === approvalMode,
            ).map((mode) => (
              // biome-ignore lint/a11y/noStaticElementInteractions: F4 also switches permission modes.
              <box
                key={mode}
                id={`prompt-approval-${mode}`}
                height={1}
                flexShrink={0}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  mode === approvalMode ? palette.raised : palette.surface
                }
                onMouseUp={(event) => {
                  event.stopPropagation();
                  onApprovalModeChange(
                    width < 35 ? (mode === "ask" ? "auto" : "ask") : mode,
                  );
                }}
              >
                <text
                  height={1}
                  selectable={false}
                  fg={
                    mode === approvalMode
                      ? mode === "auto"
                        ? palette.yellow
                        : palette.text
                      : palette.muted
                  }
                >
                  {mode === "ask"
                    ? width >= 60
                      ? "С подтверждением"
                      : width >= 35
                        ? "Спрашивать"
                        : "Ask"
                    : "Авто"}
                </text>
              </box>
            ))}
          </box>
        </box>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Enter also submits the message. */}
        <box
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={hasDraft ? palette.raised : palette.surface}
          onMouseUp={(event) => {
            event.stopPropagation();
            if (hasDraft) onSubmit();
          }}
        >
          <text
            fg={hasDraft ? palette.accent : palette.muted}
            height={1}
            selectable={false}
          >
            {width >= 60 ? "Отправить ↵" : "↵"}
          </text>
        </box>
      </box>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: /model also opens the model picker. */}
      <text
        id="prompt-model"
        height={1}
        fg={palette.muted}
        selectable={!onModelSelect}
        onMouseUp={(event) => {
          event.stopPropagation();
          onModelSelect?.();
        }}
      >
        {terminalSafeText(
          `${caption || "Модель не выбрана"}${onModelSelect ? " ▾" : ""}`,
          Math.max(1, width - 6),
        )}
      </text>
    </box>
  );
}
