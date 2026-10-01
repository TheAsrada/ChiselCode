/** @jsxImportSource @opentui/react */
import type { ReactNode } from "react";
import { AGENT_MODE_LABELS, type AgentMode } from "../runtime/agent-mode.js";
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
  onToggleMode,
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
  onToggleMode: () => void;
  onSubmit: () => void;
}) {
  const modeColor = agentMode === "plan" ? palette.yellow : palette.accent;
  const activity = busy
    ? !runningMode
      ? "в очереди"
      : runningMode !== agentMode
        ? `сейчас ${AGENT_MODE_LABELS[runningMode]}`
        : agentMode === "plan"
          ? "планирует"
          : "отвечает"
    : "";
  const caption = (
    busy && runningMode && runningMode !== agentMode
      ? [activity, model]
      : [model, activity]
  )
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
        <box flexDirection="row" height={1} flexGrow={1} minWidth={0}>
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
          <text height={1} fg={palette.muted}>
            {caption
              ? ` · ${terminalSafeText(caption, Math.max(1, width - (width >= 60 ? 30 : 20)))}`
              : ""}
          </text>
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
    </box>
  );
}
