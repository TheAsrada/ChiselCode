import type { FileDiff, Session } from "../types/domain.js";
import type { TranscriptTone, TuiTranscript } from "./tui.js";

export interface TranscriptEntry {
  id: number;
  text: string;
  tone: TranscriptTone;
  fileDiff?: FileDiff;
}

export interface TuiViewState {
  sessionId?: string;
  projectPath: string;
  transcript: readonly TranscriptEntry[];
  streaming: string;
  toolActivity?: string;
  draft: string;
  focus: "composer" | "transcript" | "sidebar" | "modal";
  overlay?: string;
}

/** The agent writes to this boundary; either terminal renderer may subscribe. */
export class TuiController implements TuiTranscript {
  private renderer?: TuiTranscript;
  private listeners = new Set<(state: TuiViewState) => void>();
  private serial = 0;
  private generation = 0;
  private state: TuiViewState;

  constructor(projectPath: string) {
    this.state = {
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
  setFocus(focus: TuiViewState["focus"]): void {
    this.update({ focus });
  }
  setOverlay(overlay?: string): void {
    this.update({ overlay });
  }

  /** Invalidates responses from the previous project or session immediately. */
  switchSession(
    session?: Pick<Session, "id" | "projectPath">,
    projectPath = session?.projectPath ?? this.state.projectPath,
  ): void {
    this.generation++;
    this.state = {
      projectPath,
      sessionId: session?.id,
      transcript: [],
      streaming: "",
      draft: "",
      focus: "composer",
    };
    this.renderer?.clear();
    this.notify();
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
