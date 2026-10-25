import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { ConversationSourceBridge } from "../app/conversation-source.js";
import type { SubagentControls } from "../app/subagent-binding.js";
import type { BackgroundControls } from "../background/binding.js";
import {
  type BackgroundEvent,
  type BackgroundOutputPage,
  type BackgroundTask,
  backgroundActive,
} from "../background/contracts.js";
import { ToolResultStore } from "../context/tool-result-store.js";
import type { ContextCompactionRecord } from "../context/types.js";
import {
  aggregateSpend,
  childSpend,
  recomputeSessionSpend,
  sideSpend,
  spendForRecord,
} from "../models/accounting.js";
import {
  isModelRequestActive,
  type ModelSpend,
  type SideQueryRecord,
} from "../models/contracts.js";
import { sessionsRootDir } from "../paths/home.js";
import type { ModelCapabilities } from "../providers/capabilities.js";
import { catalogModelLimits } from "../providers/model-metadata.js";
import { type AgentMode, DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import {
  type ApprovalMode,
  DEFAULT_APPROVAL_MODE,
} from "../security/approval-mode.js";
import type {
  SubagentDescriptor,
  SubagentEvent,
} from "../subagents/contracts.js";
import type { ChatCard, OwnedChatCard } from "../types/chat-presentation.js";
import type {
  AgentResult,
  ContextSnapshot,
  FileDiff,
  Session,
  TokenUsage,
} from "../types/domain.js";
import { appendChatPresentation, chatCardText } from "./chat-presentation.js";
import { compactionNotice } from "./context-compaction.js";
import { createEditorState } from "./editor.js";
import { GitChangesSource, type GitWorkingState } from "./git-changes.js";
import type { ModelSelection } from "./opentui-models.js";
import {
  type RequestActivity,
  RequestActivityTracker,
} from "./request-activity.js";
import { requestCompletion } from "./request-timing.js";
import { sideStatus } from "./side-query-state.js";
import {
  type ActionTarget,
  actionIsSeparate,
  actionLabel,
  actionRunning,
  activateActionTarget,
  createActionPresentation,
  mergeToolAction,
  preserveActionExpansion,
  type ToolAction,
  type ToolActionUpdate,
} from "./tool-actions.js";
import type { TranscriptTone, TuiTranscript } from "./tui-contract.js";

export interface TranscriptEntry {
  id: number;
  text: string;
  tone: TranscriptTone;
  fileDiff?: FileDiff;
  sideOperationId?: string;
  chatCard?: OwnedChatCard;
  toolAction?: ToolAction;
  /** A standalone invocation remains a grouping boundary even before its card arrives. */
  toolBoundary?: string;
}

export interface TuiViewState {
  uiContributions?: readonly import("../extensions/ui-types.js").OwnedUiContribution[];
  extensionView?: import("./extension-ui.js").ExtensionDetailsState;
  backgroundTasks?: readonly BackgroundTask[];
  backgroundPanel?: boolean;
  backgroundList?: {
    selected?: string;
    filter: "all" | "active" | "terminal";
    childId?: string;
    search: string;
  };
  backgroundView?: {
    visible: boolean;
    id: string;
    section: "output" | "info" | "result";
    page?: BackgroundOutputPage;
    follow: boolean;
    loading?: boolean;
    notice?: string;
    search?: string;
    pausedAtLine?: number;
    horizontal?: number;
    searchOutput?: string;
    searchingOutput?: boolean;
  };
  children?: readonly SubagentDescriptor[];
  childSpend?: ModelSpend;
  agentTree?: {
    view: "agents" | "context" | "menu";
    manual: boolean;
    selected?: string;
    collapsed: boolean;
    temporary: boolean;
  };
  agentView?: {
    visible: boolean;
    id: string;
    section: "history" | "changes" | "result";
    history?: string;
    diffs?: FileDiff[];
    notice?: string;
    loading?: boolean;
  };
  sideQueries?: readonly SideQueryRecord[];
  sidePending?: boolean;
  sideNotice?: string;
  sideView?: {
    visible: boolean;
    selected?: string;
    draft: string;
    editing: boolean;
  };
  sideSpend?: ModelSpend;
  agentMode: AgentMode;
  runningMode?: AgentMode;
  approvalMode: ApprovalMode;
  runningApprovalMode?: ApprovalMode;
  modelSelection?: ModelSelection;
  modelCapabilities?: ModelCapabilities;
  contextSnapshot?: ContextSnapshot;
  sessionId?: string;
  sessionTitle?: string;
  worktree?: Session["worktree"];
  projectPath: string;
  commandFeedback?: { id: number; entries: readonly TranscriptEntry[] };
  transcript: readonly TranscriptEntry[];
  streaming: string;
  toolActivity?: string;
  compaction?: { id: string };
  draft: string;
  focus: "composer" | "transcript" | "sidebar" | "modal";
  overlay?: string;
  busy?: boolean;
  awaitingApproval?: boolean;
  requestStartedAt?: number;
  requestActivity?: RequestActivity;
  gitChanges?: GitWorkingState;
  usage?: {
    provider: Session["providerId"];
    profileId?: string;
    model: string;
    totalTokens: TokenUsage;
    totalCost?: number;
    contextSnapshot?: ContextSnapshot;
  };
}

/** The agent writes to this boundary; either terminal renderer may subscribe. */
export class TuiController implements TuiTranscript {
  uiBinding?: import("./extension-ui.js").ExtensionUiBinding;
  readonly uiPresentation = new Map<
    string,
    { selected?: string; cursor?: string; search?: string; scroll?: number }
  >();
  readonly uiFormDrafts = new Map<
    string,
    { value: string; source: string; cursor: number }
  >();
  readonly uiCollapsedPanes = new Set<string>();
  setUiContributions(items: TuiViewState["uiContributions"]): void {
    this.update({ uiContributions: items });
  }
  setExtensionView(extensionView?: TuiViewState["extensionView"]): void {
    this.update({ extensionView });
  }
  setExtensionNotice(notice: string): void {
    if (this.state.extensionView)
      this.update({ extensionView: { ...this.state.extensionView, notice } });
  }
  backgroundControls?: BackgroundControls;
  private backgroundWait?: AbortController;
  readonly backgroundPresentation = {
    unread: new Set<string>(),
    scroll: new Map<string, number>(),
    returnFocus: "composer" as TuiViewState["focus"],
    cursor: new Map<string, number>(),
    sections: new Map<string, "output" | "info" | "result">(),
    follow: new Map<string, boolean>(),
    pausedLine: new Map<string, number>(),
    horizontal: new Map<string, number>(),
  };
  subagentControls?: SubagentControls;
  readonly agentPresentation = {
    scroll: new Map<string, number>(),
    treeScroll: 0,
    returnFocus: "composer" as TuiViewState["focus"],
  };
  readonly sidebarPresentation = {
    menuIndex: 0,
    menuKey: undefined as string | undefined,
    scroll: new Map<string, number>(),
  };
  readonly conversationId = randomUUID();
  readonly conversation = new ConversationSourceBridge();
  private lifetime = new AbortController();
  private usageSession?: Session;
  get ownerSignal(): AbortSignal {
    return this.lifetime.signal;
  }
  readonly sidePresentation = {
    scroll: new Map<string, number>(),
    unread: new Set<string>(),
    draftCursor: 0,
    draftSelection: undefined as { start: number; end: number } | undefined,
  };
  readonly presentation = {
    actions: createActionPresentation(),
    history: createEditorState(),
    windowEnd: undefined as number | undefined,
    expanded: false,
    expandedDiffIds: new Set<number>(),
    scrollTop: undefined as number | undefined,
  };
  private renderer?: TuiTranscript;
  private listeners = new Set<(state: TuiViewState) => void>();
  private serial = 0;
  private readonly activity = new RequestActivityTracker();
  private generation = 0;
  private compactionNotices = new Set<string>();
  private gitSource = new GitChangesSource();
  private state: TuiViewState;

  constructor(
    projectPath: string,
    agentMode: AgentMode = DEFAULT_AGENT_MODE,
    approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE,
    private readonly now: () => number = () => performance.now(),
    private readonly feedbackMode: "transcript" | "dialog" = "transcript",
  ) {
    this.state = {
      agentMode,
      approvalMode,
      projectPath,
      transcript: [],
      streaming: "",
      draft: "",
      focus: "composer",
    };
  }

  get snapshot(): TuiViewState {
    return this.state;
  }

  subscribe(listener: (state: TuiViewState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  bind(renderer?: TuiTranscript, replay = true): void {
    this.renderer = renderer;
    if (renderer && replay && this.state.transcript.length > 0) {
      const entries = this.state.transcript.map(
        ({ text, tone, fileDiff, chatCard }) => ({
          text,
          tone,
          fileDiff,
          chatCard,
        }),
      );
      if (renderer.replace) renderer.replace(entries);
      else {
        renderer.clear();
        for (const entry of entries)
          renderer.append(entry.text, entry.tone, entry.fileDiff);
      }
      if (this.state.streaming) renderer.appendToLast(this.state.streaming);
      renderer.setToolActivity(this.state.toolActivity);
    }
  }

  append(
    text: string,
    tone: TranscriptTone = "assistant",
    fileDiff?: FileDiff,
  ): void {
    if (this.feedbackMode === "dialog") {
      this.appendCommandFeedback(text, tone, fileDiff);
      return;
    }
    this.update({
      transcript: [
        ...this.withStreaming(),
        { id: this.serial++, text, tone, fileDiff },
      ],
      streaming: "",
    });
    this.renderer?.append(text, tone, fileDiff);
  }

  private appendCommandFeedback(
    text: string,
    tone: TranscriptTone,
    fileDiff?: FileDiff,
  ): void {
    // Successful local actions already update their UI; home keeps no success log.
    if (tone !== "error" && tone !== "warn") return;
    const entry = { id: this.serial++, text, tone, fileDiff };
    this.update({
      commandFeedback: {
        id: entry.id,
        entries: [...(this.state.commandFeedback?.entries ?? []), entry],
      },
    });
  }

  dismissCommandFeedback(id: number): void {
    if (this.state.commandFeedback?.id !== id) return;
    this.update({ commandFeedback: undefined });
  }

  appendNotice(text: string, tone: TranscriptTone = "info"): void {
    if (this.feedbackMode === "dialog") {
      this.appendCommandFeedback(text, tone);
      return;
    }
    this.update({
      transcript: [...this.state.transcript, { id: this.serial++, text, tone }],
    });
  }

  upsertToolAction(update: ToolActionUpdate): boolean {
    const index = this.state.transcript.findIndex(
      (entry) =>
        entry.toolAction?.id === update.id || entry.toolBoundary === update.id,
    );
    if (actionIsSeparate(update.name, update.result)) {
      const transcript =
        index >= 0 ? [...this.state.transcript] : [...this.withStreaming()];
      const boundary: TranscriptEntry = {
        id: this.state.transcript[index]?.id ?? this.serial++,
        text: "",
        tone: "tool",
        toolBoundary: update.id,
      };
      if (index >= 0) transcript[index] = boundary;
      else transcript.push(boundary);
      preserveActionExpansion(
        this.presentation.actions,
        this.state.transcript,
        transcript,
      );
      this.update({ transcript, ...(index >= 0 ? {} : { streaming: "" }) });
      return false;
    }
    const previous = this.state.transcript[index];
    const toolAction = mergeToolAction(previous?.toolAction, update);
    const transcript = previous
      ? [...this.state.transcript]
      : [...this.withStreaming()];
    const entry: TranscriptEntry = {
      id: previous?.id ?? this.serial++,
      text: actionLabel(toolAction),
      tone: "tool",
      toolAction,
    };
    if (previous) transcript[index] = entry;
    else transcript.push(entry);
    preserveActionExpansion(
      this.presentation.actions,
      this.state.transcript,
      transcript,
    );
    this.update({ transcript, ...(previous ? {} : { streaming: "" }) });
    return true;
  }
  refreshActionPresentation(): void {
    this.update({});
  }
  activateAction(target: ActionTarget): void {
    const generation = this.currentGeneration;
    const sessionId = this.state.sessionId;
    void activateActionTarget(
      this.presentation.actions,
      target,
      () => {
        if (this.isCurrent(generation)) this.update({});
      },
      async (action, offset) => {
        if (
          !sessionId ||
          !this.isCurrent(generation) ||
          !this.state.transcript.some(
            (entry) =>
              entry.toolAction?.id === action.id &&
              entry.toolAction.result?.artifact?.uri ===
                action.result?.artifact?.uri,
          )
        )
          throw new Error("Результат не принадлежит открытому разговору.");
        if (!action.result?.artifact) return action.result?.output ?? "";
        return new ToolResultStore(
          join(sessionsRootDir(), "artifacts", sessionId),
        ).read(action.result.artifact.uri, offset, 100);
      },
      this.ownerSignal,
    );
  }

  trackToolEvent(event: import("../runtime/events.js").RuntimeEvent): void {
    if (this.state.requestStartedAt !== undefined) {
      const next = this.activity.accept(event);
      const prior = this.state.requestActivity;
      if (next.kind !== prior?.kind || next.label !== prior.label)
        this.update({ requestActivity: next });
    }
    if (event.type === "extension_notice" && event.text)
      this.appendNotice(event.text, "error");
    if (!event.invocationId || !event.name) return;
    const state =
      event.type === "tool_queued"
        ? "queued"
        : event.type === "tool_approval_requested"
          ? "awaiting_approval"
          : undefined;
    if (state || event.type === "tool_progress")
      this.upsertToolAction({
        id: event.invocationId,
        name: event.name,
        ...(event.input ? { input: event.input } : {}),
        ...(event.toolSource ? { source: event.toolSource } : {}),
        ...(state ? { state } : {}),
        ...(event.text ? { progress: event.text } : {}),
      });
  }

  /** Progress updates the original task card without committing the main stream. */
  upsertCard(extensionId: string, card: ChatCard): void {
    if (this.ownerSignal.aborted) return;
    const index = this.state.transcript.findIndex(
      (entry) =>
        entry.chatCard?.extensionId === extensionId &&
        entry.chatCard.card.id === card.id,
    );
    const prior = this.state.transcript[index];
    if (prior?.chatCard && prior.chatCard.card.revision >= card.revision)
      return;
    const chatCard = structuredClone({ extensionId, card });
    const entry: TranscriptEntry = {
      id: prior?.id ?? this.serial++,
      text: chatCardText(chatCard.card),
      tone: "tool",
      chatCard,
    };
    const transcript = [...this.state.transcript];
    if (index >= 0) transcript[index] = entry;
    else transcript.push(entry);
    this.update({ transcript });
    if (this.renderer?.upsertCard)
      this.renderer.upsertCard(extensionId, chatCard.card);
    else if (!prior) this.renderer?.append(entry.text, entry.tone);
  }

  appendToLast(text: string): void {
    this.update({ streaming: this.state.streaming + text });
    this.renderer?.appendToLast(text);
  }

  /** A rejected provider response is regenerated; its partial text is not an answer. */
  discardStreaming(): void {
    this.update({ streaming: "", toolActivity: undefined });
  }

  beginCompaction(id: string): void {
    this.update({
      compaction: { id },
      transcript: this.withStreaming(),
      streaming: "",
      toolActivity: undefined,
    });
  }

  finishCompaction(record: ContextCompactionRecord): void {
    if (this.state.compaction?.id === record.id)
      this.update({ compaction: undefined });
    if (this.compactionNotices.has(record.id)) return;
    this.compactionNotices.add(record.id);
    this.append(compactionNotice(record), "context");
  }

  abortCompaction(id: string): void {
    if (this.state.compaction?.id === id)
      this.update({ compaction: undefined });
  }

  setToolActivity(text?: string): void {
    this.update({
      toolActivity: text,
      transcript: text ? this.withStreaming() : this.state.transcript,
      streaming: text ? "" : this.state.streaming,
    });
    this.renderer?.setToolActivity(text);
  }

  replace(
    entries: Array<{
      text: string;
      tone?: TranscriptTone;
      fileDiff?: FileDiff;
      chatCard?: OwnedChatCard;
      toolAction?: ToolAction;
      toolBoundary?: string;
    }>,
  ): void {
    this.update({
      transcript: entries.map((entry) => ({
        ...entry,
        tone: entry.tone ?? "assistant",
        id: this.serial++,
      })),
      streaming: "",
      toolActivity: undefined,
      compaction: undefined,
    });
    if (this.renderer?.replace) this.renderer.replace(entries);
    else if (this.renderer) {
      this.renderer.clear();
      for (const entry of entries)
        this.renderer.append(entry.text, entry.tone, entry.fileDiff);
    }
  }

  clear(): void {
    this.presentation.actions = createActionPresentation();
    this.compactionNotices.clear();
    this.update({
      commandFeedback: undefined,
      transcript: [],
      streaming: "",
      toolActivity: undefined,
      compaction: undefined,
    });
    this.renderer?.clear();
  }

  setDraft(draft: string): void {
    this.update({ draft });
  }
  setSessionTitle(title: string): void {
    this.update({ sessionTitle: title });
  }
  setSessionId(sessionId: string): void {
    if (!this.state.sessionId) this.update({ sessionId });
  }
  setFocus(focus: TuiViewState["focus"]): void {
    this.update({ focus });
  }
  setOverlay(overlay?: string): void {
    this.update({ overlay });
  }
  setBusy(busy: boolean): void {
    this.update({ busy });
  }
  setAwaitingApproval(awaitingApproval: boolean): void {
    this.update({ awaitingApproval });
  }

  /** A queued prompt starts counting only when it actually begins execution. */
  startRequest(initial: "thinking" | "tool" = "thinking"): void {
    this.update({
      busy: true,
      requestStartedAt: this.now(),
      requestActivity: this.activity.reset(initial),
      toolActivity: undefined,
      compaction: undefined,
    });
  }

  stopRequestActivity(): void {
    if (this.state.requestStartedAt !== undefined)
      this.update({ requestActivity: this.activity.stop() });
  }

  get requestElapsedMs(): number {
    return this.state.requestStartedAt === undefined
      ? 0
      : Math.max(0, this.now() - this.state.requestStartedAt);
  }

  finishRequest(
    status: AgentResult["status"],
    elapsedMs = this.requestElapsedMs,
  ): void {
    if (this.state.requestStartedAt === undefined) return;
    const text = requestCompletion(status, elapsedMs);
    const transcript = this.withStreaming().map((entry) =>
      entry.toolAction &&
      actionRunning(entry.toolAction) &&
      entry.toolAction.state !== "awaiting_approval"
        ? {
            ...entry,
            toolAction: {
              ...entry.toolAction,
              state:
                status === "cancelled"
                  ? ("cancelled" as const)
                  : ("interrupted" as const),
            },
          }
        : entry,
    );
    this.update({
      transcript: [...transcript, { id: this.serial++, text, tone: "dim" }],
      streaming: "",
      toolActivity: undefined,
      requestStartedAt: undefined,
      requestActivity: undefined,
      compaction: undefined,
    });
    this.renderer?.setToolActivity();
    this.renderer?.append(text, "dim");
  }
  setAgentMode(agentMode: AgentMode): void {
    this.update({ agentMode });
  }
  setRunningMode(runningMode?: AgentMode): void {
    this.update({ runningMode });
  }
  setApprovalMode(approvalMode: ApprovalMode): void {
    this.update({ approvalMode });
  }
  setRunningApprovalMode(runningApprovalMode?: ApprovalMode): void {
    this.update({ runningApprovalMode });
  }

  setSessionUsage(session: Session, requestSelection?: ModelSelection): void {
    if (resolve(session.projectPath) !== resolve(this.state.projectPath))
      return;
    if (this.state.sessionId && this.state.sessionId !== session.id) return;
    session = structuredClone(session);
    const merged = new Map(
      (session.sideQueries ?? []).map((record) => [record.operationId, record]),
    );
    for (const record of this.state.sideQueries ?? []) {
      const prior = merged.get(record.operationId);
      if (
        !prior ||
        prior.revision < record.revision ||
        (prior.revision === record.revision &&
          isModelRequestActive(prior.status))
      )
        merged.set(record.operationId, structuredClone(record));
    }
    session.sideQueries = [...merged.values()];
    session.children = { ...session.children };
    for (const child of this.state.children ?? []) {
      const prior = session.children[child.id];
      if (!prior || prior.revision <= child.revision)
        session.children[child.id] = {
          revision: child.revision,
          child: structuredClone(child),
          spend: structuredClone(child.spend),
          ...(prior?.revision === child.revision && prior.presentation
            ? { presentation: structuredClone(prior.presentation) }
            : {}),
        };
    }
    session.sideQuerySpend = { ...session.sideQuerySpend };
    for (const record of session.sideQueries)
      session.sideQuerySpend[record.operationId] = spendForRecord(record);
    recomputeSessionSpend(session);
    this.usageSession = session;
    this.restoreSideRecords(session.sideQueries);
    for (const record of session.context?.compactions ?? [])
      this.compactionNotices.add(record.id);
    const selected = this.state.modelSelection ?? {
      provider: session.providerId,
      profileId: session.profileId,
      model: session.model,
    };
    this.update({
      sessionId: session.id,
      sessionTitle: session.title,
      worktree: session.worktree,
      modelSelection: selected,
      modelCapabilities: this.state.modelCapabilities ?? {
        tokenCounting: "local_estimate",
        ...catalogModelLimits(selected.provider, selected.model),
      },
      contextSnapshot:
        selected.provider === session.providerId &&
        selected.profileId === session.profileId &&
        selected.model === session.model &&
        (!requestSelection || this.matchesSelection(requestSelection))
          ? session.contextSnapshot
          : this.state.contextSnapshot,
      sideSpend: sideSpend(session),
      childSpend: childSpend(session),
      children: Object.values(session.children ?? {})
        .map((receipt) => receipt.child)
        .sort((a, b) => a.ordinal - b.ordinal),
      usage: {
        provider: selected.provider,
        profileId: selected.profileId,
        model: selected.model,
        totalTokens: { ...session.totalTokens },
        totalCost:
          session.costEstimate?.source === "unknown"
            ? undefined
            : (session.costEstimate?.usd ?? session.totalCost),
        contextSnapshot:
          selected.provider === session.providerId &&
          selected.profileId === session.profileId &&
          selected.model === session.model &&
          session.contextSnapshot?.model === session.model &&
          (!requestSelection || this.matchesSelection(requestSelection))
            ? session.contextSnapshot
            : undefined,
      },
    });
  }

  /** A selected model takes effect on the next request; invalidate old context usage now. */
  setActiveModel(
    provider: Session["providerId"],
    model: string,
    profileId?: string,
    baseUrl?: string,
  ): void {
    const usage = this.state.usage;
    const same = this.matchesSelection({ provider, model, profileId, baseUrl });
    this.update({
      modelSelection: { provider, model, profileId, baseUrl },
      modelCapabilities:
        same && this.state.modelCapabilities
          ? this.state.modelCapabilities
          : {
              tokenCounting: "local_estimate",
              ...catalogModelLimits(provider, model),
            },
      contextSnapshot: same ? this.state.contextSnapshot : undefined,
      usage: usage
        ? {
            ...usage,
            provider,
            profileId,
            model,
            contextSnapshot:
              usage.provider === provider &&
              usage.model === model &&
              usage.profileId === profileId &&
              this.state.modelSelection?.baseUrl === baseUrl
                ? usage.contextSnapshot
                : undefined,
          }
        : undefined,
    });
  }

  setModelCapabilities(
    selection: ModelSelection,
    capabilities: ModelCapabilities,
  ): void {
    if (this.matchesSelection(selection))
      this.update({ modelCapabilities: capabilities });
  }
  setContextSnapshot(
    selection: ModelSelection,
    snapshot: ContextSnapshot,
  ): void {
    if (this.matchesSelection(selection) && snapshot.model === selection.model)
      this.update({ contextSnapshot: snapshot });
  }
  private matchesSelection(selection: ModelSelection): boolean {
    const current = this.state.modelSelection;
    return (
      current?.provider === selection.provider &&
      current.model === selection.model &&
      current.profileId === selection.profileId &&
      current.baseUrl === selection.baseUrl
    );
  }

  refreshGitChanges(): void {
    const generation = this.generation;
    this.gitSource.refresh(this.state.projectPath, (gitChanges) => {
      if (this.isCurrent(generation)) this.update({ gitChanges });
    });
  }

  /** Invalidates responses from the previous project or session immediately. */
  switchSession(
    session?: Pick<Session, "id" | "projectPath"> &
      Partial<Pick<Session, "title" | "mode" | "approvalMode" | "worktree">>,
    projectPath = session?.projectPath ?? this.state.projectPath,
  ): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.conversation.dispose();
    this.usageSession = undefined;
    this.sidePresentation.scroll.clear();
    this.sidePresentation.unread.clear();
    this.subagentControls = undefined;
    this.backgroundControls = undefined;
    this.backgroundPresentation.unread.clear();
    this.backgroundPresentation.scroll.clear();
    this.agentPresentation.scroll.clear();
    this.sidebarPresentation.scroll.clear();
    this.sidebarPresentation.menuIndex = 0;
    this.sidebarPresentation.menuKey = undefined;
    this.uiPresentation.clear();
    this.uiFormDrafts.clear();
    this.uiCollapsedPanes.clear();
    this.presentation.actions = createActionPresentation();
    this.generation++;
    this.compactionNotices.clear();
    this.presentation.windowEnd = undefined;
    this.presentation.expanded = false;
    this.presentation.expandedDiffIds.clear();
    this.presentation.scrollTop = undefined;
    this.gitSource.dispose();
    this.state = {
      agentMode: session
        ? (session.mode ?? DEFAULT_AGENT_MODE)
        : this.state.agentMode,
      approvalMode: session
        ? (session.approvalMode ?? DEFAULT_APPROVAL_MODE)
        : this.state.approvalMode,
      modelSelection: session ? undefined : this.state.modelSelection,
      projectPath,
      sessionId: session?.id,
      sessionTitle: session?.title,
      worktree: session?.worktree,
      transcript: [],
      streaming: "",
      draft: "",
      focus: "composer",
    };
    if (session && "messages" in session)
      this.conversation.restore(session as Session);
    this.renderer?.clear();
    this.notify();
    this.refreshGitChanges();
  }

  setBackgroundControls(controls: BackgroundControls): void {
    this.backgroundControls = controls;
    const generation = this.currentGeneration;
    void controls
      .list()
      .then((tasks) => {
        if (this.isCurrent(generation)) this.update({ backgroundTasks: tasks });
      })
      .catch(() => {});
  }
  acceptBackground(event: BackgroundEvent): void {
    if (
      this.ownerSignal.aborted ||
      (this.state.sessionId && event.ownerId !== this.state.sessionId)
    )
      return;
    const tasks = new Map(
      (this.state.backgroundTasks ?? []).map((task) => [task.id, task]),
    );
    if ((tasks.get(event.task.id)?.revision ?? -1) >= event.task.revision)
      return;
    tasks.set(event.task.id, event.task);
    if (event.task.outputExpired)
      this.backgroundPresentation.unread.delete(event.task.id);
    if (
      event.type === "terminal" &&
      [
        "failed",
        "cleanup_unknown",
        "lost",
        "interrupted",
        "output_limit",
        "timed_out",
        "denied",
        "start_failed",
      ].includes(event.task.state) &&
      !event.task.foreground
    )
      this.backgroundPresentation.unread.add(event.task.id);
    this.update({
      backgroundTasks: [...tasks.values()].sort(
        (a, b) => a.ordinal - b.ordinal,
      ),
    });
    if (event.presentation?.extensionId === "builtin.background") {
      if (event.task.foreground) {
        const card = event.presentation.view.cards?.[0];
        if (card)
          this.upsertToolAction({
            id: event.task.invocationId,
            name: "run_shell",
            foreground: { extensionId: "builtin.background", card },
          });
      } else {
        const transcript = this.state.transcript.map((entry) =>
          entry.toolAction?.id === event.task.invocationId
            ? {
                id: entry.id,
                text: "",
                tone: "tool" as const,
                toolBoundary: event.task.invocationId,
              }
            : entry,
        );
        if (
          transcript.some(
            (entry, index) => entry !== this.state.transcript[index],
          )
        ) {
          preserveActionExpansion(
            this.presentation.actions,
            this.state.transcript,
            transcript,
          );
          this.update({ transcript });
        }
        appendChatPresentation(this, event.presentation);
      }
    }
    const viewer = this.state.backgroundView;
    if (
      viewer?.visible &&
      viewer.id === event.task.id &&
      viewer.follow &&
      !viewer.loading
    )
      void this.loadBackground(event.task.id, true);
  }
  showBackground(childId?: string): void {
    this.backgroundPresentation.returnFocus = this.state.focus;
    this.hideAgent();
    this.hideSide();
    this.update({
      backgroundPanel: true,
      backgroundList: {
        ...(this.state.backgroundList ?? { filter: "all", search: "" }),
        childId,
      },
      focus: "modal",
    });
  }
  hideBackgroundPanel(): void {
    this.update({
      backgroundPanel: false,
      focus: this.backgroundPresentation.returnFocus,
    });
  }
  setBackgroundList(
    fields: Partial<NonNullable<TuiViewState["backgroundList"]>>,
  ): void {
    this.update({
      backgroundList: {
        filter: "all",
        search: "",
        ...this.state.backgroundList,
        ...fields,
      },
    });
  }
  async openBackground(id: string): Promise<void> {
    const generation = this.currentGeneration;
    const controls = this.backgroundControls;
    if (!controls) return;
    try {
      const task = await controls.port.status(id);
      if (!this.isCurrent(generation) || this.backgroundControls !== controls)
        return;
      this.acceptBackground({
        type: "changed",
        ownerId: task.rootOwnerId,
        task,
      });
    } catch (error) {
      if (this.isCurrent(generation)) this.append(String(error), "error");
      return;
    }
    if (!this.isCurrent(generation) || this.backgroundControls !== controls)
      return;
    if (!this.state.backgroundPanel)
      this.backgroundPresentation.returnFocus = this.state.focus;
    this.backgroundPresentation.unread.delete(id);
    this.setBackgroundList({ selected: id });
    this.hideAgent();
    this.hideSide();
    this.update({
      backgroundView: {
        id,
        visible: true,
        section: this.backgroundPresentation.sections.get(id) ?? "output",
        follow: this.backgroundPresentation.follow.get(id) ?? true,
        pausedAtLine: this.backgroundPresentation.pausedLine.get(id),
        horizontal:
          this.backgroundPresentation.horizontal.get(
            `${id}:${this.backgroundPresentation.sections.get(id) ?? "output"}`,
          ) ?? 0,
      },
      focus: "modal",
    });
    await this.loadBackground(id, this.state.backgroundView!.follow);
  }
  hideBackground(): void {
    this.backgroundWait?.abort();
    if (this.state.backgroundView)
      this.update({
        backgroundView: { ...this.state.backgroundView, visible: false },
        focus: this.state.backgroundPanel
          ? "modal"
          : this.backgroundPresentation.returnFocus,
      });
  }
  setBackgroundView(
    fields: Partial<NonNullable<TuiViewState["backgroundView"]>>,
  ): void {
    const prior = this.state.backgroundView;
    if (!prior) return;
    if (fields.follow !== undefined)
      this.backgroundPresentation.follow.set(prior.id, fields.follow);
    if (
      fields.follow === false &&
      (prior.follow || prior.pausedAtLine === undefined)
    ) {
      fields.pausedAtLine =
        this.state.backgroundTasks?.find((task) => task.id === prior.id)
          ?.outputLines ?? 0;
      this.backgroundPresentation.pausedLine.set(prior.id, fields.pausedAtLine);
    }
    if (fields.follow === true) {
      fields.search = "";
      fields.searchOutput = undefined;
    }
    if (fields.section)
      this.backgroundPresentation.sections.set(prior.id, fields.section);
    if (fields.section && fields.horizontal === undefined)
      fields.horizontal =
        this.backgroundPresentation.horizontal.get(
          `${prior.id}:${fields.section}`,
        ) ?? 0;
    if (fields.horizontal !== undefined)
      this.backgroundPresentation.horizontal.set(
        `${prior.id}:${fields.section ?? prior.section}`,
        fields.horizontal,
      );
    this.update({ backgroundView: { ...prior, ...fields } });
  }
  async loadBackground(
    id: string,
    tail: boolean,
    cursor?: number,
  ): Promise<void> {
    const generation = this.currentGeneration;
    const controls = this.backgroundControls;
    if (
      !controls ||
      this.state.backgroundView?.id !== id ||
      this.state.backgroundView.loading
    )
      return;
    this.setBackgroundView({ loading: true });
    try {
      const task = await controls.port.status(id);
      const start =
        cursor ??
        (tail
          ? Math.max(0, task.outputBytes - 32768)
          : (this.backgroundPresentation.cursor.get(id) ?? 0));
      const page = await controls.port.readOutput(
        id,
        start,
        32768,
        task.outputGeneration,
      );
      const lines = page.text.split("\n");
      if (lines.length > 512) {
        if (tail) {
          const text = lines.slice(-512).join("\n");
          page.cursor += Buffer.byteLength(page.text) - Buffer.byteLength(text);
          page.text = text;
        } else {
          page.text = `${lines.slice(0, 511).join("\n")}\n`;
          page.next = page.cursor + Buffer.byteLength(page.text);
          page.eof = page.next >= page.end;
        }
      }
      if (this.isCurrent(generation) && this.state.backgroundView?.id === id) {
        this.backgroundPresentation.cursor.set(id, page.cursor);
        this.setBackgroundView({
          page,
          loading: false,
          notice: page.expired ? "Вывод больше не сохранён." : undefined,
        });
      }
    } catch (error) {
      if (this.isCurrent(generation) && this.state.backgroundView?.id === id)
        this.setBackgroundView({ loading: false, notice: String(error) });
    }
  }
  async searchBackground(id: string, query: string): Promise<void> {
    const controls = this.backgroundControls;
    const generation = this.currentGeneration;
    if (!controls || this.state.backgroundView?.id !== id) return;
    this.setBackgroundView({
      search: query,
      follow: false,
      searchOutput: undefined,
      searchingOutput: !!query,
    });
    if (!query) return;
    const current = () =>
      this.isCurrent(generation) &&
      this.backgroundControls === controls &&
      this.state.backgroundView?.visible &&
      this.state.backgroundView.id === id &&
      this.state.backgroundView.search === query;
    try {
      const task = await controls.port.status(id);
      const matches: string[] = [];
      let cursor = 0,
        carry = "",
        bytes = 0,
        rows = 0;
      const needle = query.toLowerCase();
      while (
        cursor < task.outputBytes &&
        current() &&
        matches.length < 512 &&
        bytes < 32768
      ) {
        const page = await controls.port.readOutput(
          id,
          cursor,
          32768,
          task.outputGeneration,
        );
        if (page.expired || page.next <= cursor) break;
        const parts = (carry + page.text).split("\n");
        carry = (parts.pop() ?? "").slice(-4096);
        if (page.next >= task.outputBytes && carry) {
          parts.push(carry);
          carry = "";
        }
        for (const line of parts) {
          rows++;
          const at = line.toLowerCase().indexOf(needle);
          if (at < 0) continue;
          const match = `${rows}: ${line.slice(Math.max(0, at - 80), at + 500)}\n`;
          if (bytes + Buffer.byteLength(match) > 32768 || matches.length >= 512)
            break;
          matches.push(match);
          bytes += Buffer.byteLength(match);
        }
        cursor = page.next;
      }
      if (current())
        this.setBackgroundView({
          searchingOutput: false,
          searchOutput: matches.join("") || "Совпадений не найдено",
          notice: `Поиск в сохранённом выводе: ${matches.length} строк${cursor < task.outputBytes ? " · достигнут лимит результатов" : ""}`,
        });
    } catch (error) {
      if (current())
        this.setBackgroundView({
          searchingOutput: false,
          notice: String(error),
        });
    }
  }
  async stopBackgroundSet(ids: readonly string[]): Promise<void> {
    const controls = this.backgroundControls;
    const generation = this.currentGeneration;
    if (!controls) return;
    for (const id of ids) {
      if (!this.isCurrent(generation) || this.backgroundControls !== controls)
        return;
      await this.stopBackground(id);
    }
  }
  async stopBackground(id: string): Promise<void> {
    const generation = this.currentGeneration;
    const controls = this.backgroundControls;
    try {
      await controls?.port.stop(id);
    } catch (error) {
      if (this.isCurrent(generation))
        this.setBackgroundView({ notice: String(error) });
    }
  }
  async waitBackground(id: string): Promise<void> {
    const controls = this.backgroundControls;
    const generation = this.currentGeneration;
    if (!controls) return;
    await this.openBackground(id);
    if (!this.isCurrent(generation)) return;
    this.backgroundWait?.abort();
    const wait = new AbortController();
    this.backgroundWait = wait;
    this.setBackgroundView({ notice: "Ожидание результата до 30 секунд…" });
    try {
      const [task] = await controls.port.wait(
        [id],
        30000,
        AbortSignal.any([this.ownerSignal, wait.signal]),
      );
      if (this.isCurrent(generation) && this.state.backgroundView?.id === id)
        this.setBackgroundView({
          notice: task ? `${task.label}: ${task.state}` : "Ожидание завершено",
        });
    } catch (error) {
      if (this.isCurrent(generation) && this.state.backgroundView?.id === id)
        this.setBackgroundView({ notice: String(error) });
    } finally {
      if (this.backgroundWait === wait) this.backgroundWait = undefined;
    }
  }
  async promoteBackground(id: string): Promise<void> {
    const generation = this.currentGeneration;
    const controls = this.backgroundControls;
    try {
      await controls?.promote(id);
    } catch (error) {
      if (this.isCurrent(generation)) this.append(String(error), "error");
    }
  }
  async deleteBackgroundHistory(id: string): Promise<void> {
    const generation = this.currentGeneration;
    const controls = this.backgroundControls;
    if (!controls) return;
    try {
      const task = await controls.port.deleteHistory(id);
      if (!this.isCurrent(generation) || this.backgroundControls !== controls)
        return;
      this.acceptBackground({
        type: "changed",
        ownerId: task.rootOwnerId,
        task,
      });
      if (this.state.backgroundView?.id === id)
        this.setBackgroundView({
          page: undefined,
          notice: "Сохранённые логи удалены. Повторного запуска нет.",
        });
    } catch (error) {
      if (this.isCurrent(generation))
        this.setBackgroundView({ notice: String(error) });
    }
  }
  async recoverBackground(id: string): Promise<void> {
    const generation = this.currentGeneration;
    const controls = this.backgroundControls;
    if (!controls) return;
    try {
      const task = await controls.port.recover(id);
      if (!this.isCurrent(generation) || this.backgroundControls !== controls)
        return;
      this.acceptBackground({
        type: "changed",
        ownerId: task.rootOwnerId,
        task,
      });
      if (this.state.backgroundView?.id === id)
        this.setBackgroundView({
          notice:
            "Завершение подтверждено исходным backend. Ресурсы освобождены.",
        });
    } catch (error) {
      if (this.isCurrent(generation) && this.state.backgroundView?.id === id)
        this.setBackgroundView({ notice: String(error) });
    }
  }
  setSidePending(pending: boolean): void {
    this.update({ sidePending: pending });
  }
  setSubagentControls(controls: SubagentControls): void {
    this.subagentControls = controls;
    this.update({});
  }
  acceptSubagent(event: SubagentEvent): void {
    if (
      this.ownerSignal.aborted ||
      (this.state.sessionId && event.ownerId !== this.state.sessionId)
    )
      return;
    const records = new Map(
      (this.state.children ?? []).map((child) => [child.id, child]),
    );
    const prior = records.get(event.child.id);
    if (prior && prior.revision > event.child.revision) return;
    records.set(event.child.id, structuredClone(event.child));
    const children = [...records.values()].sort(
      (a, b) => a.ordinal - b.ordinal,
    );
    const tree = this.state.agentTree ?? {
      view: "context" as const,
      manual: false,
      collapsed: false,
      temporary: false,
    };
    this.update({
      children,
      childSpend: aggregateSpend(children.map((child) => child.spend)),
      agentTree: tree.manual ? tree : { ...tree, view: "agents" },
    });
    if (this.usageSession) {
      this.usageSession.children ??= {};
      this.usageSession.children[event.child.id] = {
        revision: event.child.revision,
        child: structuredClone(event.child),
        spend: structuredClone(event.child.spend),
        ...(event.presentation
          ? { presentation: structuredClone(event.presentation) }
          : {}),
      };
      recomputeSessionSpend(this.usageSession);
      if (this.state.usage)
        this.update({
          usage: {
            ...this.state.usage,
            totalTokens: { ...this.usageSession.totalTokens },
            totalCost:
              this.usageSession.costEstimate?.source === "unknown"
                ? undefined
                : this.usageSession.totalCost,
          },
        });
    }
    if (
      event.presentation &&
      event.presentation.extensionId === event.child.extensionId
    )
      appendChatPresentation(this, event.presentation);
  }
  setAgentSidebar(
    view: "agents" | "context" | "menu",
    temporary = false,
  ): void {
    this.update({
      agentTree: {
        ...(this.state.agentTree ?? {
          collapsed: false,
          manual: false,
          temporary: false,
        }),
        view,
        manual: true,
        temporary,
      },
    });
  }
  selectAgent(id?: string): void {
    this.update({
      agentTree: {
        ...(this.state.agentTree ?? {
          view: "agents",
          manual: false,
          collapsed: false,
          temporary: false,
        }),
        selected: id,
      },
    });
  }
  collapseAgents(collapsed: boolean): void {
    this.update({
      agentTree: {
        ...(this.state.agentTree ?? {
          view: "agents",
          manual: false,
          temporary: false,
        }),
        collapsed,
        selected: collapsed ? undefined : this.state.agentTree?.selected,
      },
    });
  }
  openAgent(id: string): void {
    if (!this.state.children?.some((child) => child.id === id)) return;
    this.agentPresentation.returnFocus = this.state.focus;
    this.selectAgent(id);
    this.hideSide();
    this.update({
      agentView: {
        ...(this.state.agentView?.id === id ? this.state.agentView : {}),
        id,
        visible: true,
        section:
          this.state.agentView?.id === id
            ? this.state.agentView.section
            : "history",
      },
      focus: "modal",
    });
  }
  hideAgent(): void {
    if (this.state.agentView?.visible)
      this.update({
        agentView: { ...this.state.agentView, visible: false },
        focus: this.agentPresentation.returnFocus,
      });
  }
  setAgentView(fields: Partial<NonNullable<TuiViewState["agentView"]>>): void {
    if (this.state.agentView)
      this.update({ agentView: { ...this.state.agentView, ...fields } });
  }
  setSideNotice(notice?: string): void {
    this.update({ sideNotice: notice });
  }
  setSideDraft(draft: string): void {
    this.update({
      sideView: {
        visible: this.state.sideView?.visible ?? true,
        selected: this.state.sideView?.selected,
        editing: true,
        draft,
      },
    });
  }
  openSide(requestedOperationId?: string): void {
    const operationId =
      requestedOperationId ??
      this.state.sideView?.selected ??
      this.state.sideQueries?.at(-1)?.operationId;
    this.sidePresentation.unread.delete(operationId ?? "");
    this.update({
      sideView: {
        visible: true,
        selected: operationId,
        draft: this.state.sideView?.draft ?? "",
        editing:
          requestedOperationId === undefined &&
          this.state.sideView?.selected === operationId
            ? (this.state.sideView?.editing ??
              (!operationId && !this.state.sidePending))
            : !operationId && !this.state.sidePending,
      },
    });
  }
  hideSide(): void {
    if (this.state.sideView)
      this.update({ sideView: { ...this.state.sideView, visible: false } });
  }
  newSideQuestion(): void {
    this.update({
      sideView: {
        visible: true,
        selected: this.state.sideView?.selected,
        draft: this.state.sideView?.draft ?? "",
        editing: true,
      },
    });
  }
  readSideAnswer(): void {
    if (this.state.sideView)
      this.update({ sideView: { ...this.state.sideView, editing: false } });
  }
  receiveSide(record: Readonly<SideQueryRecord>): void {
    if (
      record.owner.conversationId !== this.conversationId ||
      record.owner.generation !== this.generation
    )
      return;
    const previous = this.state.sideQueries?.find(
      (item) => item.operationId === record.operationId,
    );
    if (
      previous &&
      (previous.revision > record.revision ||
        (!isModelRequestActive(previous.status) &&
          isModelRequestActive(record.status)))
    )
      return;
    const records = [
      ...(this.state.sideQueries ?? []).filter(
        (item) => item.operationId !== record.operationId,
      ),
      structuredClone(record),
    ];
    if (!this.state.sideView?.visible)
      this.sidePresentation.unread.add(record.operationId);
    if (
      previous &&
      !this.state.sideView?.visible &&
      previous.status === record.status &&
      isModelRequestActive(record.status)
    ) {
      this.state = { ...this.state, sideQueries: records };
      return;
    }
    this.update({
      sideQueries: records,
      sideView: this.state.sideView
        ? {
            ...this.state.sideView,
            selected: this.state.sidePending
              ? record.operationId
              : this.state.sideView.selected,
          }
        : undefined,
    });
    this.restoreSideRecords(records);
    if (this.usageSession) {
      this.usageSession.sideQueries = records;
      this.usageSession.sideQuerySpend ??= {};
      this.usageSession.sideQuerySpend[record.operationId] =
        spendForRecord(record);
      recomputeSessionSpend(this.usageSession);
      this.update({
        sideSpend: aggregateSpend(
          Object.values(this.usageSession.sideQuerySpend),
        ),
        usage: this.state.usage
          ? {
              ...this.state.usage,
              totalTokens: { ...this.usageSession.totalTokens },
              totalCost:
                this.usageSession.costEstimate?.source === "unknown"
                  ? undefined
                  : this.usageSession.totalCost,
            }
          : undefined,
      });
    }
  }
  private restoreSideRecords(records: readonly SideQueryRecord[]): void {
    let transcript = this.state.transcript;
    for (const record of records) {
      const text = `Побочный вопрос · ${sideStatus[record.status]}${this.sidePresentation.unread.has(record.operationId) ? " · новое" : ""} · ${record.question.replace(/\s+/g, " ").slice(0, 70)}`;
      const old = transcript.find(
        (entry) => entry.sideOperationId === record.operationId,
      );
      if (old)
        transcript = transcript.map((entry) =>
          entry === old ? { ...entry, text } : entry,
        );
      else
        transcript = [
          ...transcript,
          {
            id: this.serial++,
            text,
            tone: "info",
            sideOperationId: record.operationId,
          },
        ];
    }
    this.update({
      transcript,
      sideQueries: [...records],
      sideSpend: aggregateSpend(records.map(spendForRecord)),
    });
  }

  /** A token for asynchronous sidebar reads; stale results must be discarded. */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
  get currentGeneration(): number {
    return this.generation;
  }

  dispose(): void {
    this.lifetime.abort();
    this.conversation.dispose();
    this.generation++;
    this.gitSource.dispose();
    this.renderer = undefined;
    this.listeners.clear();
    this.uiFormDrafts.clear();
    this.uiCollapsedPanes.clear();
  }

  private update(fields: Partial<TuiViewState>): void {
    this.state = { ...this.state, ...fields };
    this.notify();
  }

  private withStreaming(): readonly TranscriptEntry[] {
    return this.state.streaming
      ? [
          ...this.state.transcript,
          { id: this.serial++, text: this.state.streaming, tone: "assistant" },
        ]
      : this.state.transcript;
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
