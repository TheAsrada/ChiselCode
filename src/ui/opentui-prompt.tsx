/** @jsxImportSource @opentui/react */
import React, { type ReactNode } from "react";
import { AGENT_MODE_LABELS, type AgentMode } from "../runtime/agent-mode.js";
import {
  APPROVAL_MODE_LABELS,
  type ApprovalMode,
} from "../security/approval-mode.js";
import type { Palette } from "./appearance.js";
import {
  uiBoxStyle,
  uiColor,
  useUiNativePresentation,
} from "./extension-presentation.js";
import { UiSurface } from "./opentui-composition.js";

import { terminalLine } from "./terminal-text.js";
import { ENTER_KEY } from "./theme.js";

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
  onPermissionsSelect,
  onModelSelect,
  onSubmit,
  compact = false,
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
  onPermissionsSelect: () => void;
  onModelSelect?: () => void;
  onSubmit: () => void;
  compact?: boolean;
}) {
  const native = useUiNativePresentation();
  const decorateEditor = (child: ReactNode) =>
    React.isValidElement<Record<string, unknown>>(child)
      ? React.cloneElement(child, {
          ...(native.fg
            ? {
                textColor: uiColor(palette, native.fg),
                focusedTextColor: uiColor(palette, native.fg),
              }
            : {}),
          ...(native.bg
            ? {
                backgroundColor: uiColor(palette, native.bg),
                focusedBackgroundColor: uiColor(palette, native.bg),
              }
            : {}),
          ...(native.placeholder !== undefined
            ? { placeholder: native.placeholder }
            : {}),
        })
      : child;
  // Keep a single native editor a single child in both compact and full layouts.
  // Children.map wraps it in an array, changing its reconciliation path on resize.
  const editor = React.isValidElement(children)
    ? decorateEditor(children)
    : React.Children.map(children, decorateEditor);
  if (compact)
    return (
      <box
        id="prompt"
        width="100%"
        flexShrink={0}
        backgroundColor={palette.surface}
        {...uiBoxStyle(palette, native)}
      >
        {editor}
      </box>
    );
  const modeColor = agentMode === "plan" ? palette.yellow : palette.accent;
  const differentRun =
    !!runningMode &&
    (runningMode !== agentMode ||
      (!!runningApprovalMode && runningApprovalMode !== approvalMode));
  const activity = busy
    ? !runningMode
      ? "в очереди"
      : differentRun
        ? `сейчас ${AGENT_MODE_LABELS[runningMode]}${runningApprovalMode ? ` | ${APPROVAL_MODE_LABELS[runningApprovalMode]}` : ""}`
        : ""
    : "";
  const caption = (busy && differentRun ? [activity, model] : [model, activity])
    .filter(Boolean)
    .join(" | ");
  return (
    <box
      id="prompt"
      width="100%"
      flexShrink={0}
      border={["left", "top"]}
      borderStyle="single"
      borderColor={focused ? modeColor : palette.border}
      backgroundColor={palette.surface}
      titleColor={palette.muted}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={0}
      paddingBottom={1}
      flexDirection="column"
      {...uiBoxStyle(palette, native)}
      title={native.title ?? (hasDraft ? " Черновик " : " Сообщение ")}
    >
      {editor}
      <UiSurface name="PromptControls">
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
                if (event.button !== 0) return;
                event.stopPropagation();
                onToggleMode();
              }}
            >
              <text fg={modeColor} height={1} selectable={false}>
                <strong>{AGENT_MODE_LABELS[agentMode]}</strong>
              </text>
            </box>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: /permissions opens the picker and F4 cycles modes. */}
            <box
              id="prompt-permissions"
              height={1}
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={palette.raised}
              onMouseUp={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                onPermissionsSelect();
              }}
            >
              <text
                height={1}
                selectable={false}
                fg={
                  approvalMode === "bypassPermissions"
                    ? palette.red
                    : approvalMode === "acceptEdits"
                      ? palette.yellow
                      : palette.text
                }
              >
                {width < 45 && approvalMode === "acceptEdits"
                  ? "Edits"
                  : width < 45 && approvalMode === "dontAsk"
                    ? "Allowed"
                    : APPROVAL_MODE_LABELS[approvalMode]}{" "}
                ▾
              </text>
            </box>
          </box>
          {width >= 30 && (
            // biome-ignore lint/a11y/noStaticElementInteractions: Enter also submits the message.
            <box
              id="prompt-send"
              flexShrink={0}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={hasDraft ? palette.accent : palette.surface}
              onMouseUp={(event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                if (hasDraft) onSubmit();
              }}
            >
              <text
                fg={hasDraft ? palette.bg : palette.muted}
                height={1}
                selectable={false}
              >
                {width >= 60 ? `Отправить | ${ENTER_KEY}` : ENTER_KEY}
              </text>
            </box>
          )}
        </box>
      </UiSurface>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: /model also opens the model picker. */}
      <text
        id="prompt-model"
        height={1}
        fg={palette.muted}
        selectable={!onModelSelect}
        onMouseUp={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          onModelSelect?.();
        }}
      >
        {terminalLine(
          `${caption || "Модель не выбрана"}${onModelSelect ? " ▾" : ""}`,
          Math.max(1, width - 6),
        )}
      </text>
    </box>
  );
}
