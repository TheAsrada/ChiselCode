/** @jsxImportSource @opentui/react */

import type { TextareaRenderable } from "@opentui/core";
import type React from "react";
import type { CommandDescriptor } from "../commands/slash.js";
import type { Palette } from "./appearance.js";
import { UiPaneRegion, UiSurface } from "./opentui-composition.js";
import { AddPhotoButton } from "./opentui-photos.js";
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
  reveal,
  height,
  promptFocused,
  editorFocused,
  draft,
  photoControls,
  onAddPhoto,
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
  reveal?: boolean;
  height: number;
  promptFocused: boolean;
  editorFocused: boolean;
  draft: string;
  photoControls?: React.ReactNode;
  onAddPhoto?: () => void;
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
  const photoAction = composerWidth >= 22 ? onAddPhoto : undefined;
  const compactPhotoAction = composerWidth < 48;
  const hintWidth =
    composerWidth - (photoAction ? (compactPhotoAction ? 5 : 11) : 0);
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
        {photoControls}
        {view.extensionActivity && (
          <text
            id="extension-activity"
            fg={palette.muted}
            height={1}
            flexShrink={0}
          >
            {terminalLine(view.extensionActivity, composerWidth)}
          </text>
        )}
        <OpenTuiPrompt
          compact={!home && height < 10}
          reveal={reveal}
          palette={palette}
          width={composerWidth}
          focused={promptFocused}
          hasDraft={!!draft.trim() || !!view.draftImages?.length}
          busy={view.busy && view.requestStartedAt !== undefined}
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
          <box height={1} flexDirection="row" flexShrink={0} gap={1}>
            <UiSurface name="PromptHints">
              <text fg={palette.muted} height={1} width={hintWidth}>
                {terminalLine(
                  !home && height < 10
                    ? `${view.agentMode === "plan" ? "Plan" : "Build"} | F4 | Enter`
                    : view.busy && canCancel
                      ? "Enter в очередь | Ctrl+C остановить | Ctrl+Tab вкладки"
                      : hintWidth >= 77
                        ? "Enter отправить | Shift+Enter строка | Shift+Tab режим | F4 разрешения"
                        : hintWidth >= 45
                          ? "Enter отправить | Shift+Tab режим | F4 разрешения"
                          : hintWidth >= 30
                            ? "Shift+Tab режим · F4"
                            : "Enter · F4 доступ",
                  hintWidth,
                )}
              </text>
            </UiSurface>
            {photoAction && (
              <AddPhotoButton
                compact={compactPhotoAction}
                palette={palette}
                onPress={photoAction}
              />
            )}
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
