/** @jsxImportSource @opentui/react */

import type { TextareaRenderable } from "@opentui/core";
import React from "react";
import type { CommandDescriptor } from "../commands/slash.js";
import type { Palette } from "./appearance.js";
import { UiPaneRegion, UiSurface } from "./opentui-composition.js";
import { OpenTuiPrompt } from "./opentui-prompt.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiViewState } from "./tui-controller.js";

export function OpenTuiComposer({
  width,
  dockExtensionPane,
  visibleSuggestions,
  suggestionStart,
  selectedSuggestionIndex,
  palette,
  composerWidth,
  home,
  height,
  promptFocused,
  editorFocused,
  draft,
  view,
  onToggleMode,
  openPermissions,
  onModelSelect,
  submit,
  editor,
  editorHeight,
  conversationId,
  onEditorFocus,
  onDraftChange,
  defaultModel,
  canCancel,
}: {
  width: number;
  dockExtensionPane: boolean;
  visibleSuggestions: CommandDescriptor[];
  suggestionStart: number;
  selectedSuggestionIndex: number;
  palette: Palette;
  composerWidth: number;
  home: boolean;
  height: number;
  promptFocused: boolean;
  editorFocused: boolean;
  draft: string;
  view: TuiViewState;
  onToggleMode(): void;
  openPermissions(): void;
  onModelSelect?: () => void;
  submit(command?: string): void;
  editor: React.RefObject<TextareaRenderable | null>;
  editorHeight: number;
  conversationId?: string;
  onEditorFocus(): void;
  onDraftChange(): void;
  defaultModel?: string;
  canCancel: boolean;
}) {
  const composer = (
    <UiSurface name="Composer" preserveNative>
      <UiSurface name="AbovePrompt" />
      <UiPaneRegion
        key={`above:${conversationId}`}
        placement="above_prompt"
        width={width}
        narrow={!dockExtensionPane}
      />
      <box width="100%" flexShrink={0} flexDirection="column">
        {visibleSuggestions.map((command, index) => (
          <text
            key={command.name}
            height={1}
            fg={
              index + suggestionStart === selectedSuggestionIndex
                ? palette.accent
                : palette.muted
            }
          >
            {terminalLine(
              `${index + suggestionStart === selectedSuggestionIndex ? ">" : " "} ${command.name} | ${command.description}${command.source.type === "extension" ? ` [${command.source.extensionId}]` : ""}`,
              Math.max(8, composerWidth - 3),
            )}
          </text>
        ))}
        <OpenTuiPrompt
          compact={!home && height < 10}
          palette={palette}
          width={composerWidth}
          focused={promptFocused}
          hasDraft={!!draft.trim()}
          busy={view.busy}
          model={
            view.modelSelection?.model ?? view.usage?.model ?? defaultModel
          }
          agentMode={view.agentMode}
          runningMode={view.runningMode}
          approvalMode={view.approvalMode}
          runningApprovalMode={view.runningApprovalMode}
          onToggleMode={onToggleMode}
          onPermissionsSelect={openPermissions}
          onModelSelect={onModelSelect}
          onSubmit={() => submit()}
        >
          <textarea
            id="prompt-editor"
            ref={editor}
            onMouseDown={onEditorFocus}
            height={editorHeight}
            focused={editorFocused}
            initialValue={draft}
            backgroundColor={palette.surface}
            focusedBackgroundColor={palette.surface}
            textColor={palette.text}
            focusedTextColor={palette.text}
            placeholderColor={palette.muted}
            placeholder="Опишите задачу..."
            cursorColor={palette.accent}
            selectionBg={palette.raised}
            selectionFg={palette.text}
            onContentChange={onDraftChange}
            onSubmit={() => submit()}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "return", shift: true, action: "newline" },
            ]}
          />
        </OpenTuiPrompt>
        <UiSurface name="StatusLine">
          <box height={1} flexDirection="row" flexShrink={0}>
            <UiSurface name="PromptHints">
              <text fg={palette.muted} height={1} width={composerWidth}>
                {terminalLine(
                  !home && height < 10
                    ? `${view.agentMode === "plan" ? "Plan" : "Build"} | F4 | Enter`
                    : view.busy && canCancel
                      ? "Enter в очередь | Ctrl+C остановить | Ctrl+Tab вкладки"
                      : composerWidth >= 77
                        ? "Enter отправить | Shift+Enter строка | Shift+Tab режим | F4 разрешения"
                        : composerWidth >= 45
                          ? "Enter отправить | Shift+Tab режим | F4 разрешения"
                          : composerWidth >= 30
                            ? "Shift+Tab режим · F4"
                            : "Enter · F4 доступ",
                  composerWidth,
                )}
              </text>
            </UiSurface>
          </box>
        </UiSurface>
      </box>
      <UiSurface name="BelowPrompt" />
      <UiPaneRegion
        key={`below:${conversationId}`}
        placement="below_prompt"
        width={width}
      />
    </UiSurface>
  );
  return composer;
}
