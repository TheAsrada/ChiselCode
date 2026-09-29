/** @jsxImportSource @opentui/react */
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import React, { useEffect, useState } from "react";
import type { ApprovalRequest } from "../security/approval.js";
import { invocableSkills } from "../skills/skills.js";
import {
  type CommandSuggestion,
  isSlashInput,
  MAX_VISIBLE_SUGGESTIONS,
  matchingCommands,
} from "./commands.js";
import { ContextSidebar } from "./context-sidebar.js";
import {
  addEditorHistory,
  createEditorState,
  navigateEditorHistory,
} from "./editor.js";
import { OpenTuiApproval } from "./opentui-approval.js";
import {
  OpenTuiSessions,
  type OpenTuiSessionsActions,
} from "./opentui-sessions.js";
import {
  OpenTuiSettings,
  type OpenTuiSettingsActions,
} from "./opentui-settings.js";
import { OpenTuiSkills, type OpenTuiSkillsActions } from "./opentui-skills.js";
import {
  OpenTuiTranscript,
  TRANSCRIPT_WINDOW,
  terminalSafeText,
} from "./opentui-transcript.js";
import {
  parseSidebarMode,
  type SidebarMode,
  sidebarLayout,
  toggleSidebarMode,
} from "./sidebar-layout.js";
import type { TuiApprovalResolver } from "./tui.js";
import type { TuiController, TuiViewState } from "./tui-controller.js";

const PATCH = `diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -1 +1 @@
-const greeting = "Hello";
+const greeting = "Привет";
`;

/** Isolated compatibility probe, never selected by the regular CLI. */
export function OpenTuiSpike({
  onExit,
  controller,
  classic = false,
  initialMode = "auto",
  onModeChange,
  approvalResolver,
  onSubmit,
  sessionPicker,
  settingsActions,
  initialSettingsOpen = false,
  onSetupComplete,
  skillsActions,
}: {
  onExit: () => void;
  controller?: TuiController;
  classic?: boolean;
  initialMode?: SidebarMode;
  onModeChange?: (mode: SidebarMode) => void;
  approvalResolver?: TuiApprovalResolver;
  onSubmit?: (prompt: string) => Promise<void>;
  sessionPicker?: OpenTuiSessionsActions;
  settingsActions?: OpenTuiSettingsActions;
  initialSettingsOpen?: boolean;
  onSetupComplete?: () => void;
  skillsActions?: OpenTuiSkillsActions;
}) {
  const { width, height } = useTerminalDimensions();
  const editor = React.useRef<TextareaRenderable>(null);
  const history = React.useRef(createEditorState());
  const applyingHistory = React.useRef(false);
  const acceptedCompletion = React.useRef<string | undefined>(undefined);
  const transcript = React.useRef<ScrollBoxRenderable>(null);
  const nextId = React.useRef(1);
  const [draft, setDraft] = useState("");
  const [lines, setLines] = useState([
    { id: 0, text: "ChiselCode · OpenTUI compatibility probe" },
  ]);
  const [mode, setMode] = useState<SidebarMode>(initialMode);
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillCommands, setSkillCommands] = useState<CommandSuggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [setupPending, setSetupPending] = useState(initialSettingsOpen);
  const [settingsSelection, setSettingsSelection] = useState(0);
  useEffect(() => {
    approvalResolver?.bind(setApproval);
    return () => approvalResolver?.bind(undefined);
  }, [approvalResolver]);
  const [view, setView] = useState<TuiViewState>(
    () =>
      controller?.snapshot ?? {
        projectPath: process.cwd(),
        transcript: [],
        streaming: "",
        draft: "",
        focus: "composer",
      },
  );
  useEffect(() => controller?.subscribe(setView), [controller]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: project and panel changes reload available skill commands.
  useEffect(() => {
    setSkillCommands(
      skillsActions
        ? invocableSkills(skillsActions.load()).map(
            ({ name, description }) => ({
              name,
              description,
            }),
          )
        : [],
    );
  }, [skillsActions, view.projectPath, skillsOpen]);
  const [expanded, setExpanded] = useState(false);
  const [windowEnd, setWindowEnd] = useState<number>();
  const [focus, setFocus] = useState<"editor" | "transcript">("editor");
  const layout = sidebarLayout(width, mode, overlayDismissed);
  const showSidebar = layout.placement !== "hidden";
  const contextOnly =
    layout.placement === "overlay" || layout.placement === "fullscreen";
  const textWidth = layout.feedWidth;
  const editorHeight = Math.min(4, Math.max(2, height - 3));
  const suggestions =
    height >= 12 &&
    isSlashInput(draft) &&
    !draft.includes("\n") &&
    !draft.trim().includes(" ") &&
    !suggestionsDismissed
      ? matchingCommands(draft, skillCommands)
      : [];
  const suggestionLimit = Math.min(
    MAX_VISIBLE_SUGGESTIONS,
    Math.max(0, height - editorHeight - 5),
  );
  const selectedSuggestionIndex = suggestions.length
    ? suggestionIndex % suggestions.length
    : 0;
  const suggestionStart = suggestionLimit
    ? Math.floor(selectedSuggestionIndex / suggestionLimit) * suggestionLimit
    : 0;
  const visibleSuggestions = suggestions.slice(
    suggestionStart,
    suggestionStart + suggestionLimit,
  );
  const selectedSuggestion = suggestions[selectedSuggestionIndex];
  const feedHeight = Math.max(
    1,
    height - editorHeight - 2 - visibleSuggestions.length,
  );
  let newestDiffId: number | undefined;
  for (let index = view.transcript.length - 1; index >= 0; index--) {
    const entry = view.transcript[index];
    if (entry?.fileDiff) {
      newestDiffId = entry.id;
      break;
    }
  }

  const shiftWindow = (direction: "up" | "down") => {
    const total = view.transcript.length;
    const current = windowEnd ?? total;
    if (direction === "up" && current > TRANSCRIPT_WINDOW)
      setWindowEnd(
        Math.max(TRANSCRIPT_WINDOW, current - TRANSCRIPT_WINDOW / 2),
      );
    if (direction === "down" && current < total) {
      const next = Math.min(total, current + TRANSCRIPT_WINDOW / 2);
      setWindowEnd(next === total ? undefined : next);
    }
  };

  const changeMode = (next: SidebarMode) => {
    setMode(next);
    setOverlayDismissed(false);
    onModeChange?.(next);
  };

  const browseHistory = (direction: -1 | 1) => {
    const input = editor.current;
    if (!input) return;
    const next = navigateEditorHistory(history.current, direction);
    if (next === history.current) return;
    history.current = next;
    applyingHistory.current = true;
    try {
      input.setText(next.value);
      input.cursorOffset = next.cursor;
    } finally {
      applyingHistory.current = false;
    }
    setDraft(next.value);
    controller?.setDraft(next.value);
  };

  const acceptSuggestion = (): boolean => {
    if (!selectedSuggestion) return false;
    const input = editor.current;
    if (!input) return false;
    const name = selectedSuggestion.name;
    const needsArgs =
      name === "/cwd" ||
      name === "/resume" ||
      skillCommands.some((skill) => `/${skill.name}` === name);
    const filled = needsArgs ? `${name} ` : name;
    acceptedCompletion.current = filled;
    input.setText(filled);
    input.cursorOffset = filled.length;
    setDraft(filled);
    controller?.setDraft(filled);
    setSuggestionsDismissed(true);
    return true;
  };

  useEffect(() => {
    if (
      !approval &&
      !pickerOpen &&
      !settingsOpen &&
      !skillsOpen &&
      !contextOnly
    ) {
      if (focus === "editor") editor.current?.focus();
      else transcript.current?.focus();
    }
  }, [approval, pickerOpen, settingsOpen, skillsOpen, contextOnly, focus]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return onExit();
    if (approval) {
      const answer = key.name.toLowerCase();
      if (answer === "y" || answer === "н")
        approvalResolver?.resolve("approved");
      if (answer === "n" || answer === "т" || answer === "escape")
        approvalResolver?.resolve("denied");
      return;
    }
    if (pickerOpen || settingsOpen || skillsOpen) return;
    if (suggestions.length > 0 && focus === "editor" && !contextOnly) {
      if (key.name === "escape") {
        key.preventDefault();
        setSuggestionsDismissed(true);
        return;
      }
      if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        setSuggestionIndex(
          (current) =>
            (current + (key.name === "up" ? -1 : 1) + suggestions.length) %
            suggestions.length,
        );
        return;
      }
      if (key.name === "tab") {
        key.preventDefault();
        acceptSuggestion();
        return;
      }
    }
    if (key.name === "escape") {
      if (contextOnly) setOverlayDismissed(true);
      else if (expanded) setExpanded(false);
      else onExit();
    }
    if (key.ctrl && key.name === "b")
      changeMode(toggleSidebarMode(mode, width));
    if (key.name === "tab" && !contextOnly) {
      setFocus((value) => (value === "editor" ? "transcript" : "editor"));
      if (focus === "editor") transcript.current?.focus();
    }
    if (key.ctrl && key.name === "d") {
      key.preventDefault();
      if (onSubmit && focus === "editor" && !draft) onExit();
      else setExpanded((value) => !value);
      return;
    }
    if (focus === "editor" && !contextOnly && key.ctrl && key.name === "p") {
      key.preventDefault();
      browseHistory(-1);
      return;
    }
    if (focus === "editor" && !contextOnly && key.ctrl && key.name === "n") {
      key.preventDefault();
      browseHistory(1);
      return;
    }
    if (
      focus === "editor" &&
      !contextOnly &&
      key.name === "up" &&
      editor.current?.logicalCursor.row === 0
    ) {
      key.preventDefault();
      browseHistory(-1);
      return;
    }
    if (
      focus === "editor" &&
      !contextOnly &&
      key.name === "down" &&
      editor.current?.logicalCursor.row ===
        (editor.current?.plainText.split("\n").length ?? 1) - 1
    ) {
      key.preventDefault();
      browseHistory(1);
      return;
    }
    if (key.name === "pageup") shiftWindow("up");
    if (key.name === "pagedown") shiftWindow("down");
    if (key.name === "end") {
      setWindowEnd(undefined);
      transcript.current?.scrollTo(Number.MAX_SAFE_INTEGER);
    }
  });

  const submit = () => {
    if (approval) return;
    const value = editor.current?.plainText.trim();
    if (!value) return;
    if (selectedSuggestion && value !== selectedSuggestion.name) {
      acceptSuggestion();
      return;
    }
    history.current = addEditorHistory(history.current, value);
    if (value === "/sidebar" || value.startsWith("/sidebar ")) {
      const arg = value.slice("/sidebar".length).trim();
      const next = arg ? parseSidebarMode(arg) : toggleSidebarMode(mode, width);
      if (next) changeMode(next);
      editor.current?.setText("");
      setDraft("");
      return;
    }
    if (sessionPicker && (value === "/sessions" || value === "/resume")) {
      setPickerOpen(true);
      controller?.setOverlay("sessions");
      controller?.setFocus("modal");
      editor.current?.setText("");
      setDraft("");
      return;
    }
    if (settingsActions && (value === "/settings" || value === "/model")) {
      setSettingsSelection(value === "/model" ? 1 : 0);
      setSettingsOpen(true);
      controller?.setOverlay("settings");
      controller?.setFocus("modal");
      editor.current?.setText("");
      setDraft("");
      return;
    }
    if (skillsActions && value === "/skills") {
      setSkillsOpen(true);
      controller?.setOverlay("skills");
      controller?.setFocus("modal");
      editor.current?.setText("");
      setDraft("");
      return;
    }
    if (onSubmit)
      void onSubmit(value).catch((error) =>
        controller?.append(String(error), "error"),
      );
    else {
      controller?.append(`❯ ${value}`, "user");
      setLines((current) => [
        ...current,
        { id: nextId.current++, text: `❯ ${value}` },
      ]);
    }
    editor.current?.setText("");
    setDraft("");
  };

  if (approval)
    return <OpenTuiApproval request={approval} width={width} height={height} />;
  if (pickerOpen && sessionPicker)
    return (
      <OpenTuiSessions
        actions={sessionPicker}
        width={width}
        height={height}
        onClose={() => {
          setPickerOpen(false);
          controller?.setOverlay();
          controller?.setFocus(focus === "editor" ? "composer" : "transcript");
        }}
      />
    );
  if (settingsOpen && settingsActions)
    return (
      <OpenTuiSettings
        actions={settingsActions}
        width={width}
        height={height}
        initialSelection={settingsSelection}
        onClose={(outcome) => {
          if (setupPending && outcome !== "saved") return onExit();
          if (setupPending && outcome === "saved") onSetupComplete?.();
          setSetupPending(false);
          setSettingsOpen(false);
          controller?.setOverlay();
          controller?.setFocus(focus === "editor" ? "composer" : "transcript");
        }}
      />
    );
  if (skillsOpen && skillsActions)
    return (
      <OpenTuiSkills
        actions={skillsActions}
        width={width}
        height={height}
        onClose={() => {
          setSkillsOpen(false);
          controller?.setOverlay();
          controller?.setFocus(focus === "editor" ? "composer" : "transcript");
        }}
      />
    );

  return (
    <box
      width={width}
      height={height}
      flexDirection="row"
      backgroundColor="#111827"
    >
      {!contextOnly && (
        <box
          width={textWidth}
          height={height}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg="#78c8d4">
            {onSubmit
              ? `ChiselCode · ${terminalSafeText(view.sessionTitle ?? "новый сеанс", Math.max(12, textWidth - 16))}`
              : `ChiselCode · probe · ${width}×${height}`}
          </text>
          {height >= 12 && (
            <scrollbox
              ref={transcript}
              height={feedHeight}
              stickyScroll
              stickyStart="bottom"
              viewportCulling
              onMouseScroll={(event) => {
                const box = transcript.current;
                if (!box) return;
                if (event.scroll?.direction === "up" && box.scrollTop <= 0)
                  shiftWindow("up");
                if (
                  event.scroll?.direction === "down" &&
                  box.scrollTop >= box.scrollHeight - box.viewport.height
                )
                  shiftWindow("down");
              }}
            >
              {controller ? (
                <OpenTuiTranscript
                  entries={
                    classic
                      ? expanded
                        ? view.transcript.filter(
                            (entry) => entry.id === newestDiffId,
                          )
                        : []
                      : view.transcript
                  }
                  contentWidth={textWidth - 2}
                  expandedId={expanded ? newestDiffId : undefined}
                  windowEnd={classic ? undefined : windowEnd}
                />
              ) : (
                <React.Fragment>
                  {lines.map((line) => (
                    <text key={line.id} fg="#d6dce5">
                      {line.text}
                    </text>
                  ))}
                  <text fg="#8090a0">example.ts · +1 −1 · Ctrl+D: diff</text>
                  {expanded && (
                    <diff
                      diff={PATCH}
                      view={textWidth - 2 >= 100 ? "split" : "unified"}
                      height={5}
                    />
                  )}
                </React.Fragment>
              )}
              {controller && view.streaming && (
                <text fg="#d6dce5" selectable>
                  {terminalSafeText(view.streaming, 20_000)}
                </text>
              )}
              {controller && view.toolActivity && (
                <text fg="#98a6b6">
                  {terminalSafeText(view.toolActivity, 2_000)}
                </text>
              )}
            </scrollbox>
          )}
          {visibleSuggestions.map((command, index) => (
            <text
              key={command.name}
              fg={
                index + suggestionStart === selectedSuggestionIndex
                  ? "#78c8d4"
                  : "#98a6b6"
              }
            >
              {terminalSafeText(
                `${index + suggestionStart === selectedSuggestionIndex ? "❯" : " "} ${command.name} · ${command.description}`,
                Math.max(8, textWidth - 3),
              )}
            </text>
          ))}
          <text fg="#f1c56d">
            {draft ? "Черновик" : "Готово"} · Enter: отправить · Shift+Enter:
            строка · Esc: выход
          </text>
          <textarea
            ref={editor}
            height={editorHeight}
            placeholder="Напишите сообщение…"
            onContentChange={() => {
              const next = editor.current?.plainText ?? "";
              if (
                applyingHistory.current ||
                (history.current.historyIndex >= 0 &&
                  next === history.current.value)
              )
                return;
              if (next !== acceptedCompletion.current) {
                setSuggestionIndex(0);
                setSuggestionsDismissed(false);
              }
              acceptedCompletion.current = undefined;
              history.current = {
                ...history.current,
                value: next,
                cursor: editor.current?.cursorOffset ?? next.length,
                historyIndex: -1,
                historyDraft: "",
              };
              setDraft(next);
              controller?.setDraft(next);
            }}
            onSubmit={submit}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "return", shift: true, action: "newline" },
            ]}
          />
        </box>
      )}
      {showSidebar && (
        <box
          width={contextOnly ? width : 41}
          height={height}
          flexDirection="row"
        >
          {!contextOnly && <box width={1} backgroundColor="#465264" />}
          <ContextSidebar
            state={view}
            width={contextOnly ? Math.min(width, 40) : 40}
            height={height}
          />
        </box>
      )}
    </box>
  );
}
