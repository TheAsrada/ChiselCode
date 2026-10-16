/** @jsxImportSource @opentui/react */

import type {
  BoxRenderable,
  ClipboardService,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { backgroundActive } from "../background/contracts.js";
import {
  type CommandProjection,
  composeCommandProjection,
} from "../commands/slash.js";
import type { OpenTuiMcpActions } from "../mcp/controller.js";
import {
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
import type { ThemeCatalog } from "../themes/catalog.js";
import { AgentsSidebar } from "./agents-sidebar.js";
import { type ThemeName, themePalette } from "./appearance.js";
import {
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
import {
  dispatchCoreChat,
  ExtensionUiBinding,
  type UiToolSubmit,
} from "./extension-ui.js";
import { COMPACT_LOGO, LOGO_WIDTH } from "./logo.js";
import { OpenTuiAgentDetails } from "./opentui-agent-details.js";
import { OpenTuiApproval } from "./opentui-approval.js";
import { OpenTuiBackgroundDetails } from "./opentui-background-details.js";
import { OpenTuiBackgroundTasks } from "./opentui-background-tasks.js";
import { OpenTuiClipboard, useClipboardComposer } from "./opentui-clipboard.js";
import { ContextCompactionMessage } from "./opentui-compaction.js";
import {
  UiCompositionControls,
  UiCompositionNotices,
  UiCompositionProvider,
  UiSurface,
} from "./opentui-composition.js";
import { DialogAction } from "./opentui-dialog.js";
import { OpenTuiExtensionDetails } from "./opentui-extension-details.js";
import { OpenTuiMcp } from "./opentui-mcp.js";
import { OpenTuiModels, type OpenTuiModelsActions } from "./opentui-models.js";
import { OpenTuiHome, SessionTabs } from "./opentui-navigation.js";
import { OpenTuiPermissions } from "./opentui-permissions.js";
import { OpenTuiPrompt } from "./opentui-prompt.js";
import { OpenTuiRequestStatus } from "./opentui-request-status.js";
import {
  OpenTuiSessions,
  type OpenTuiSessionsActions,
} from "./opentui-sessions.js";
import {
  OpenTuiSettings,
  type OpenTuiSettingsActions,
} from "./opentui-settings.js";
import { OpenTuiSideQuery } from "./opentui-side-query.js";
import { OpenTuiSkills, type OpenTuiSkillsActions } from "./opentui-skills.js";
import { compactUiStatuses, OpenTuiStatusOverflow } from "./opentui-status.js";
import {
  FormattedMessage,
  OpenTuiTranscript,
  TRANSCRIPT_WINDOW,
  terminalSafeText,
  visibleTranscriptWindow,
} from "./opentui-transcript.js";
import { OpenTuiUpdate, updateNotice } from "./opentui-update.js";
import {
  capturedInputOwner,
  useOverlayInputOwner,
  useUiKeyboard,
} from "./overlay-input.js";
import {
  parseSidebarMode,
  type SidebarMode,
  sidebarLayout,
  toggleSidebarMode,
} from "./sidebar-layout.js";
import { SidebarMenu, type SidebarMenuAction } from "./sidebar-menu.js";
import {
  SidebarPanel,
  type SidebarTab,
  sidebarChrome,
} from "./sidebar-panel.js";
import { skillCommandDraft, skillEditDraft } from "./skill-draft.js";
import { TerminalScrollbox } from "./terminal-decoration.js";
import { terminalLine } from "./terminal-text.js";
import {
  actionTargets,
  createActionPresentation,
  groupToolActions,
} from "./tool-actions.js";
import type { TuiApprovalResolver } from "./tui-contract.js";
import type { TuiController, TuiViewState } from "./tui-controller.js";
import type { TuiWorkspace } from "./tui-workspace.js";
import type { UpdateController } from "./update-controller.js";
import type { WorkspaceCommandsPort } from "./workspace-commands.js";

const PATCH = `diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -1 +1 @@
-const greeting = "Hello";
+const greeting = "Привет";
`;

/** The regular agent supplies a workspace; standalone probes keep their fixture. */
export function OpenTuiSpike(
  props: Parameters<typeof OpenTuiScreen>[0] & { clipboard?: ClipboardService },
) {
  const [, refresh] = useState(0);
  const [theme, setTheme] = useState(props.initialTheme ?? "obsidian");
  const [previewTheme, setPreviewTheme] = useState<ThemeName>();
  useEffect(
    () => props.themeCatalog?.subscribe(() => refresh((value) => value + 1)),
    [props.themeCatalog],
  );
  const [mode, setMode] = useState(props.initialMode ?? "auto");
  const [setupOpen, setSetupOpen] = useState(props.initialSettingsOpen);
  const [bypassAllowed, setBypassAllowed] = useState(
    props.allowBypassPermissions ?? false,
  );
  useEffect(
    () => props.workspace?.subscribe(() => refresh((value) => value + 1)),
    [props.workspace],
  );
  const controller = props.workspace?.controller ?? props.controller;
  const currentScreenKey = props.workspace
    ? (props.workspace.activeKey ??
      `home:${controller?.snapshot.projectPath}:${controller?.currentGeneration}`)
    : "probe";
  const [settingsOwnerKey, setSettingsOwnerKey] = useState<string | undefined>(
    props.initialSettingsOpen ? currentScreenKey : undefined,
  );
  return (
    <OpenTuiClipboard
      palette={
        props.themeCatalog?.palette(previewTheme ?? theme, props.accent) ??
        themePalette(previewTheme ?? theme, props.accent)
      }
      clipboard={props.clipboard}
    >
      <OpenTuiScreen
        key={settingsOwnerKey ?? currentScreenKey}
        {...props}
        onSettingsVisibility={(open) =>
          setSettingsOwnerKey(open ? currentScreenKey : undefined)
        }
        controller={controller}
        approvalResolver={
          props.approvalResolver ??
          (controller
            ? props.workspace?.execution(controller).approvalResolver
            : undefined)
        }
        onThemePreview={setPreviewTheme}
        initialTheme={theme}
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
          setPreviewTheme(undefined);
        }}
        onModeChange={(next) => {
          setMode(next);
          props.onModeChange?.(next);
        }}
      />
    </OpenTuiClipboard>
  );
}

function OpenTuiScreen({
  onExit,
  onCancel,
  onSideCancel,
  controller,
  workspace,
  classic = false,
  initialMode = "auto",
  onModeChange,
  approvalResolver,
  onSubmit,
  onUiTool,
  uiRedactor,
  sessionPicker,
  settingsActions,
  getSettingsActions,
  onSettingsVisibility,
  updater,
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
  commandActions,
  getMcpActions,
  initialTheme = "obsidian",
  themeCatalog,
  accent,
  onThemeChange,
  onThemePreview,
}: {
  onExit: () => void;
  onCancel?: () => void;
  onSideCancel?: () => void;
  controller?: TuiController;
  workspace?: TuiWorkspace;
  classic?: boolean;
  initialMode?: SidebarMode;
  onModeChange?: (mode: SidebarMode) => void;
  approvalResolver?: TuiApprovalResolver;
  onSubmit?: (prompt: string, origin?: TuiController) => Promise<void>;
  onUiTool?: UiToolSubmit;
  uiRedactor?: import("../security/redaction.js").SecretRedactor;
  sessionPicker?: OpenTuiSessionsActions;
  settingsActions?: OpenTuiSettingsActions;
  getSettingsActions?: () => OpenTuiSettingsActions;
  onSettingsVisibility?: (open: boolean) => void;
  updater?: UpdateController;
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
  commandActions?: WorkspaceCommandsPort;
  getMcpActions?: (root?: string) => OpenTuiMcpActions;
  initialTheme?: ThemeName;
  themeCatalog?: ThemeCatalog;
  accent?: string;
  onThemeChange?: (theme: ThemeName) => void | Promise<void>;
  onThemePreview?: (theme: ThemeName) => void;
}) {
  const { width, height } = useTerminalDimensions();
  const nativeRenderer = useRenderer();
  const editor = React.useRef<TextareaRenderable>(null);
  const history = React.useRef(
    controller?.presentation.history ?? createEditorState(),
  );
  const applyingHistory = React.useRef(false);
  const acceptedCompletion = React.useRef<string | undefined>(undefined);
  const transcript = React.useRef<ScrollBoxRenderable>(null);
  const sidebar = React.useRef<BoxRenderable>(null);
  const agentLoad = useRef(0);
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
  const palette =
    themeCatalog?.palette(theme, accent) ?? themePalette(theme, accent);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [mcpActions, setMcpActions] = useState<OpenTuiMcpActions>();
  const [modelsActions, setModelsActions] = useState<OpenTuiModelsActions>();
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [update, setUpdate] = useState(updater?.snapshot);
  useEffect(() => updater?.subscribe(setUpdate), [updater]);
  const [bypassAllowed, setBypassAllowed] = useState(allowBypassPermissions);
  const [commandProjection, setCommandProjection] = useState<CommandProjection>(
    () => composeCommandProjection(),
  );
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [setupPending, setSetupPending] = useState(initialSettingsOpen);
  const [capturedSettingsActions, setCapturedSettingsActions] = useState(
    () => getSettingsActions?.() ?? settingsActions,
  );
  const settingsIntegration = useRef(false);
  const [settingsSelection, setSettingsSelection] = useState(0);
  const [settingsPage, setSettingsPage] = useState<
    "connection" | "appearance" | "permissions" | "web"
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
  const compositionPosition = useRef<
    | {
        owner: string;
        generation: number;
        editor: TextareaRenderable | null;
        cursor: number;
        scroll: ScrollBoxRenderable | null;
        top: number;
        pinned: boolean;
      }
    | undefined
  >(undefined);
  const priorContributions = useRef(view.uiContributions);
  useEffect(
    () =>
      controller?.subscribe((next) => {
        if (next.uiContributions !== priorContributions.current) {
          priorContributions.current = next.uiContributions;
          const scroll = transcript.current;
          compositionPosition.current ??= {
            owner: controller.conversationId,
            generation: controller.currentGeneration,
            editor: editor.current,
            cursor: editor.current?.cursorOffset ?? 0,
            scroll,
            top: scroll?.scrollTop ?? 0,
            pinned:
              !scroll ||
              scroll.scrollTop >=
                scroll.scrollHeight - scroll.viewport.height - 1,
          };
        }
        setView(next);
      }),
    [controller],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore native position after a composition commit, including structural changes that replace refs.
  useLayoutEffect(() => {
    const saved = compositionPosition.current;
    compositionPosition.current = undefined;
    if (
      !saved ||
      saved.owner !== controller?.conversationId ||
      saved.generation !== controller.currentGeneration
    )
      return;
    if (editor.current && saved.editor !== editor.current)
      editor.current.cursorOffset = Math.min(
        saved.cursor,
        editor.current.plainText.length,
      );
    if (
      transcript.current &&
      saved.scroll !== transcript.current &&
      !saved.pinned
    ) {
      const scroll = transcript.current;
      const restore = () => {
        if (transcript.current === scroll) scroll.scrollTo(saved.top);
      };
      nativeRenderer.once("frame", restore);
      nativeRenderer.requestRender();
      return () => {
        nativeRenderer.off("frame", restore);
      };
    }
  }, [controller, nativeRenderer, view.uiContributions]);
  const uiBinding = controller?.uiBinding;
  const bindingGeneration = controller?.currentGeneration;
  const [uiEpoch, setUiEpoch] = useState(0);
  useEffect(
    () => commandActions?.subscribeUi?.(() => setUiEpoch((epoch) => epoch + 1)),
    [commandActions],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Session allocation replaces the pre-session binding without creating a session from a view.
  useEffect(() => {
    if (!controller || !commandActions?.uiScope) return;
    let active = true;
    let binding: ExtensionUiBinding | undefined;
    const root = controller.snapshot.projectPath;
    void (
      commandActions.uiScopes
        ? commandActions.uiScopes(root, controller.ownerSignal)
        : commandActions
            .uiScope(root, controller.ownerSignal)
            .then((scope) => (scope ? [scope] : []))
    ).then(([scope, ...additional]) => {
      if (
        !active ||
        !scope ||
        controller.ownerSignal.aborted ||
        controller.currentGeneration !== bindingGeneration
      )
        return;
      binding = new ExtensionUiBinding(
        controller,
        scope,
        onUiTool,
        uiRedactor,
        additional,
      );
      controller.uiBinding = binding;
    });
    return () => {
      active = false;
      binding?.dispose();
      if (controller.uiBinding === binding) controller.uiBinding = undefined;
    };
  }, [
    controller,
    commandActions,
    onUiTool,
    uiRedactor,
    bindingGeneration,
    view.sessionId,
    uiEpoch,
  ]);
  const [focus, setFocus] = useState<"editor" | "transcript" | "sidebar">(
    "editor",
  );
  useEffect(() => {
    if (view.focus === "sidebar" && view.agentTree?.view === "agents") {
      setFocus("sidebar");
      setOverlayDismissed(false);
    }
  }, [view.focus, view.agentTree?.view]);
  const [uiOverflow, setUiOverflow] = useState(false);
  const [uiControls, setUiControls] = useState(false);
  const extensionActive = !!view.extensionView && !approval;
  const otherOverlay = !!(
    pickerOpen ||
    settingsOpen ||
    skillsOpen ||
    mcpActions ||
    modelsActions ||
    permissionsOpen ||
    updateOpen ||
    view.extensionView ||
    uiControls ||
    uiOverflow
  );
  const sideActive = !!(
    controller &&
    view.sideView?.visible &&
    !approval &&
    !otherOverlay &&
    !view.agentView?.visible &&
    !view.backgroundView?.visible &&
    !view.backgroundPanel
  );
  const agentActive = !!(
    controller &&
    view.agentView?.visible &&
    !approval &&
    !otherOverlay &&
    !view.backgroundView?.visible &&
    !view.backgroundPanel
  );
  const backgroundPanelActive = !!(
    controller &&
    view.backgroundPanel &&
    !view.backgroundView?.visible &&
    !approval &&
    !otherOverlay
  );
  const backgroundActiveView = !!(
    controller &&
    view.backgroundView?.visible &&
    !approval &&
    !otherOverlay
  );
  const sidebarTab = view.agentTree?.view ?? "context";
  const sidebarFocused = !!(
    focus === "sidebar" &&
    !approval &&
    !otherOverlay &&
    !sideActive &&
    !agentActive &&
    !backgroundActiveView &&
    !backgroundPanelActive
  );
  const agentsFocused = sidebarFocused && sidebarTab === "agents";
  const sidebarOwner =
    sidebarTab === "agents"
      ? `agents:${controller?.conversationId}:${controller?.currentGeneration}`
      : `sidebar:${controller?.conversationId}:${controller?.currentGeneration}`;
  const sideOwner = `side:${controller?.conversationId}:${controller?.currentGeneration}`;
  const inputOwner = approval
    ? "approval"
    : uiControls
      ? `ui-controls:${controller?.conversationId}:${controller?.currentGeneration}`
      : uiOverflow
        ? `ui-status:${controller?.conversationId}:${controller?.currentGeneration}`
        : extensionActive
          ? `extension-view:${controller?.conversationId}:${controller?.currentGeneration}`
          : otherOverlay
            ? "dialog"
            : backgroundPanelActive
              ? `background:${controller?.conversationId}:${controller?.currentGeneration}`
              : backgroundActiveView
                ? `background-view:${controller?.conversationId}:${controller?.currentGeneration}`
                : agentActive
                  ? `agent-view:${controller?.conversationId}:${controller?.currentGeneration}`
                  : sideActive
                    ? sideOwner
                    : sidebarFocused
                      ? sidebarOwner
                      : "main";
  useOverlayInputOwner(inputOwner);
  const cancelApprovalChild = approval?.owner?.childId
    ? () => {
        const request = approval;
        const origin = controller;
        const generation = origin?.currentGeneration;
        const controls = origin?.subagentControls;
        const id = request.owner?.childId;
        if (
          !origin ||
          !controls ||
          !id ||
          origin.snapshot.sessionId !== request.owner?.rootOwnerId
        )
          return;
        // Capture the addressed child; a later selection/tab cannot redirect Stop.
        void controls.port.cancel(id).catch(() => {
          if (origin.currentGeneration !== generation) return;
          origin.appendNotice("Не удалось остановить помощника", "error");
        });
      }
    : undefined;
  useEffect(() => {
    if (otherOverlay) controller?.hideSide();
    if (otherOverlay) controller?.hideAgent();
  }, [otherOverlay, controller]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: project and panel changes reload the shared command projection.
  useEffect(() => {
    let active = true;
    const origin = controller;
    const generation = origin?.currentGeneration;
    const root = view.projectPath;
    setCommandProjection(composeCommandProjection());
    if (commandActions) {
      void commandActions
        .load(root)
        .then((snapshot) => {
          if (
            !active ||
            (generation !== undefined && !origin?.isCurrent(generation))
          )
            return;
          setCommandProjection(snapshot.projection);
          if (snapshot.error) origin?.append(snapshot.error, "error");
        })
        .catch(() => {
          if (active)
            origin?.append("Не удалось загрузить команды проекта.", "error");
        });
      return () => {
        active = false;
      };
    }
    try {
      setCommandProjection(
        composeCommandProjection(
          skillsActions ? invocableSkills(skillsActions.load()) : [],
        ),
      );
    } catch {
      // The library popup presents discovery failures without breaking the composer.
      setCommandProjection(composeCommandProjection());
    }
    return () => {
      active = false;
    };
  }, [commandActions, skillsActions, controller, view.projectPath, skillsOpen]);
  const [expanded, setExpanded] = useState(
    controller?.presentation.expanded ?? false,
  );
  const [expandedDiffIds, setExpandedDiffIds] = useState<ReadonlySet<number>>(
    () => new Set(controller?.presentation.expandedDiffIds),
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
      controller.presentation.expandedDiffIds = new Set(expandedDiffIds);
    }
  }, [controller, windowEnd, expanded, expandedDiffIds]);
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
      setExpandedDiffIds(new Set());
    }
    previousLocation.current = {
      sessionId: view.sessionId,
      projectPath: view.projectPath,
    };
  }, [view.sessionId, view.projectPath]);
  const [transcriptTargetId, setTranscriptTargetId] = useState<
    string | undefined
  >();
  const fallbackActions = useRef(createActionPresentation());
  const actions = controller?.presentation.actions ?? fallbackActions.current;
  const actionRows = React.useMemo(
    () => groupToolActions(view.transcript),
    [view.transcript],
  );
  const transcriptTargets = actionTargets(
    visibleTranscriptWindow(actionRows, windowEnd).entries,
    actions,
  );
  const focusedTarget =
    focus === "transcript"
      ? transcriptTargets.find((target) => target.id === transcriptTargetId)
      : undefined;
  const focusedSideId =
    focusedTarget && !focusedTarget.group && !focusedTarget.action
      ? focusedTarget.id
      : undefined;
  const focusedActionId =
    focusedTarget && !focusedSideId ? focusedTarget.id : undefined;
  useLayoutEffect(() => {
    if (focus === "transcript" && focusedActionId)
      transcript.current?.scrollChildIntoView(
        focusedActionId.startsWith("action-group:")
          ? `${focusedActionId}-toggle`
          : focusedActionId,
      );
  }, [focus, focusedActionId]);
  const activateTranscriptTarget = () => {
    if (!focusedTarget) return;
    if (focusedSideId) controller?.openSide(focusedSideId);
    else controller?.activateAction(focusedTarget);
  };
  useLayoutEffect(() => {
    if (
      sideActive ||
      agentActive ||
      backgroundActiveView ||
      backgroundPanelActive
    )
      editor.current?.blur();
    else if (!approval && !otherOverlay && focus === "editor")
      editor.current?.focus();
  }, [
    sideActive,
    agentActive,
    backgroundActiveView,
    backgroundPanelActive,
    approval,
    otherOverlay,
    focus,
  ]);
  const home = !!workspace && !workspace.activeKey;
  const tabRows = workspace?.tabs.length ? 3 : 0;
  useEffect(() => {
    if (home && view.transcript.length > 0)
      transcript.current?.scrollTo(Number.MAX_SAFE_INTEGER);
  }, [home, view.transcript.length]);
  const layout = sidebarLayout(
    width,
    view.agentTree?.temporary
      ? "show"
      : home && mode === "auto"
        ? "hide"
        : mode,
    overlayDismissed,
  );
  const showSidebar = layout.placement !== "hidden";
  const contextOnly = layout.placement === "fullscreen";
  const sidebarDrawer = layout.placement === "overlay";
  const uiFaultRows = (view.uiContributions ?? []).some(
    (item) =>
      item.descriptor.slot === "render" &&
      ["error", "unavailable"].includes(item.snapshot.state),
  )
    ? 1
    : 0;
  const panelHeight = Math.max(1, height - tabRows - uiFaultRows);
  const panelWidth = layout.sidebarWidth;
  const chrome = sidebarChrome(panelHeight);
  const panelBodyHeight = Math.max(
    1,
    panelHeight - chrome.header - chrome.footer,
  );
  const textWidth = layout.feedWidth;
  const composerWidth = home
    ? Math.max(1, Math.min(86, textWidth - 4))
    : Math.max(1, textWidth - 2);
  const homeHeight = height - tabRows;
  const fullHomeLogo = home && textWidth >= LOGO_WIDTH + 4 && homeHeight >= 18;
  const homeCompact = homeHeight < 12;
  const notice = homeHeight >= 12 ? updateNotice(update) : undefined;
  const homeFixedRows =
    (notice ? 1 : 0) +
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
      ? matchingCommands(draft, commandProjection)
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
  let newestDiffId: number | undefined;
  for (let index = view.transcript.length - 1; index >= 0; index--) {
    const entry = view.transcript[index];
    if (entry?.fileDiff) {
      newestDiffId = entry.id;
      break;
    }
  }

  const toggleDiff = (id: number) => {
    transcript.current?.scrollChildIntoView(`file-diff-${id}-toggle`);
    setExpandedDiffIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const shiftWindow = (direction: "up" | "down") => {
    const total = actionRows.length;
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
      selectedSuggestion.source.type !== "builtin";
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
      !mcpActions &&
      !modelsActions &&
      !permissionsOpen &&
      !updateOpen &&
      !backgroundActiveView &&
      !backgroundPanelActive &&
      !contextOnly
    ) {
      if (focus === "editor") editor.current?.focus();
      else if (focus === "transcript") transcript.current?.focus();
      else if (sidebarTab !== "context") sidebar.current?.focus();
    }
  }, [
    approval,
    pickerOpen,
    settingsOpen,
    skillsOpen,
    mcpActions,
    modelsActions,
    permissionsOpen,
    updateOpen,
    backgroundActiveView,
    backgroundPanelActive,
    contextOnly,
    sidebarTab,
    focus,
  ]);
  useEffect(() => {
    if (focus === "sidebar" && !showSidebar) {
      setFocus("editor");
      controller?.setFocus("composer");
    }
  }, [focus, showSidebar, controller]);

  const openSettings = (
    page: "connection" | "appearance" | "permissions" | "web",
    selection = 0,
  ) => {
    editor.current?.blur();
    setCapturedSettingsActions(getSettingsActions?.() ?? settingsActions);
    setSettingsSelection(selection);
    setSettingsPage(page);
    setSettingsOpen(true);
    onSettingsVisibility?.(true);
    controller?.setOverlay("settings");
    controller?.setFocus("modal");
  };
  const closePermissions = () => {
    setPermissionsOpen(false);
    controller?.setOverlay();
    controller?.setFocus(focus === "editor" ? "composer" : focus);
  };
  const openPermissions = () => {
    if (
      approval ||
      pickerOpen ||
      settingsOpen ||
      skillsOpen ||
      mcpActions ||
      modelsActions ||
      updateOpen
    )
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
      mcpActions ||
      modelsActions ||
      permissionsOpen ||
      updateOpen
    )
      return;
    editor.current?.blur();
    setModelsActions(getModelsActions());
    controller?.setOverlay("models");
    controller?.setFocus("modal");
  };

  const openUpdate = () => {
    if (
      !updater ||
      approval ||
      pickerOpen ||
      settingsOpen ||
      skillsOpen ||
      mcpActions ||
      modelsActions ||
      permissionsOpen ||
      updateOpen
    )
      return;
    editor.current?.blur();
    setUpdateOpen(true);
    controller?.setOverlay("update");
    controller?.setFocus("modal");
    void updater.check();
  };

  useClipboardComposer(() => {
    if (
      sideActive ||
      agentActive ||
      backgroundActiveView ||
      backgroundPanelActive ||
      extensionActive ||
      uiOverflow ||
      sidebarFocused
    )
      return null;
    if (
      approval ||
      pickerOpen ||
      settingsOpen ||
      skillsOpen ||
      mcpActions ||
      modelsActions ||
      permissionsOpen ||
      updateOpen
    )
      return null;
    setFocus("editor");
    controller?.setFocus("composer");
    editor.current?.focus();
    return editor.current;
  });

  useUiKeyboard((key) => {
    if (capturedInputOwner(key) !== inputOwner) return;
    if (uiControls) {
      if (key.ctrl && key.name === "c") {
        key.preventDefault();
        key.stopPropagation();
      }
      return;
    }
    if (
      (key.option || key.meta) &&
      key.name === "u" &&
      !approval &&
      !otherOverlay &&
      !sideActive &&
      !agentActive &&
      !backgroundPanelActive &&
      !backgroundActiveView
    ) {
      key.preventDefault();
      key.stopPropagation();
      setUiControls(true);
      return;
    }
    if (key.ctrl && key.name === "c" && !key.shift) {
      key.preventDefault();
      if (
        uiOverflow ||
        extensionActive ||
        agentActive ||
        backgroundActiveView ||
        backgroundPanelActive ||
        sidebarFocused ||
        approval?.owner?.childId
      ) {
        key.stopPropagation();
        return;
      }
      onCancel?.();
      key.stopPropagation();
      return;
    }
    // Core tab navigation captures the origin before a viewer can consume Tab/arrows.
    if (
      workspace &&
      (extensionActive ||
        uiOverflow ||
        agentActive ||
        backgroundPanelActive ||
        backgroundActiveView ||
        sidebarFocused)
    ) {
      if (key.ctrl && key.name === "tab") {
        key.preventDefault();
        key.stopPropagation();
        workspace.cycle(key.shift ? -1 : 1);
        return;
      }
      if (
        (key.option || key.meta) &&
        (key.name === "left" || key.name === "right")
      ) {
        key.preventDefault();
        key.stopPropagation();
        workspace.cycle(key.name === "left" ? -1 : 1);
        return;
      }
    }
    if (
      uiOverflow ||
      extensionActive ||
      agentActive ||
      backgroundActiveView ||
      backgroundPanelActive
    )
      return;
    if (sidebarFocused) {
      if (key.ctrl && key.name === "b") {
        key.preventDefault();
        key.stopPropagation();
        changeMode("hide");
        controller?.setAgentSidebar(sidebarTab, false);
        setFocus("editor");
        controller?.setFocus("composer");
      } else if (key.ctrl && (key.name === "t" || key.name === ",")) {
        key.preventDefault();
        key.stopPropagation();
        openSettings(key.name === "t" ? "appearance" : "connection");
      } else if (key.ctrl && key.name === "n" && key.shift && workspace) {
        key.preventDefault();
        key.stopPropagation();
        workspace.newDraft();
      } else if (key.name === "tab" && sidebarTab !== "agents") {
        key.preventDefault();
        key.stopPropagation();
        backFromSidebar();
      }
      return;
    }
    if (sideActive) return;
    if (key.name === "f6" && !approval && !otherOverlay) {
      key.preventDefault();
      controller?.openSide();
      return;
    }
    if (key.name === "f7" && !approval && !otherOverlay && controller) {
      key.preventDefault();
      controller.setAgentSidebar("agents", true);
      setOverlayDismissed(false);
      setFocus("sidebar");
      controller.setFocus("sidebar");
      return;
    }
    // A pending approval belongs to its tab; users can visit another tab first.
    if (
      !approval &&
      (pickerOpen ||
        settingsOpen ||
        skillsOpen ||
        mcpActions ||
        modelsActions ||
        permissionsOpen ||
        updateOpen)
    )
      return;
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
    if (approval) {
      if (key.ctrl || key.meta || key.option) return;
      const answer = key.name.toLowerCase();
      if (answer === "s" && cancelApprovalChild) {
        key.preventDefault();
        key.stopPropagation();
        cancelApprovalChild();
        return;
      }
      if (approval.network && (answer === "a" || answer === "ф"))
        approvalResolver?.resolve("approved_session", approval);
      if (answer === "y" || answer === "н")
        approvalResolver?.resolve("approved", approval);
      if (answer === "n" || answer === "т" || answer === "escape")
        approvalResolver?.resolve("denied", approval);
      return;
    }
    if (
      pickerOpen ||
      settingsOpen ||
      skillsOpen ||
      mcpActions ||
      modelsActions ||
      permissionsOpen ||
      updateOpen ||
      extensionActive ||
      uiOverflow
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
    if (
      focusedTarget &&
      (key.name === "return" || key.name === "enter" || key.name === "space")
    ) {
      key.preventDefault();
      key.stopPropagation();
      activateTranscriptTarget();
      return;
    }
    if (focusedTarget && ["up", "down"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      const index = transcriptTargets.findIndex(
        (target) => target.id === focusedTarget.id,
      );
      setTranscriptTargetId(
        transcriptTargets[
          (index + (key.name === "up" ? -1 : 1) + transcriptTargets.length) %
            transcriptTargets.length
        ]?.id,
      );
      return;
    }
    if (key.name === "escape") {
      if (contextOnly || sidebarDrawer) setOverlayDismissed(true);
      else if (expanded || expandedDiffIds.size) {
        setExpanded(false);
        setExpandedDiffIds(new Set());
      } else if (focus !== "editor") {
        setFocus("editor");
        controller?.setFocus("composer");
      } else if (workspace && !home) workspace.select();
      return;
    }
    if (key.ctrl && key.name === "b") {
      const next = toggleSidebarMode(mode, width, showSidebar);
      changeMode(next);
      if (next === "show" && width < 120) focusSidebar();
    }
    if (key.name === "tab" && !contextOnly) {
      key.preventDefault();
      if (focus === "transcript" && transcriptTargetId !== undefined) {
        const current = transcriptTargets.findIndex(
          (target) => target.id === transcriptTargetId,
        );
        const index = current + (key.shift ? -1 : 1);
        if (index >= 0 && index < transcriptTargets.length)
          setTranscriptTargetId(transcriptTargets[index]?.id);
        else {
          setTranscriptTargetId(undefined);
          if (index < 0) {
            setFocus("editor");
            controller?.setFocus("composer");
          } else {
            setFocus(showSidebar ? "sidebar" : "editor");
            controller?.setFocus(showSidebar ? "sidebar" : "composer");
          }
        }
        return;
      }
      setTranscriptTargetId(
        focus === "editor" ? transcriptTargets[0]?.id : undefined,
      );
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
      if (classic || !controller) setExpanded((value) => !value);
      else if (newestDiffId !== undefined) toggleDiff(newestDiffId);
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
      mcpActions ||
      settingsOpen ||
      pickerOpen ||
      modelsActions ||
      permissionsOpen ||
      updateOpen
    )
      return;
    const value = command ?? editor.current?.plainText.trim();
    if (!value) return;
    if (value === "/exit") return onExit();
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
    // Renderer owns core UI commands only. Extension callbacks belong to application dispatch.
    const resolved = parseSlashCommand(value, commandProjection);
    const parsed =
      commandProjection.commands.find(
        (command) => command.name === resolved?.name,
      )?.source.type === "builtin"
        ? resolved
        : undefined;
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
    if (parsed?.name === "/sidebar") {
      const arg = parsed.args;
      const next = arg
        ? parseSidebarMode(arg)
        : toggleSidebarMode(mode, width, showSidebar);
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
    const registeredNavigation = value.startsWith("/")
      ? (view.uiContributions ?? []).find(
          (item) =>
            item.descriptor.slot === "menu_entry" &&
            item.descriptor.shortcut === value &&
            item.snapshot.action &&
            uiBinding?.subscription.action(
              item.key,
              item.snapshot.action,
              item.snapshot.revision,
            )?.type !== "tool",
        )
      : undefined;
    if (registeredNavigation?.snapshot.action) {
      clearInput();
      void uiBinding?.dispatch(
        registeredNavigation.key,
        registeredNavigation.snapshot.action,
        registeredNavigation.snapshot.revision,
      );
      return;
    }
    if (getModelsActions && value === "/model") {
      openModels();
      clearInput();
      return;
    }
    if (updater && value === "/update") {
      clearInput();
      openUpdate();
      return;
    }
    if ((settingsActions || getSettingsActions) && value === "/settings") {
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
    if (getMcpActions && value === "/mcp") {
      editor.current?.blur();
      setMcpActions(getMcpActions());
      controller?.setOverlay("mcp");
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

  const settingsDialog = settingsOpen ? (
    <OpenTuiSettings
      actions={capturedSettingsActions}
      active={!approval && !mcpActions && !skillsOpen}
      onOpenIntegration={(route) => {
        settingsIntegration.current = true;
        if (route === "tools.mcp" && getMcpActions) {
          setMcpActions(getMcpActions(capturedSettingsActions?.workspaceRoot));
          controller?.setOverlay("mcp");
        } else if (route === "tools.skills" && skillsActions) {
          setSkillsOpen(true);
          controller?.setOverlay("skills");
        }
      }}
      width={width}
      height={height}
      palette={palette}
      initialSelection={settingsSelection}
      initialPage={settingsPage}
      theme={initialTheme}
      themeCatalog={themeCatalog}
      setup={setupPending}
      onThemePreview={(next) => {
        setTheme(next);
        onThemePreview?.(next);
      }}
      onThemeChange={onThemeChange}
      allowBypassPermissions={bypassAllowed}
      onBypassAvailabilityChange={
        onBypassAvailabilityChange ? changeBypassAvailability : undefined
      }
      onClose={(outcome) => {
        settingsIntegration.current = false;
        if (setupPending && outcome === "saved") onSetupComplete?.();
        onInitialSettingsComplete?.();
        setSetupPending(false);
        setSettingsOpen(false);
        onSettingsVisibility?.(false);
        controller?.setOverlay();
        controller?.setFocus(focus === "editor" ? "composer" : focus);
      }}
    />
  ) : undefined;
  const closeSkills = () => {
    setSkillsOpen(false);
    controller?.setOverlay(
      settingsIntegration.current ? "settings" : undefined,
    );
    controller?.setFocus(
      settingsIntegration.current
        ? "modal"
        : focus === "editor"
          ? "composer"
          : focus,
    );
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

  const loadAgent = (id: string, section: "history" | "changes") => {
    const origin = controller;
    const generation = origin?.currentGeneration;
    const controls = origin?.subagentControls;
    if (!origin || generation === undefined) return;
    if (!controls) {
      origin.setAgentView({ loading: true, notice: undefined });
      return;
    }
    const request = ++agentLoad.current;
    origin.setAgentView({ loading: true, notice: undefined });
    void controls.inspect(id, section).then(
      (result) => {
        if (
          origin.isCurrent(generation) &&
          origin.snapshot.agentView?.id === id &&
          origin.snapshot.agentView.section === section &&
          request === agentLoad.current
        )
          origin.setAgentView({
            loading: false,
            history: result.text,
            diffs: result.diffs,
          });
      },
      (error) => {
        if (
          origin.isCurrent(generation) &&
          origin.snapshot.agentView?.id === id &&
          request === agentLoad.current
        )
          origin.setAgentView({
            loading: false,
            notice:
              error instanceof Error
                ? error.message
                : "Не удалось открыть результат.",
          });
      },
    );
  };
  const stopAgent = (id: string) => {
    const origin = controller;
    const generation = origin?.currentGeneration;
    const port = origin?.subagentControls?.port;
    if (!origin || !port || generation === undefined) return;
    void port.cancel(id).catch((error) => {
      if (origin.isCurrent(generation) && origin.snapshot.agentView?.id === id)
        origin.setAgentView({
          notice:
            error instanceof Error
              ? error.message
              : "Не удалось остановить помощника.",
        });
    });
  };
  const openAgent = (id: string) => {
    controller?.openAgent(id);
    loadAgent(id, "history");
  };
  // A saved conversation becomes visible before its core owner binding finishes loading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry only when the verified core port arrives, not on streaming/view updates.
  useEffect(() => {
    const active = controller?.snapshot.agentView;
    if (
      controller?.subagentControls &&
      active?.visible &&
      !active.history &&
      active.section !== "result"
    )
      loadAgent(active.id, active.section ?? "history");
  }, [
    controller,
    controller?.subagentControls,
    view.agentView?.id,
    view.agentView?.visible,
  ]);
  const statusLayout = compactUiStatuses(
    view.uiContributions ?? [],
    height >= 10 ? composerWidth : 0,
  );
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
  if (setupPending && settingsOpen)
    return (
      <box width={width} height={height} backgroundColor={palette.bg}>
        {settingsDialog}
        {uiOverflow && !approval && (
          <OpenTuiStatusOverflow
            items={statusLayout.statuses}
            width={width}
            height={height}
            palette={palette}
            owner={`ui-status:${controller?.conversationId}:${controller?.currentGeneration}`}
            onClose={() => setUiOverflow(false)}
            onOpen={(item) => {
              setUiOverflow(false);
              if (item.snapshot.action)
                void uiBinding?.dispatch(
                  item.key,
                  item.snapshot.action,
                  item.snapshot.revision,
                );
              else uiBinding?.refresh();
            }}
          />
        )}
        {extensionActive && controller && (
          <OpenTuiExtensionDetails
            controller={controller}
            width={width}
            height={height}
            palette={palette}
          />
        )}
      </box>
    );
  const backFromSidebar = () => {
    controller?.setAgentSidebar(sidebarTab, false);
    setOverlayDismissed(true);
    setFocus("editor");
    controller?.setFocus("composer");
  };
  const focusSidebar = () => {
    editor.current?.blur();
    setFocus("sidebar");
    controller?.setFocus("sidebar");
  };
  const selectSidebar = (tab: SidebarTab) => {
    if (controller)
      controller.setAgentSidebar(tab, view.agentTree?.temporary ?? false);
    else
      setView((current) => ({
        ...current,
        agentTree: {
          view: tab,
          manual: true,
          collapsed: false,
          temporary: false,
        },
      }));
  };
  const openAgents = () => {
    controller?.setAgentSidebar("agents", true);
    setOverlayDismissed(false);
    focusSidebar();
  };
  const menuActions: SidebarMenuAction[] = [
    ...(sessionPicker
      ? [
          {
            id: "sessions",
            label: "История бесед",
            detail: "Открыть сохранённую сессию",
            shortcut: "/sessions",
            group: "БЕСЕДА",
            run: () => submit("/sessions"),
          },
        ]
      : []),
    ...(getModelsActions
      ? [
          {
            id: "models",
            label: "Модель",
            detail: "Провайдер и модель для задачи",
            shortcut: "/model",
            group: "БЕСЕДА",
            run: openModels,
          },
        ]
      : []),
    {
      id: "project",
      label: "Обзор проекта",
      detail: "Контекст, ветка и изменения Git",
      shortcut: "2",
      group: "ПРОЕКТ",
      run: () => selectSidebar("context"),
    },
    {
      id: "appearance",
      label: "Внешний вид",
      detail: "Тема и оформление терминала",
      shortcut: "Ctrl+T",
      group: "НАСТРОЙКИ",
      run: () => openSettings("appearance"),
    },
    {
      id: "permissions",
      label: "Разрешения",
      detail: "Режим доступа к инструментам",
      shortcut: "/permissions",
      group: "НАСТРОЙКИ",
      run: openPermissions,
    },
    ...(settingsActions || getSettingsActions
      ? [
          {
            id: "connection",
            label: "Подключение",
            detail: "Профили, ключи и провайдеры",
            shortcut: "/settings",
            group: "НАСТРОЙКИ",
            run: () => openSettings("connection"),
          },
        ]
      : []),
    ...(skillsActions
      ? [
          {
            id: "skills",
            label: "Навыки",
            detail: "Инструкции и команды навыков",
            shortcut: "/skills",
            group: "РАСШИРЕНИЯ",
            run: () => submit("/skills"),
          },
        ]
      : []),
    ...(getMcpActions
      ? [
          {
            id: "mcp",
            label: "MCP-серверы",
            detail: "Подключённые инструменты",
            shortcut: "/mcp",
            group: "РАСШИРЕНИЯ",
            run: () => submit("/mcp"),
          },
        ]
      : []),
  ];
  for (const item of view.uiContributions ?? []) {
    if (item.descriptor.slot !== "menu_entry") continue;
    menuActions.push({
      id: item.key,
      label: item.descriptor.title,
      detail:
        item.snapshot.state === "unavailable"
          ? "Данные недоступны · повторите получение"
          : (item.snapshot.detail ??
            item.descriptor.description ??
            "Данные недоступны"),
      shortcut: item.descriptor.shortcut ?? "",
      group: {
        conversation: "БЕСЕДА",
        project: "ПРОЕКТ",
        extensions: "РАСШИРЕНИЯ",
      }[item.descriptor.group ?? "extensions"],
      run: () => {
        if (item.snapshot.action)
          void uiBinding?.dispatch(
            item.key,
            item.snapshot.action,
            item.snapshot.revision,
          );
        else uiBinding?.refresh();
      },
    });
  }
  const groupOrder = ["БЕСЕДА", "ПРОЕКТ", "НАСТРОЙКИ", "РАСШИРЕНИЯ"];
  menuActions.sort(
    (a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group),
  );
  const activeChildren = (view.children ?? []).filter((child) =>
    [
      "queued",
      "preparing",
      "running",
      "awaiting_approval",
      "cancelling",
    ].includes(child.status),
  ).length;
  const childApproval = (view.children ?? []).some(
    (child) => child.status === "awaiting_approval",
  );
  const composer = (
    <UiSurface name="Composer" preserveNative>
      <UiSurface name="AbovePrompt" />
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
          focused={
            focus === "editor" &&
            !skillsOpen &&
            !mcpActions &&
            !settingsOpen &&
            !modelsActions &&
            !permissionsOpen &&
            !updateOpen &&
            !approval &&
            !sideActive &&
            !agentActive &&
            !backgroundPanelActive &&
            !backgroundActiveView
          }
          hasDraft={!!draft.trim()}
          busy={view.busy}
          model={
            view.modelSelection?.model ??
            view.usage?.model ??
            getDefaultModel?.()
          }
          agentMode={view.agentMode}
          runningMode={view.runningMode}
          approvalMode={view.approvalMode}
          runningApprovalMode={view.runningApprovalMode}
          onToggleMode={() => {
            if (!sideActive && !agentActive && !approval && !otherOverlay)
              toggleAgentMode();
          }}
          onPermissionsSelect={openPermissions}
          onModelSelect={getModelsActions ? openModels : undefined}
          onSubmit={() => submit()}
        >
          <textarea
            id="prompt-editor"
            ref={editor}
            onMouseDown={() => {
              if (!approval && !otherOverlay) {
                setFocus("editor");
                controller?.setFocus("composer");
              }
            }}
            height={editorHeight}
            focused={
              focus === "editor" &&
              !skillsOpen &&
              !mcpActions &&
              !settingsOpen &&
              !modelsActions &&
              !permissionsOpen &&
              !updateOpen &&
              !approval &&
              !sideActive &&
              !agentActive &&
              !backgroundPanelActive &&
              !backgroundActiveView &&
              !extensionActive &&
              !uiOverflow &&
              !uiControls
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
        <UiSurface name="StatusLine">
          <box height={1} flexDirection="row" flexShrink={0}>
            <UiSurface name="PromptHints">
              <text
                fg={palette.muted}
                height={1}
                width={Math.max(1, composerWidth - statusLayout.reserved)}
              >
                {terminalLine(
                  !home && height < 10
                    ? `${view.agentMode === "plan" ? "Plan" : "Build"} | F4 | Enter`
                    : view.busy && onCancel
                      ? "Enter в очередь | Ctrl+C остановить | Ctrl+Tab вкладки"
                      : composerWidth - statusLayout.reserved >= 77
                        ? "Enter отправить | Shift+Enter строка | Shift+Tab режим | F4 разрешения"
                        : composerWidth >= 45
                          ? "Enter отправить | Shift+Tab режим | F4 разрешения"
                          : "Shift+Tab режим | F4",
                  Math.max(1, composerWidth - statusLayout.reserved),
                )}
              </text>
            </UiSurface>
            {statusLayout.visible.map(({ item, label }) => (
              <DialogAction
                key={item.key}
                id={`ui-status-${item.key}`}
                label={label}
                palette={palette}
                onSelect={() => {
                  if (item.snapshot.action)
                    void uiBinding?.dispatch(
                      item.key,
                      item.snapshot.action,
                      item.snapshot.revision,
                    );
                  else uiBinding?.refresh();
                }}
              />
            ))}
            {!!statusLayout.remaining && (
              <DialogAction
                id="ui-status-more"
                label={`Ещё ${statusLayout.remaining}`}
                palette={palette}
                onSelect={() => setUiOverflow(true)}
              />
            )}
          </box>
        </UiSurface>
      </box>
      <UiSurface name="BelowPrompt" />
    </UiSurface>
  );

  return (
    <UiCompositionProvider
      value={{
        items: view.uiContributions ?? [],
        palette,
        interactive: !approval && !otherOverlay,
        dispatch: (key, use, revision) => {
          void uiBinding?.dispatch(key, use, revision);
        },
      }}
    >
      <box
        width={width}
        height={height}
        flexDirection="column"
        backgroundColor={palette.bg}
      >
        <UiSurface name="App" preserveNative>
          {workspace && (
            <UiSurface name="WorkspaceTabs">
              <SessionTabs
                workspace={workspace}
                width={width}
                palette={palette}
              />
            </UiSurface>
          )}
          <UiSurface name="Main" preserveNative>
            <box width={width} height={panelHeight} flexDirection="row">
              {!contextOnly &&
                (home ? (
                  <UiSurface name="Home" preserveNative>
                    <OpenTuiHome
                      projectPath={view.projectPath}
                      width={textWidth}
                      height={panelHeight}
                      palette={palette}
                      updateNotice={notice}
                      onUpdate={openUpdate}
                      feedback={
                        view.transcript.length > 0 &&
                        !visibleSuggestions.length ? (
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
                              onOpenSide={(id) => controller?.openSide(id)}
                              onCardAction={(action, extensionId) => {
                                if (controller)
                                  void (uiBinding
                                    ? uiBinding.chat(
                                        action.target,
                                        action.action,
                                        extensionId,
                                      )
                                    : dispatchCoreChat(
                                        controller,
                                        action.target,
                                        action.action,
                                      ));
                              }}
                              onOpenCard={(target, extensionId) => {
                                if (controller)
                                  void (uiBinding
                                    ? uiBinding.chat(
                                        target,
                                        "open",
                                        extensionId,
                                      )
                                    : dispatchCoreChat(controller, target));
                              }}
                              focusedSideId={focusedSideId}
                              focusedActionId={focusedActionId}
                              actionPresentation={actions}
                              onActionSelect={(target) => {
                                controller?.activateAction(target);
                                if (focus === "editor") editor.current?.focus();
                              }}
                              entries={view.transcript}
                              contentWidth={composerWidth - 2}
                              expandedIds={expandedDiffIds}
                              onToggleDiff={toggleDiff}
                              palette={palette}
                            />
                          </TerminalScrollbox>
                        ) : undefined
                      }
                    >
                      {composer}
                    </OpenTuiHome>
                  </UiSurface>
                ) : (
                  <box
                    width={textWidth}
                    height={panelHeight}
                    flexDirection="column"
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    {!workspace && (
                      <UiSurface name="Header">
                        {showLogo &&
                          COMPACT_LOGO.map((row) => (
                            <text
                              key={row}
                              fg={palette.accent}
                              height={1}
                              flexShrink={0}
                            >
                              {row}
                            </text>
                          ))}
                        <text fg={palette.accent} height={1} flexShrink={0}>
                          {onSubmit
                            ? `[i] ${showLogo ? "" : "ChiselCode  |  "}${terminalLine(view.sessionTitle ?? "новый сеанс", Math.max(12, textWidth - 32))}  |  ${palette.label}`
                            : `[i] ChiselCode | probe | ${width}x${height} | ${palette.label}`}
                        </text>
                        <box
                          width="100%"
                          height={1}
                          flexShrink={0}
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
                            onMouseUp={(event) => {
                              if (event.button !== 0) return;
                              openSettings("connection");
                            }}
                          >
                            <text fg={palette.accent}>Настройки Ctrl+,</text>
                          </box>
                        </box>
                      </UiSurface>
                    )}
                    {height >= 12 && (
                      <UiSurface
                        name="Transcript"
                        preserveNative={view.transcript.some(
                          (entry) =>
                            entry.tone === "error" ||
                            (entry.toolAction &&
                              [
                                "failed",
                                "denied",
                                "cancelled",
                                "interrupted",
                              ].includes(entry.toolAction.state)),
                        )}
                      >
                        <TerminalScrollbox
                          ref={transcript}
                          flexGrow={1}
                          minHeight={0}
                          stickyScroll={
                            !home &&
                            expandedDiffIds.size === 0 &&
                            !expanded &&
                            actions.expanded.size === 0
                          }
                          stickyStart={home ? "top" : "bottom"}
                          viewportCulling
                          onMouseScroll={(event) => {
                            const box = transcript.current;
                            if (!box) return;
                            if (
                              event.scroll?.direction === "up" &&
                              box.scrollTop <= 0
                            )
                              shiftWindow("up");
                            if (
                              event.scroll?.direction === "down" &&
                              box.scrollTop >=
                                box.scrollHeight - box.viewport.height
                            )
                              shiftWindow("down");
                          }}
                        >
                          {controller ? (
                            <OpenTuiTranscript
                              onOpenSide={(id) => controller?.openSide(id)}
                              onCardAction={(action, extensionId) => {
                                if (controller)
                                  void (uiBinding
                                    ? uiBinding.chat(
                                        action.target,
                                        action.action,
                                        extensionId,
                                      )
                                    : dispatchCoreChat(
                                        controller,
                                        action.target,
                                        action.action,
                                      ));
                              }}
                              onOpenCard={(target, extensionId) => {
                                if (controller)
                                  void (uiBinding
                                    ? uiBinding.chat(
                                        target,
                                        "open",
                                        extensionId,
                                      )
                                    : dispatchCoreChat(controller, target));
                              }}
                              focusedSideId={focusedSideId}
                              focusedActionId={focusedActionId}
                              actionPresentation={actions}
                              onActionSelect={(target) => {
                                controller?.activateAction(target);
                                if (focus === "editor") editor.current?.focus();
                              }}
                              entries={
                                classic
                                  ? focus === "transcript"
                                    ? view.transcript
                                    : expanded
                                      ? view.transcript.filter(
                                          (entry) => entry.id === newestDiffId,
                                        )
                                      : []
                                  : view.transcript
                              }
                              contentWidth={textWidth - 2}
                              expandedId={
                                classic && expanded ? newestDiffId : undefined
                              }
                              expandedIds={
                                classic ? undefined : expandedDiffIds
                              }
                              onToggleDiff={
                                classic ? () => setExpanded(false) : toggleDiff
                              }
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
                                  view={
                                    textWidth - 2 >= 100 ? "split" : "unified"
                                  }
                                  height={5}
                                />
                              )}
                            </React.Fragment>
                          )}
                          {controller && view.streaming && (
                            <UiSurface
                              name="AssistantMessage"
                              values={{
                                text: view.streaming,
                                state: "streaming",
                              }}
                            >
                              <FormattedMessage
                                id="streaming-message"
                                streaming
                                content={view.streaming}
                                palette={palette}
                                width={textWidth - 2}
                              />
                            </UiSurface>
                          )}
                          {controller && view.toolActivity && (
                            <UiSurface
                              name="ToolProgress"
                              values={{ text: view.toolActivity }}
                            >
                              <text fg={palette.muted}>
                                {terminalSafeText(view.toolActivity, 2_000)}
                              </text>
                            </UiSurface>
                          )}
                          {controller && view.compaction && (
                            <ContextCompactionMessage
                              text={
                                "Сжимаю контекст...\nСохраняю задачу, решения и результаты работы"
                              }
                              palette={palette}
                            />
                          )}
                          {controller &&
                            view.requestStartedAt !== undefined && (
                              <UiSurface name="RequestStatus">
                                <OpenTuiRequestStatus
                                  controller={controller}
                                  palette={palette}
                                  width={textWidth - 2}
                                  awaitingApproval={!!approval}
                                />
                              </UiSurface>
                            )}
                        </TerminalScrollbox>
                      </UiSurface>
                    )}
                    {composer}
                  </box>
                ))}
              {showSidebar && (
                <UiSurface name="Sidebar">
                  <box
                    ref={sidebar}
                    width={contextOnly ? panelWidth : panelWidth + 1}
                    height={panelHeight}
                    position={sidebarDrawer ? "absolute" : "relative"}
                    right={sidebarDrawer ? 0 : undefined}
                    top={sidebarDrawer ? 0 : undefined}
                    flexDirection="row"
                    focusable
                  >
                    {!contextOnly && (
                      <box
                        width={1}
                        backgroundColor={
                          sidebarFocused ? palette.accent : palette.border
                        }
                      />
                    )}
                    <SidebarPanel
                      tab={sidebarTab}
                      width={panelWidth}
                      height={panelHeight}
                      palette={palette}
                      focused={sidebarFocused}
                      owner={sidebarOwner}
                      running={activeChildren}
                      approvals={
                        (view.children ?? []).filter(
                          (child) => child.status === "awaiting_approval",
                        ).length
                      }
                      busy={
                        view.busy ||
                        activeChildren > 0 ||
                        (view.backgroundTasks ?? []).some((task) =>
                          backgroundActive(task.state),
                        )
                      }
                      onFocus={focusSidebar}
                      onSelect={selectSidebar}
                      onBack={backFromSidebar}
                      onHide={() => {
                        changeMode("hide");
                        backFromSidebar();
                      }}
                    >
                      {sidebarTab === "menu" ? (
                        <UiSurface name="SidebarMenu">
                          <SidebarMenu
                            key={controller?.conversationId}
                            actions={menuActions}
                            controller={controller}
                            width={panelWidth}
                            height={panelBodyHeight}
                            palette={palette}
                            focused={sidebarFocused}
                            owner={sidebarOwner}
                            onFocus={focusSidebar}
                          />
                        </UiSurface>
                      ) : controller && sidebarTab === "agents" ? (
                        <UiSurface name="AgentTree">
                          <AgentsSidebar
                            embedded
                            controller={controller}
                            state={view}
                            width={panelWidth}
                            height={panelBodyHeight}
                            palette={palette}
                            focused={agentsFocused}
                            onFocus={focusSidebar}
                            onBack={backFromSidebar}
                            onContext={() => selectSidebar("context")}
                            onOpen={openAgent}
                            onStop={stopAgent}
                          />
                        </UiSurface>
                      ) : (
                        <UiSurface name="ContextPanel">
                          <ContextSidebar
                            key={controller?.conversationId}
                            state={view}
                            width={panelWidth}
                            height={panelBodyHeight}
                            focused={sidebarFocused}
                            palette={palette}
                            presentation={controller?.sidebarPresentation}
                            onAction={(item) => {
                              if (item.snapshot.action)
                                void uiBinding?.dispatch(
                                  item.key,
                                  item.snapshot.action,
                                  item.snapshot.revision,
                                );
                              else uiBinding?.refresh();
                            }}
                          />
                        </UiSurface>
                      )}
                    </SidebarPanel>
                  </box>
                </UiSurface>
              )}
            </box>
          </UiSurface>
        </UiSurface>
        <UiCompositionNotices />
        {uiControls && !approval && (
          <UiCompositionControls
            width={width}
            height={height}
            owner={inputOwner}
            onClose={() => setUiControls(false)}
          />
        )}
        {settingsDialog}
        {uiOverflow && !approval && (
          <OpenTuiStatusOverflow
            items={statusLayout.statuses}
            width={width}
            height={height}
            palette={palette}
            owner={`ui-status:${controller?.conversationId}:${controller?.currentGeneration}`}
            onClose={() => setUiOverflow(false)}
            onOpen={(item) => {
              setUiOverflow(false);
              if (item.snapshot.action)
                void uiBinding?.dispatch(
                  item.key,
                  item.snapshot.action,
                  item.snapshot.revision,
                );
              else uiBinding?.refresh();
            }}
          />
        )}
        {extensionActive && controller && (
          <OpenTuiExtensionDetails
            controller={controller}
            width={width}
            height={height}
            palette={palette}
          />
        )}
        {backgroundPanelActive && controller && (
          <OpenTuiBackgroundTasks
            controller={controller}
            view={view}
            width={width}
            height={height}
            palette={palette}
          />
        )}
        {backgroundActiveView && controller && (
          <OpenTuiBackgroundDetails
            controller={controller}
            view={view}
            width={width}
            height={height}
            palette={palette}
            onRetry={(id) => {
              void onSubmit?.(`/tasks retry ${id}`, controller);
            }}
          />
        )}
        {agentActive && controller && (
          <OpenTuiAgentDetails
            controller={controller}
            view={view}
            width={width}
            height={height}
            palette={palette}
            onLoad={loadAgent}
            onStop={stopAgent}
            onApply={(id) => {
              const origin = controller;
              const generation = origin.currentGeneration;
              const controls = origin.subagentControls;
              if (!controls) return;
              void controls.port
                .status(id)
                .then((child) => {
                  if (
                    !origin.isCurrent(generation) ||
                    origin.snapshot.agentView?.id !== id ||
                    !child.worktree ||
                    !child.cleanup.quiescent ||
                    [
                      "queued",
                      "preparing",
                      "running",
                      "awaiting_approval",
                      "cancelling",
                    ].includes(child.status)
                  )
                    return;
                  return onSubmit?.(
                    `/worktree apply ${child.worktree.id}`,
                    origin,
                  );
                })
                .catch((error) => {
                  if (
                    origin.isCurrent(generation) &&
                    origin.snapshot.agentView?.id === id
                  )
                    origin.setAgentView({
                      notice:
                        error instanceof Error
                          ? error.message
                          : "Не удалось подготовить перенос.",
                    });
                });
            }}
          />
        )}
        {updateOpen && updater && !approval && (
          <OpenTuiUpdate
            updater={updater}
            width={width}
            height={height}
            palette={palette}
            onClose={() => {
              setUpdateOpen(false);
              controller?.setOverlay();
              controller?.setFocus(focus === "editor" ? "composer" : focus);
            }}
          />
        )}
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
            onApprove={() => approvalResolver?.resolve("approved", approval)}
            onSessionApprove={() =>
              approvalResolver?.resolve("approved_session", approval)
            }
            onAlwaysApprove={() =>
              approvalResolver?.resolve("approved_always", approval)
            }
            onDeny={() => approvalResolver?.resolve("denied", approval)}
            onCancelChild={cancelApprovalChild}
          />
        )}
        {mcpActions && !approval && (
          <OpenTuiMcp
            actions={mcpActions}
            width={width}
            height={height}
            palette={palette}
            onClose={() => {
              setMcpActions(undefined);
              controller?.setOverlay(
                settingsIntegration.current ? "settings" : undefined,
              );
              controller?.setFocus(
                settingsIntegration.current
                  ? "modal"
                  : focus === "editor"
                    ? "composer"
                    : focus,
              );
            }}
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
        {sideActive && controller && (
          <OpenTuiSideQuery
            controller={controller}
            view={view}
            width={width}
            height={height}
            palette={palette}
            onStop={() => onSideCancel?.()}
            onSubmit={(question) => {
              void onSubmit?.(`/btw ${question}`, controller);
            }}
          />
        )}
      </box>
    </UiCompositionProvider>
  );
}
