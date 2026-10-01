/** @jsxImportSource @opentui/react */
import type {
  BoxRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import React, { useEffect, useLayoutEffect, useState } from "react";
import {
  AGENT_MODE_LABELS,
  AGENT_MODES,
  type AgentMode,
  DEFAULT_AGENT_MODE,
  nextAgentMode,
} from "../runtime/agent-mode.js";
import type { ApprovalRequest } from "../security/approval.js";
import {
  APPROVAL_MODE_INPUTS,
  type ApprovalMode,
  type ApprovalModeInput,
  DEFAULT_APPROVAL_MODE,
  nextApprovalMode,
  resolveApprovalMode,
} from "../security/approval-mode.js";
import { invocableSkills } from "../skills/skills.js";
import { type ThemeName, themePalette } from "./appearance.js";
import {
  type CommandSuggestion,
  isSlashInput,
  MAX_VISIBLE_SUGGESTIONS,
  matchingCommands,
  parseSlashCommand,
} from "./commands.js";
import { ContextSidebar } from "./context-sidebar.js";
import {
  addEditorHistory,
  createEditorState,
  navigateEditorHistory,
} from "./editor.js";
import { COMPACT_LOGO, LOGO_WIDTH } from "./logo.js";
import { OpenTuiApproval } from "./opentui-approval.js";
import { OpenTuiModels, type OpenTuiModelsActions } from "./opentui-models.js";
import { OpenTuiHome, SessionTabs } from "./opentui-navigation.js";
import { OpenTuiPermissions } from "./opentui-permissions.js";
import { OpenTuiPrompt } from "./opentui-prompt.js";
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
  FormattedMessage,
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
import { skillCommandDraft, skillEditDraft } from "./skill-draft.js";
import {
  TerminalScrollbox,
  UnicodeDecorationContext,
} from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import type { TuiApprovalResolver } from "./tui-contract.js";
import type { TuiController, TuiViewState } from "./tui-controller.js";
import type { TuiWorkspace } from "./tui-workspace.js";

const PATCH = `diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -1 +1 @@
-const greeting = "Hello";
+const greeting = "Привет";
`;

/** The regular agent supplies a workspace; standalone probes keep their fixture. */
export function OpenTuiSpike(props: Parameters<typeof OpenTuiScreen>[0]) {
  const [, refresh] = useState(0);
  const [theme, setTheme] = useState(props.initialTheme ?? "obsidian");
  const [mode, setMode] = useState(props.initialMode ?? "auto");
  const [unicodeDecorations, setUnicodeDecorations] = useState(
    props.initialUnicodeDecorations ?? false,
  );
  const [setupOpen, setSetupOpen] = useState(props.initialSettingsOpen);
  const [bypassAllowed, setBypassAllowed] = useState(
    props.allowBypassPermissions ?? false,
  );
  useEffect(
    () => props.workspace?.subscribe(() => refresh((value) => value + 1)),
    [props.workspace],
  );
  const controller = props.workspace?.controller ?? props.controller;
  return (
    <UnicodeDecorationContext value={unicodeDecorations}>
      <OpenTuiScreen
        key={
          props.workspace
            ? (props.workspace.activeKey ??
              `home:${controller?.snapshot.projectPath}:${controller?.currentGeneration}`)
            : "probe"
        }
        {...props}
        controller={controller}
        initialTheme={theme}
        initialUnicodeDecorations={unicodeDecorations}
        onUnicodeDecorationsChange={async (next) => {
          await props.onUnicodeDecorationsChange?.(next);
          setUnicodeDecorations(next);
        }}
        initialMode={mode}
        initialSettingsOpen={setupOpen}
        allowBypassPermissions={bypassAllowed}
        onBypassAvailabilityChange={
          props.onBypassAvailabilityChange
            ? async (allowed) => {
                await props.onBypassAvailabilityChange?.(allowed);
                setBypassAllowed(allowed);
              }
            : undefined
        }
        onInitialSettingsComplete={() => setSetupOpen(false)}
        onThemeChange={async (next) => {
          await props.onThemeChange?.(next);
          setTheme(next);
        }}
        onModeChange={(next) => {
          setMode(next);
          props.onModeChange?.(next);
        }}
      />
    </UnicodeDecorationContext>
  );
}

function OpenTuiScreen({
  onExit,
  controller,
  workspace,
  classic = false,
  initialMode = "auto",
  onModeChange,
  approvalResolver,
  onSubmit,
  sessionPicker,
  settingsActions,
  getModelsActions,
  getDefaultModel,
  onAgentModeChange,
  onApprovalModeChange,
  allowBypassPermissions = false,
  onBypassAvailabilityChange,
  initialSettingsOpen = false,
  onSetupComplete,
  onInitialSettingsComplete,
  skillsActions,
  initialTheme = "obsidian",
  accent,
  onThemeChange,
  initialUnicodeDecorations = false,
  onUnicodeDecorationsChange,
}: {
  onExit: () => void;
  controller?: TuiController;
  workspace?: TuiWorkspace;
  classic?: boolean;
  initialMode?: SidebarMode;
  onModeChange?: (mode: SidebarMode) => void;
  approvalResolver?: TuiApprovalResolver;
  onSubmit?: (prompt: string) => Promise<void>;
  sessionPicker?: OpenTuiSessionsActions;
  settingsActions?: OpenTuiSettingsActions;
  getModelsActions?: () => OpenTuiModelsActions;
  getDefaultModel?: () => string;
  onAgentModeChange?: (mode: AgentMode) => void;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  allowBypassPermissions?: boolean;
  onBypassAvailabilityChange?: (allowed: boolean) => Promise<void>;
  initialSettingsOpen?: boolean;
  onSetupComplete?: () => void;
  onInitialSettingsComplete?: () => void;
  skillsActions?: OpenTuiSkillsActions;
  initialTheme?: ThemeName;
  accent?: string;
  onThemeChange?: (theme: ThemeName) => void | Promise<void>;
  initialUnicodeDecorations?: boolean;
  onUnicodeDecorationsChange?: (value: boolean) => Promise<void>;
}) {
  const { width, height } = useTerminalDimensions();
  const editor = React.useRef<TextareaRenderable>(null);
  const history = React.useRef(
    controller?.presentation.history ?? createEditorState(),
  );
  const applyingHistory = React.useRef(false);
  const acceptedCompletion = React.useRef<string | undefined>(undefined);
  const transcript = React.useRef<ScrollBoxRenderable>(null);
  const sidebar = React.useRef<BoxRenderable>(null);
  const nextId = React.useRef(1);
  const [draft, setDraft] = useState(controller?.snapshot.draft ?? "");
  const [lines, setLines] = useState([
    { id: 0, text: "ChiselCode | OpenTUI compatibility probe" },
  ]);
  const [mode, setMode] = useState<SidebarMode>(initialMode);
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const [theme, setTheme] = useState<ThemeName>(initialTheme);
  const palette = themePalette(theme, accent);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [modelsActions, setModelsActions] = useState<OpenTuiModelsActions>();
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [bypassAllowed, setBypassAllowed] = useState(allowBypassPermissions);
  const [skillCommands, setSkillCommands] = useState<CommandSuggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [setupPending, setSetupPending] = useState(initialSettingsOpen);
  const [settingsSelection, setSettingsSelection] = useState(0);
  const [settingsPage, setSettingsPage] = useState<
    "connection" | "appearance" | "permissions"
  >("connection");
  useEffect(() => {
    approvalResolver?.bind(setApproval);
    return () => approvalResolver?.bind(undefined);
  }, [approvalResolver]);
  const [view, setView] = useState<TuiViewState>(
    () =>
      controller?.snapshot ?? {
        projectPath: process.cwd(),
        agentMode: DEFAULT_AGENT_MODE,
        approvalMode: DEFAULT_APPROVAL_MODE,
        transcript: [],
        streaming: "",
        draft: "",
        focus: "composer",
      },
  );
  useEffect(() => controller?.subscribe(setView), [controller]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: project and panel changes reload available skill commands.
  useEffect(() => {
    try {
      setSkillCommands(
        skillsActions
          ? invocableSkills(skillsActions.load()).map(
              ({ name, description }) => ({ name, description }),
            )
          : [],
      );
    } catch {
      // The library popup presents discovery failures without breaking the composer.
      setSkillCommands([]);
    }
  }, [skillsActions, view.projectPath, skillsOpen]);
  const [expanded, setExpanded] = useState(
    controller?.presentation.expanded ?? false,
  );
  const [windowEnd, setWindowEnd] = useState<number | undefined>(
    controller?.presentation.windowEnd,
  );
  useLayoutEffect(() => {
    if (controller?.presentation.scrollTop !== undefined)
      transcript.current?.scrollTo(controller.presentation.scrollTop);
    return () => {
      if (controller) {
        controller.presentation.history = history.current;
        controller.presentation.scrollTop = transcript.current?.scrollTop;
      }
    };
  }, [controller]);
  useEffect(() => {
    if (controller) {
      controller.presentation.windowEnd = windowEnd;
      controller.presentation.expanded = expanded;
    }
  }, [controller, windowEnd, expanded]);
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
  const home = !!workspace && !workspace.activeKey;
  const tabRows = workspace?.tabs.length ? 3 : 0;
  useEffect(() => {
    if (home && view.transcript.length > 0)
      transcript.current?.scrollTo(Number.MAX_SAFE_INTEGER);
  }, [home, view.transcript.length]);
  const layout = sidebarLayout(
    width,
    home && mode === "auto" ? "hide" : mode,
    overlayDismissed,
  );
  const showSidebar = layout.placement !== "hidden";
  const contextOnly =
    layout.placement === "overlay" || layout.placement === "fullscreen";
  const textWidth = layout.feedWidth;
  const composerWidth = home
    ? Math.max(1, Math.min(86, textWidth - 4))
    : Math.max(1, textWidth - 2);
  const homeHeight = height - tabRows;
  const fullHomeLogo = home && textWidth >= LOGO_WIDTH + 4 && homeHeight >= 18;
  const homeCompact = homeHeight < 12;
  const homeFixedRows =
    (fullHomeLogo ? 5 : 1) +
    (homeCompact ? 1 : 2) +
    (homeHeight >= 10 ? 1 : 0) +
    5;
  const editorLimit = Math.max(
    1,
    Math.min(
      6,
      height -
        tabRows -
        (home ? homeFixedRows + (view.transcript.length ? 2 : 0) : 8),
    ),
  );
  const editorHeight = workspace
    ? Math.min(
        editorLimit,
        Math.max(
          2,
          draft
            .split("\n")
            .reduce(
              (rows, line) =>
                rows +
                Math.max(
                  1,
                  Math.ceil([...line].length / Math.max(1, composerWidth - 6)),
                ),
              0,
            ),
        ),
      )
    : Math.min(4, Math.max(2, height - 8));
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
    Math.max(0, height - tabRows - editorHeight - (home ? homeFixedRows : 7)),
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
  const showLogo = !workspace && height >= 22 && textWidth >= 46;
  const feedHeight = Math.max(
    1,
    height -
      editorHeight -
      tabRows -
      (workspace ? 6 : showLogo ? (initialUnicodeDecorations ? 10 : 9) : 8) -
      visibleSuggestions.length,
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

  const changeAgentMode = (next: AgentMode) => {
    if (controller) controller.setAgentMode(next);
    else setView((current) => ({ ...current, agentMode: next }));
    onAgentModeChange?.(next);
  };
  const toggleAgentMode = () =>
    changeAgentMode(
      nextAgentMode(controller?.snapshot.agentMode ?? view.agentMode),
    );
  const changeApprovalMode = (next: ApprovalMode) => {
    if (next === "bypassPermissions" && !bypassAllowed) return;
    if (controller) controller.setApprovalMode(next);
    else setView((current) => ({ ...current, approvalMode: next }));
    onApprovalModeChange?.(next);
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
      !modelsActions &&
      !permissionsOpen &&
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
    modelsActions,
    permissionsOpen,
    contextOnly,
    focus,
  ]);
  useEffect(() => {
    if (focus === "sidebar" && !showSidebar) {
      setFocus("editor");
      controller?.setFocus("composer");
    }
  }, [focus, showSidebar, controller]);

  const openSettings = (
    page: "connection" | "appearance" | "permissions",
    selection = 0,
  ) => {
    editor.current?.blur();
    setSettingsSelection(selection);
    setSettingsPage(page);
    setSettingsOpen(true);
    controller?.setOverlay("settings");
    controller?.setFocus("modal");
  };
  const closePermissions = () => {
    setPermissionsOpen(false);
    controller?.setOverlay();
    controller?.setFocus(focus === "editor" ? "composer" : focus);
  };
  const openPermissions = () => {
    if (approval || pickerOpen || settingsOpen || skillsOpen || modelsActions)
      return;
    editor.current?.blur();
    setPermissionsOpen(true);
    controller?.setOverlay("permissions");
    controller?.setFocus("modal");
  };
  const changeBypassAvailability = async (allowed: boolean) => {
    if (!onBypassAvailabilityChange)
      throw new Error("Сохранение разрешений недоступно.");
    await onBypassAvailabilityChange(allowed);
    setBypassAllowed(allowed);
    if (!allowed) {
      const targets = workspace
        ? [workspace.home, ...workspace.tabs.map((tab) => tab.controller)]
        : controller
          ? [controller]
          : [];
      for (const target of targets) {
        if (target.snapshot.approvalMode === "bypassPermissions")
          target.setApprovalMode(DEFAULT_APPROVAL_MODE);
      }
      if (!controller && view.approvalMode === "bypassPermissions")
        setView((current) => ({
          ...current,
          approvalMode: DEFAULT_APPROVAL_MODE,
        }));
    }
  };
  const openModels = () => {
    if (
      !getModelsActions ||
      approval ||
      pickerOpen ||
      settingsOpen ||
      skillsOpen ||
      modelsActions ||
      permissionsOpen
    )
      return;
    editor.current?.blur();
    setModelsActions(getModelsActions());
    controller?.setOverlay("models");
    controller?.setFocus("modal");
  };

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
    if (
      pickerOpen ||
      settingsOpen ||
      skillsOpen ||
      modelsActions ||
      permissionsOpen
    )
      return;
    if (
      key.name === "f4" &&
      !key.ctrl &&
      !key.shift &&
      !key.meta &&
      !key.option &&
      focus === "editor" &&
      !contextOnly
    ) {
      key.preventDefault();
      changeApprovalMode(
        nextApprovalMode(
          controller?.snapshot.approvalMode ?? view.approvalMode,
          bypassAllowed,
        ),
      );
      return;
    }
    if (
      key.name === "tab" &&
      key.shift &&
      !key.ctrl &&
      !key.meta &&
      !key.option &&
      focus === "editor" &&
      !contextOnly
    ) {
      key.preventDefault();
      toggleAgentMode();
      return;
    }
    if (skillsActions && key.ctrl && key.name === "s") {
      key.preventDefault();
      submit("/skills");
      return;
    }
    if (
      key.ctrl &&
      (key.name === "t" || key.name === "," || key.name === "comma")
    ) {
      key.preventDefault();
      openSettings(key.name === "t" ? "appearance" : "connection");
      return;
    }
    if (
      workspace &&
      (key.option || key.meta) &&
      (key.name === "left" || key.name === "right" || key.name === "n")
    ) {
      key.preventDefault();
      if (key.name === "n") workspace.newDraft();
      else workspace.cycle(key.name === "left" ? -1 : 1);
      return;
    }
    if (workspace && key.ctrl) {
      if (key.name === "tab") {
        key.preventDefault();
        workspace.cycle(key.shift ? -1 : 1);
        return;
      }
      if (key.name === "w") {
        key.preventDefault();
        workspace.close();
        return;
      }
      if (key.name === "g") {
        key.preventDefault();
        workspace.select();
        return;
      }
      if (key.name === "n" && key.shift) {
        key.preventDefault();
        workspace.newDraft();
        return;
      }
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
      } else if (workspace && !home) workspace.select();
      else onExit();
      return;
    }
    if (key.ctrl && key.name === "b")
      changeMode(toggleSidebarMode(mode, width));
    if (key.name === "tab" && !contextOnly) {
      key.preventDefault();
      const next =
        focus === "editor"
          ? home && view.transcript.length === 0
            ? showSidebar
              ? "sidebar"
              : "editor"
            : "transcript"
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

  const submit = (command?: string) => {
    if (
      approval ||
      skillsOpen ||
      settingsOpen ||
      pickerOpen ||
      modelsActions ||
      permissionsOpen
    )
      return;
    const value = command ?? editor.current?.plainText.trim();
    if (!value) return;
    if (!command && selectedSuggestion && value !== selectedSuggestion.name) {
      acceptSuggestion();
      return;
    }
    history.current = addEditorHistory(history.current, value);
    if (controller) controller.presentation.history = history.current;
    if (command === "/cwd") {
      editor.current?.setText("/cwd ");
      setDraft("/cwd ");
      controller?.setDraft("/cwd ");
      editor.current?.focus();
      return;
    }
    const clearInput = () => {
      if (command) return;
      controller?.setDraft("");
      editor.current?.setText("");
      setDraft("");
    };
    const parsed = parseSlashCommand(value);
    if (parsed && ["/permissions", "/auto", "/ask"].includes(parsed.name)) {
      const requested =
        parsed.name === "/permissions" ? parsed.args : parsed.name.slice(1);
      clearInput();
      if (!requested && parsed.name === "/permissions")
        return openPermissions();
      if (
        APPROVAL_MODE_INPUTS.includes(requested as ApprovalModeInput) &&
        (parsed.name === "/permissions" || !parsed.args)
      ) {
        try {
          changeApprovalMode(
            resolveApprovalMode({
              approvalMode: requested as ApprovalModeInput,
              allowBypassPermissions: bypassAllowed,
            }),
          );
        } catch (error) {
          controller?.append(
            error instanceof Error ? error.message : String(error),
            "info",
          );
        }
      } else {
        controller?.append(
          "/permissions открывает выбор. Режимы: default, acceptEdits, dontAsk, bypassPermissions. Bypass включается в Settings / Разрешения. F4 переключает следующий запрос.",
          "info",
        );
      }
      return;
    }
    if (parsed && ["/plan", "/build", "/mode"].includes(parsed.name)) {
      const requested =
        parsed.name === "/mode" ? parsed.args : parsed.name.slice(1);
      if (
        AGENT_MODES.includes(requested as AgentMode) &&
        (parsed.name === "/mode" || !parsed.args)
      )
        changeAgentMode(requested as AgentMode);
      else
        controller?.append(
          "Режим: /plan, /build или /mode plan|build. Shift+Tab переключает режим следующего запроса.",
          "info",
        );
      clearInput();
      return;
    }
    if (value === "/sidebar" || value.startsWith("/sidebar ")) {
      const arg = value.slice("/sidebar".length).trim();
      const next = arg ? parseSidebarMode(arg) : toggleSidebarMode(mode, width);
      if (next) changeMode(next);
      clearInput();
      return;
    }
    if (sessionPicker && (value === "/sessions" || value === "/resume")) {
      setPickerOpen(true);
      controller?.setOverlay("sessions");
      controller?.setFocus("modal");
      clearInput();
      return;
    }
    if (getModelsActions && value === "/model") {
      openModels();
      clearInput();
      return;
    }
    if (settingsActions && value === "/settings") {
      openSettings("connection");
      clearInput();
      return;
    }
    if (skillsActions && value === "/skills") {
      editor.current?.blur();
      setSkillsOpen(true);
      controller?.setOverlay("skills");
      controller?.setFocus("modal");
      clearInput();
      return;
    }
    if (onSubmit)
      void onSubmit(value).catch((error) =>
        controller?.append(String(error), "error"),
      );
    else {
      controller?.append(`> ${value}`, "user");
      setLines((current) => [
        ...current,
        { id: nextId.current++, text: `> ${value}` },
      ]);
    }
    clearInput();
  };

  if (pickerOpen && sessionPicker && !approval)
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
  const settingsDialog =
    settingsOpen && !approval ? (
      <OpenTuiSettings
        actions={settingsActions}
        width={width}
        height={height}
        palette={palette}
        initialSelection={settingsSelection}
        initialPage={settingsPage}
        theme={initialTheme}
        setup={setupPending}
        onThemePreview={setTheme}
        onThemeChange={onThemeChange}
        unicodeDecorations={initialUnicodeDecorations}
        onUnicodeDecorationsChange={onUnicodeDecorationsChange}
        allowBypassPermissions={bypassAllowed}
        onBypassAvailabilityChange={
          onBypassAvailabilityChange ? changeBypassAvailability : undefined
        }
        onClose={(outcome) => {
          if (setupPending && outcome !== "saved") return onExit();
          if (setupPending && outcome === "saved") onSetupComplete?.();
          onInitialSettingsComplete?.();
          setSetupPending(false);
          setSettingsOpen(false);
          controller?.setOverlay();
          controller?.setFocus(focus === "editor" ? "composer" : focus);
        }}
      />
    ) : undefined;
  if (setupPending && settingsOpen)
    return (
      <box width={width} height={height} backgroundColor={palette.bg}>
        {settingsDialog}
      </box>
    );
  const closeSkills = () => {
    setSkillsOpen(false);
    controller?.setOverlay();
    controller?.setFocus(focus === "editor" ? "composer" : focus);
  };
  const prepareSkill = (value: string) => {
    acceptedCompletion.current = value;
    editor.current?.setText(value);
    if (editor.current) editor.current.cursorOffset = value.length;
    setDraft(value);
    controller?.setDraft(value);
    setSuggestionsDismissed(true);
    closeSkills();
    setFocus("editor");
    controller?.setFocus("composer");
  };

  const composer = (
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
            `${index + suggestionStart === selectedSuggestionIndex ? ">" : " "} ${command.name} | ${command.description}`,
            Math.max(8, composerWidth - 3),
          )}
        </text>
      ))}
      <OpenTuiPrompt
        palette={palette}
        width={composerWidth}
        focused={
          focus === "editor" &&
          !skillsOpen &&
          !settingsOpen &&
          !modelsActions &&
          !permissionsOpen &&
          !approval
        }
        hasDraft={!!draft.trim()}
        busy={view.busy}
        model={
          view.modelSelection?.model ?? view.usage?.model ?? getDefaultModel?.()
        }
        agentMode={view.agentMode}
        runningMode={view.runningMode}
        approvalMode={view.approvalMode}
        runningApprovalMode={view.runningApprovalMode}
        onToggleMode={toggleAgentMode}
        onPermissionsSelect={openPermissions}
        onModelSelect={getModelsActions ? openModels : undefined}
        onSubmit={() => submit()}
      >
        <textarea
          id="prompt-editor"
          ref={editor}
          height={editorHeight}
          focused={
            focus === "editor" &&
            !skillsOpen &&
            !settingsOpen &&
            !modelsActions &&
            !permissionsOpen &&
            !approval
          }
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
          onSubmit={() => submit()}
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "return", shift: true, action: "newline" },
          ]}
        />
      </OpenTuiPrompt>
      <text fg={palette.muted} height={1}>
        {terminalLine(
          composerWidth >= 70
            ? "Enter отправить | Shift+Enter строка | Shift+Tab режим | F4 разрешения"
            : composerWidth >= 45
              ? "Enter отправить | Shift+Tab режим | F4 разрешения"
              : "Shift+Tab режим | F4 доступ | Enter",
          composerWidth,
        )}
      </text>
    </box>
  );

  return (
    <box
      width={width}
      height={height}
      flexDirection="column"
      backgroundColor={palette.bg}
    >
      {workspace && (
        <SessionTabs workspace={workspace} width={width} palette={palette} />
      )}
      <box width={width} height={height - tabRows} flexDirection="row">
        {!contextOnly &&
          (home ? (
            <OpenTuiHome
              projectPath={view.projectPath}
              width={textWidth}
              height={height - tabRows}
              palette={palette}
              feedback={
                view.transcript.length > 0 && !visibleSuggestions.length ? (
                  <TerminalScrollbox
                    ref={transcript}
                    height={Math.min(
                      6,
                      Math.max(
                        1,
                        homeHeight -
                          homeFixedRows -
                          editorHeight -
                          visibleSuggestions.length -
                          1,
                      ),
                    )}
                    marginTop={1}
                    width="100%"
                    viewportCulling
                    scrollbarOptions={{ visible: false }}
                  >
                    <OpenTuiTranscript
                      entries={view.transcript}
                      contentWidth={composerWidth - 2}
                      palette={palette}
                    />
                  </TerminalScrollbox>
                ) : undefined
              }
            >
              {composer}
            </OpenTuiHome>
          ) : (
            <box
              width={textWidth}
              height={height - tabRows}
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
            >
              {!workspace && (
                <>
                  {showLogo &&
                    (initialUnicodeDecorations
                      ? COMPACT_LOGO
                      : ["<i> ChiselCode"]
                    ).map((row) => (
                      <text key={row} fg={palette.accent}>
                        {row}
                      </text>
                    ))}
                  <text fg={palette.accent}>
                    {onSubmit
                      ? `[i] ${showLogo ? "" : "ChiselCode  |  "}${terminalLine(view.sessionTitle ?? "новый сеанс", Math.max(12, textWidth - 32))}  |  ${theme}`
                      : `[i] ChiselCode | probe | ${width}x${height} | ${theme}`}
                  </text>
                  <box
                    width="100%"
                    flexDirection="row"
                    justifyContent="space-between"
                  >
                    <text fg={palette.muted}>
                      {terminalSafeText(
                        view.projectPath,
                        Math.max(8, textWidth - 23),
                      )}
                    </text>
                    {/* biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+comma also opens settings. */}
                    <box
                      backgroundColor={palette.raised}
                      paddingLeft={1}
                      paddingRight={1}
                      onMouseUp={() => {
                        openSettings("connection");
                      }}
                    >
                      <text fg={palette.accent}>Настройки Ctrl+,</text>
                    </box>
                  </box>
                </>
              )}
              {height >= 12 && (
                <TerminalScrollbox
                  ref={transcript}
                  height={feedHeight}
                  stickyScroll={!home}
                  stickyStart={home ? "top" : "bottom"}
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
                        example.ts | +1 -1 | Ctrl+D: diff
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
                    <React.Fragment>
                      <text
                        fg={
                          view.runningMode === "plan"
                            ? palette.yellow
                            : palette.accent
                        }
                      >
                        ●{" "}
                        {AGENT_MODE_LABELS[view.runningMode ?? view.agentMode]}{" "}
                        |{" "}
                        {view.runningMode === "plan"
                          ? "составляет план..."
                          : "отвечает..."}
                      </text>
                      <FormattedMessage
                        content={view.streaming}
                        palette={palette}
                      />
                    </React.Fragment>
                  )}
                  {controller && view.toolActivity && (
                    <text fg={palette.muted}>
                      {terminalSafeText(view.toolActivity, 2_000)}
                    </text>
                  )}
                </TerminalScrollbox>
              )}
              {composer}
            </box>
          ))}
        {showSidebar && (
          <box
            ref={sidebar}
            width={contextOnly ? width : 41}
            height={height - tabRows}
            flexDirection="row"
            focusable
          >
            {!contextOnly && <box width={1} backgroundColor={palette.border} />}
            <ContextSidebar
              state={view}
              width={contextOnly ? Math.min(width, 40) : 40}
              height={height - tabRows}
              focused={focus === "sidebar"}
              palette={palette}
            />
          </box>
        )}
      </box>
      {settingsDialog}
      {permissionsOpen && !approval && (
        <OpenTuiPermissions
          width={width}
          height={height}
          palette={palette}
          mode={view.approvalMode}
          allowBypassPermissions={bypassAllowed}
          onClose={closePermissions}
          onSelect={(next) => {
            changeApprovalMode(next);
            closePermissions();
          }}
          onSettings={() => {
            setPermissionsOpen(false);
            openSettings("permissions");
          }}
        />
      )}
      {modelsActions && !approval && (
        <OpenTuiModels
          actions={modelsActions}
          width={width}
          height={height}
          palette={palette}
          onClose={() => {
            setModelsActions(undefined);
            controller?.setOverlay();
            controller?.setFocus(focus === "editor" ? "composer" : focus);
          }}
          onSettings={() => {
            setModelsActions(undefined);
            openSettings("connection");
          }}
        />
      )}
      {approval && (
        <OpenTuiApproval
          request={approval}
          width={width}
          height={height}
          palette={palette}
          onApprove={() => approvalResolver?.resolve("approved")}
          onDeny={() => approvalResolver?.resolve("denied")}
        />
      )}
      {skillsOpen && skillsActions && !approval && (
        <OpenTuiSkills
          actions={skillsActions}
          width={width}
          height={height}
          palette={palette}
          onClose={closeSkills}
          onChoose={(skill) =>
            prepareSkill(
              skillCommandDraft(skill.name, draft, skillsActions.load()),
            )
          }
          onCreate={() =>
            prepareSkill(
              skillCommandDraft("skill-creator", draft, skillsActions.load()),
            )
          }
          onEdit={
            skillsActions.editSource
              ? (skill) =>
                  prepareSkill(
                    skillEditDraft(
                      skill.name,
                      skillsActions.editSource?.(skill.name) ?? "",
                      draft,
                    ),
                  )
              : undefined
          }
        />
      )}
    </box>
  );
}
