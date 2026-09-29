/** @jsxImportSource @opentui/react */
import type {
  BoxRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import React, { useEffect, useState } from "react";
import type { ApprovalRequest } from "../security/approval.js";
import { invocableSkills } from "../skills/skills.js";
import {
  THEME_NAMES,
  THEMES,
  type ThemeName,
  themePalette,
} from "./appearance.js";
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
import { COMPACT_LOGO } from "./logo.js";
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
  markdownStyleFor,
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
import type { TuiApprovalResolver } from "./tui-contract.js";
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
  initialTheme = "obsidian",
  accent,
  onThemeChange,
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
  initialTheme?: ThemeName;
  accent?: string;
  onThemeChange?: (theme: ThemeName) => void;
}) {
  const { width, height } = useTerminalDimensions();
  const editor = React.useRef<TextareaRenderable>(null);
  const history = React.useRef(createEditorState());
  const applyingHistory = React.useRef(false);
  const acceptedCompletion = React.useRef<string | undefined>(undefined);
  const transcript = React.useRef<ScrollBoxRenderable>(null);
  const sidebar = React.useRef<BoxRenderable>(null);
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
  const [theme, setTheme] = useState<ThemeName>(initialTheme);
  const [themeOpen, setThemeOpen] = useState(false);
  const [themeSelection, setThemeSelection] = useState(
    THEME_NAMES.indexOf(initialTheme),
  );
  const themeSelectionRef = React.useRef(THEME_NAMES.indexOf(initialTheme));
  const selectThemeIndex = (index: number) => {
    themeSelectionRef.current = index;
    setThemeSelection(index);
  };
  const palette = themePalette(theme, accent);
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
  const previousLocation = React.useRef({
    sessionId: view.sessionId,
    projectPath: view.projectPath,
  });
  useEffect(() => {
    const prior = previousLocation.current;
    if (
      prior.projectPath !== view.projectPath ||
      (prior.sessionId !== undefined && prior.sessionId !== view.sessionId)
    ) {
      setWindowEnd(undefined);
      setExpanded(false);
    }
    previousLocation.current = {
      sessionId: view.sessionId,
      projectPath: view.projectPath,
    };
  }, [view.sessionId, view.projectPath]);
  const [focus, setFocus] = useState<"editor" | "transcript" | "sidebar">(
    "editor",
  );
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
  const showLogo = height >= 22 && textWidth >= 46;
  const feedHeight = Math.max(
    1,
    height - editorHeight - (showLogo ? 6 : 4) - visibleSuggestions.length,
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
      !themeOpen &&
      !contextOnly
    ) {
      if (focus === "editor") editor.current?.focus();
      else if (focus === "transcript") transcript.current?.focus();
      else sidebar.current?.focus();
    }
  }, [
    approval,
    pickerOpen,
    settingsOpen,
    skillsOpen,
    themeOpen,
    contextOnly,
    focus,
  ]);
  useEffect(() => {
    if (focus === "sidebar" && !showSidebar) {
      setFocus("editor");
      controller?.setFocus("composer");
    }
  }, [focus, showSidebar, controller]);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return onExit();
    if (themeOpen) {
      key.preventDefault();
      if (key.name === "escape" || (key.ctrl && key.name === "t"))
        setThemeOpen(false);
      else if (key.name === "up" || key.name === "down")
        selectThemeIndex(
          (themeSelectionRef.current +
            (key.name === "up" ? -1 : 1) +
            THEME_NAMES.length) %
            THEME_NAMES.length,
        );
      else if (key.name === "return" || key.name === "enter") {
        const selected = THEME_NAMES[themeSelectionRef.current] ?? "obsidian";
        setTheme(selected);
        onThemeChange?.(selected);
        setThemeOpen(false);
      }
      return;
    }
    if (approval) {
      const answer = key.name.toLowerCase();
      if (answer === "y" || answer === "н")
        approvalResolver?.resolve("approved");
      if (answer === "n" || answer === "т" || answer === "escape")
        approvalResolver?.resolve("denied");
      return;
    }
    if (pickerOpen || settingsOpen || skillsOpen) return;
    if (key.ctrl && key.name === "t") {
      key.preventDefault();
      selectThemeIndex(THEME_NAMES.indexOf(theme));
      setThemeOpen(true);
      return;
    }
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
      else if (focus !== "editor") {
        setFocus("editor");
        controller?.setFocus("composer");
      } else onExit();
      return;
    }
    if (key.ctrl && key.name === "b")
      changeMode(toggleSidebarMode(mode, width));
    if (key.name === "tab" && !contextOnly) {
      key.preventDefault();
      const next =
        focus === "editor"
          ? "transcript"
          : focus === "transcript" && showSidebar
            ? "sidebar"
            : "editor";
      setFocus(next);
      controller?.setFocus(next === "editor" ? "composer" : next);
      return;
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
    if (value === "/theme") {
      selectThemeIndex(THEME_NAMES.indexOf(theme));
      setThemeOpen(true);
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
    return (
      <OpenTuiApproval
        request={approval}
        width={width}
        height={height}
        palette={palette}
      />
    );
  if (themeOpen)
    return (
      <box
        width={width}
        height={height}
        backgroundColor={palette.bg}
        flexDirection="column"
        padding={2}
      >
        <text fg={palette.accent}>◈ ОФОРМЛЕНИЕ CHISELCODE</text>
        <text fg={palette.muted}>↑↓ выбрать · Enter применить · Esc назад</text>
        <box height={1} />
        {THEME_NAMES.map((name, index) => {
          const colors = THEMES[name];
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: Terminal palette has full keyboard control above.
            <box
              key={name}
              backgroundColor={
                index === themeSelection ? palette.raised : palette.bg
              }
              paddingLeft={1}
              onMouseUp={() => {
                setTheme(name);
                onThemeChange?.(name);
                setThemeOpen(false);
              }}
            >
              <text
                fg={index === themeSelection ? palette.accent : palette.text}
              >
                {index === themeSelection ? "❯" : " "} {colors.label.padEnd(12)}{" "}
                {colors.description}
                {theme === name ? "  ✓" : ""}
              </text>
            </box>
          );
        })}
        <box height={1} />
        <text fg={palette.muted}>
          Свой акцент: поле ui.accent в конфиге (#RRGGBB)
        </text>
      </box>
    );
  if (pickerOpen && sessionPicker)
    return (
      <OpenTuiSessions
        actions={sessionPicker}
        width={width}
        height={height}
        palette={palette}
        onClose={() => {
          setPickerOpen(false);
          controller?.setOverlay();
          controller?.setFocus(focus === "editor" ? "composer" : focus);
        }}
      />
    );
  if (settingsOpen && settingsActions)
    return (
      <OpenTuiSettings
        actions={settingsActions}
        width={width}
        height={height}
        palette={palette}
        initialSelection={settingsSelection}
        onClose={(outcome) => {
          if (setupPending && outcome !== "saved") return onExit();
          if (setupPending && outcome === "saved") onSetupComplete?.();
          setSetupPending(false);
          setSettingsOpen(false);
          controller?.setOverlay();
          controller?.setFocus(focus === "editor" ? "composer" : focus);
        }}
      />
    );
  if (skillsOpen && skillsActions)
    return (
      <OpenTuiSkills
        actions={skillsActions}
        width={width}
        height={height}
        palette={palette}
        onClose={() => {
          setSkillsOpen(false);
          controller?.setOverlay();
          controller?.setFocus(focus === "editor" ? "composer" : focus);
        }}
      />
    );

  return (
    <box
      width={width}
      height={height}
      flexDirection="row"
      backgroundColor={palette.bg}
    >
      {!contextOnly && (
        <box
          width={textWidth}
          height={height}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
        >
          {showLogo &&
            COMPACT_LOGO.map((row) => (
              <text key={row} fg={palette.accent}>
                {row}
              </text>
            ))}
          <text fg={palette.accent}>
            {onSubmit
              ? `◈ ${showLogo ? "" : "ChiselCode  ·  "}${terminalSafeText(view.sessionTitle ?? "новый сеанс", Math.max(12, textWidth - 32))}  ·  ${theme}`
              : `◈ ChiselCode · probe · ${width}×${height} · ${theme}`}
          </text>
          <box width="100%" flexDirection="row" justifyContent="space-between">
            <text fg={palette.muted}>
              {terminalSafeText(view.projectPath, Math.max(8, textWidth - 23))}
            </text>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+T and /theme provide keyboard access. */}
            <box
              backgroundColor={palette.raised}
              paddingLeft={1}
              paddingRight={1}
              onMouseUp={() => {
                selectThemeIndex(THEME_NAMES.indexOf(theme));
                setThemeOpen(true);
              }}
            >
              <text fg={palette.accent}>◐ Тема Ctrl+T</text>
            </box>
          </box>
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
                  palette={palette}
                />
              ) : (
                <React.Fragment>
                  {lines.map((line) => (
                    <text key={line.id} fg={palette.text}>
                      {line.text}
                    </text>
                  ))}
                  <text fg={palette.muted}>
                    example.ts · +1 −1 · Ctrl+D: diff
                  </text>
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
                <box
                  width="100%"
                  flexDirection="row"
                  marginTop={1}
                  shouldFill={false}
                >
                  <box width={1} backgroundColor={palette.accent} />
                  <box
                    flexGrow={1}
                    minWidth={0}
                    flexDirection="column"
                    paddingLeft={2}
                    paddingRight={1}
                    shouldFill={false}
                  >
                    <markdown
                      content={terminalSafeText(view.streaming, 20_000)}
                      syntaxStyle={markdownStyleFor(palette)}
                      fg={palette.text}
                      conceal
                      streaming
                      width="100%"
                    />
                  </box>
                </box>
              )}
              {controller && view.toolActivity && (
                <text fg={palette.muted}>
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
                  ? palette.accent
                  : palette.muted
              }
            >
              {terminalSafeText(
                `${index + suggestionStart === selectedSuggestionIndex ? "❯" : " "} ${command.name} · ${command.description}`,
                Math.max(8, textWidth - 3),
              )}
            </text>
          ))}
          <text fg={palette.muted}>
            ╭─{" "}
            <span fg={palette.accent}>{draft ? "Черновик" : "Сообщение"}</span>{" "}
            ─ {view.usage?.model ?? "ChiselCode"}
          </text>
          <textarea
            ref={editor}
            height={editorHeight}
            initialValue={draft}
            backgroundColor={palette.surface}
            focusedBackgroundColor={palette.surface}
            textColor={palette.text}
            focusedTextColor={palette.text}
            placeholderColor={palette.muted}
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
          <text fg={palette.muted}>
            ╰─ <span fg={palette.accent}>↵ Enter</span> отправить · Shift+Enter
            строка · Ctrl+T тема · Esc выход
          </text>
        </box>
      )}
      {showSidebar && (
        <box
          ref={sidebar}
          width={contextOnly ? width : 41}
          height={height}
          flexDirection="row"
          focusable
        >
          {!contextOnly && <box width={1} backgroundColor={palette.border} />}
          <ContextSidebar
            state={view}
            width={contextOnly ? Math.min(width, 40) : 40}
            height={height}
            focused={focus === "sidebar"}
            palette={palette}
          />
        </box>
      )}
    </box>
  );
}
