import { resolve } from "node:path";
import { type AgentMode, DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import {
  type ApprovalMode,
  DEFAULT_APPROVAL_MODE,
} from "../security/approval-mode.js";
import type {
  ContextSnapshot,
  FileDiff,
  Session,
  TokenUsage,
} from "../types/domain.js";
import { createEditorState } from "./editor.js";
import { GitChangesSource, type GitWorkingState } from "./git-changes.js";
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
  sessionId?: string;
  sessionTitle?: string;
  projectPath: string;
  transcript: readonly TranscriptEntry[];
  streaming: string;
  toolActivity?: string;
  draft: string;
  focus: "composer" | "transcript" | "sidebar" | "modal";
  overlay?: string;
  busy?: boolean;
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
  private gitSource = new GitChangesSource();
  private state: TuiViewState;

  constructor(
    projectPath: string,
    agentMode: AgentMode = DEFAULT_AGENT_MODE,
    approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE,
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
    });
    if (this.renderer?.replace) this.renderer.replace(entries);
    else if (this.renderer) {
      this.renderer.clear();
      for (const entry of entries)
        this.renderer.append(entry.text, entry.tone, entry.fileDiff);
    }
  }

  clear(): void {
    this.update({ transcript: [], streaming: "", toolActivity: undefined });
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

  setSessionUsage(session: Session): void {
    if (resolve(session.projectPath) !== resolve(this.state.projectPath))
      return;
    if (this.state.sessionId && this.state.sessionId !== session.id) return;
    this.update({
      sessionId: session.id,
      sessionTitle: session.title,
      usage: {
        provider: session.providerId,
        profileId: session.profileId,
        model: session.model,
        totalTokens: { ...session.totalTokens },
        totalCost:
          session.costEstimate?.source === "unknown"
            ? undefined
            : (session.costEstimate?.usd ?? session.totalCost),
        contextSnapshot:
          session.contextSnapshot?.model === session.model
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
  ): void {
    const usage = this.state.usage;
    if (!usage) return;
    this.update({
      usage: {
        ...usage,
        provider,
        profileId,
        model,
        contextSnapshot:
          usage.provider === provider && usage.model === model
            ? usage.contextSnapshot
            : undefined,
      },
    });
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
