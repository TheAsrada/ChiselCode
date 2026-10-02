import { resolve } from "node:path";
import type { ContextCompactionRecord } from "../context/types.js";
import type { ModelCapabilities } from "../providers/capabilities.js";
import { catalogModelLimits } from "../providers/model-metadata.js";
import { type AgentMode, DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import {
  type ApprovalMode,
  DEFAULT_APPROVAL_MODE,
} from "../security/approval-mode.js";
import type {
  AgentResult,
  ContextSnapshot,
  FileDiff,
  Session,
  TokenUsage,
} from "../types/domain.js";
import { compactionNotice } from "./context-compaction.js";
import { createEditorState } from "./editor.js";
import { GitChangesSource, type GitWorkingState } from "./git-changes.js";
import type { ModelSelection } from "./opentui-models.js";
import { requestCompletion } from "./request-timing.js";
import type { TranscriptTone, TuiTranscript } from "./tui-contract.js";

export interface TranscriptEntry {
  id: number;
  text: string;
  tone: TranscriptTone;
  fileDiff?: FileDiff;
}

export interface TuiViewState {
  agentMode: AgentMode;
  runningMode?: AgentMode;
  approvalMode: ApprovalMode;
  runningApprovalMode?: ApprovalMode;
  modelSelection?: ModelSelection;
  modelCapabilities?: ModelCapabilities;
  contextSnapshot?: ContextSnapshot;
  sessionId?: string;
  sessionTitle?: string;
  projectPath: string;
  transcript: readonly TranscriptEntry[];
  streaming: string;
  toolActivity?: string;
  compaction?: { id: string };
  draft: string;
  focus: "composer" | "transcript" | "sidebar" | "modal";
  overlay?: string;
  busy?: boolean;
  requestStartedAt?: number;
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
  readonly presentation = {
    history: createEditorState(),
    windowEnd: undefined as number | undefined,
    expanded: false,
    scrollTop: undefined as number | undefined,
  };
  private renderer?: TuiTranscript;
  private listeners = new Set<(state: TuiViewState) => void>();
  private serial = 0;
  private generation = 0;
  private compactionNotices = new Set<string>();
  private gitSource = new GitChangesSource();
  private state: TuiViewState;

  constructor(
    projectPath: string,
    agentMode: AgentMode = DEFAULT_AGENT_MODE,
    approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE,
    private readonly now: () => number = () => performance.now(),
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
      const entries = this.state.transcript.map(({ text, tone, fileDiff }) => ({
        text,
        tone,
        fileDiff,
      }));
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
    this.update({
      transcript: [
        ...this.withStreaming(),
        { id: this.serial++, text, tone, fileDiff },
      ],
      streaming: "",
    });
    this.renderer?.append(text, tone, fileDiff);
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
    this.compactionNotices.clear();
    this.update({
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
  setFocus(focus: TuiViewState["focus"]): void {
    this.update({ focus });
  }
  setOverlay(overlay?: string): void {
    this.update({ overlay });
  }
  setBusy(busy: boolean): void {
    this.update({ busy });
  }

  /** A queued prompt starts counting only when it actually begins execution. */
  startRequest(): void {
    this.update({
      busy: true,
      requestStartedAt: this.now(),
      toolActivity: undefined,
      compaction: undefined,
    });
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
    this.update({
      transcript: [
        ...this.withStreaming(),
        { id: this.serial++, text, tone: "dim" },
      ],
      streaming: "",
      toolActivity: undefined,
      requestStartedAt: undefined,
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
      Partial<Pick<Session, "title" | "mode" | "approvalMode">>,
    projectPath = session?.projectPath ?? this.state.projectPath,
  ): void {
    this.generation++;
    this.compactionNotices.clear();
    this.presentation.windowEnd = undefined;
    this.presentation.expanded = false;
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
      transcript: [],
      streaming: "",
      draft: "",
      focus: "composer",
    };
    this.renderer?.clear();
    this.notify();
    this.refreshGitChanges();
  }

  /** A token for asynchronous sidebar reads; stale results must be discarded. */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
  get currentGeneration(): number {
    return this.generation;
  }

  dispose(): void {
    this.generation++;
    this.gitSource.dispose();
    this.renderer = undefined;
    this.listeners.clear();
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
