import { resolve } from "node:path";
import { type AgentMode, DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import {
  type ApprovalMode,
  DEFAULT_APPROVAL_MODE,
} from "../security/approval-mode.js";
import type { Session } from "../types/domain.js";
import { createEditorState } from "./editor.js";
import type { ModelSelection } from "./opentui-models.js";
import { replaySessionIntoTranscript } from "./tool-transcript.js";
import { TuiController } from "./tui-controller.js";
import { TuiTabExecution } from "./tui-tab-execution.js";

export interface SessionTab {
  key: string;
  controller: TuiController;
}

/** Home is a separate route. Each open tab owns its draft and agent output. */
export class TuiWorkspace {
  readonly home: TuiController;
  tabs: SessionTab[] = [];
  activeKey?: string;
  private serial = 0;
  private listeners = new Set<() => void>();
  private subscriptions = new Map<string, () => void>();
  private executions = new Map<TuiController, TuiTabExecution>();

  constructor(
    projectPath: string,
    mode: AgentMode = DEFAULT_AGENT_MODE,
    approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE,
  ) {
    this.home = new TuiController(projectPath, mode, approvalMode);
    this.executions.set(this.home, new TuiTabExecution(this.home));
  }

  execution(controller = this.controller): TuiTabExecution {
    const execution = this.executions.get(controller);
    if (!execution) throw new Error("Conversation is no longer open.");
    return execution;
  }

  get busy(): boolean {
    return [...this.executions.values()].some((execution) => execution.busy);
  }

  cancelAll(): void {
    for (const execution of this.executions.values()) execution.cancel();
  }

  async waitForRuns(): Promise<void> {
    await Promise.allSettled(
      [...this.executions.values()].map((execution) => execution.activeRun),
    );
  }

  get controller(): TuiController {
    return (
      this.tabs.find((tab) => tab.key === this.activeKey)?.controller ??
      this.home
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A new conversation starts on the welcome screen, without allocating a tab. */
  newDraft(projectPath = this.controller.snapshot.projectPath): TuiController {
    const mode = this.controller.snapshot.agentMode;
    const approvalMode = this.controller.snapshot.approvalMode;
    const model = this.controller.snapshot.modelSelection;
    const capabilities = this.controller.snapshot.modelCapabilities;
    if (this.activeKey || projectPath !== this.home.snapshot.projectPath) {
      this.home.switchSession(undefined, projectPath);
      this.home.presentation.history = createEditorState();
    }
    this.home.setAgentMode(mode);
    this.home.setApprovalMode(approvalMode);
    if (model)
      this.home.setActiveModel(
        model.provider,
        model.model,
        model.profileId,
        model.baseUrl,
      );
    if (model && capabilities)
      this.home.setModelCapabilities(model, capabilities);
    this.select();
    return this.home;
  }

  newTab(
    projectPath = this.controller.snapshot.projectPath,
    mode = this.controller.snapshot.agentMode,
    approvalMode = this.controller.snapshot.approvalMode,
    model: ModelSelection | undefined = this.controller.snapshot.modelSelection,
  ): TuiController {
    const controller = new TuiController(projectPath, mode, approvalMode);
    this.executions.set(controller, new TuiTabExecution(controller));
    if (model)
      controller.setActiveModel(
        model.provider,
        model.model,
        model.profileId,
        model.baseUrl,
      );
    const key = `tab-${++this.serial}`;
    this.tabs = [...this.tabs, { key, controller }];
    this.subscriptions.set(
      key,
      controller.subscribe(() => this.notify()),
    );
    this.activeKey = key;
    controller.refreshGitChanges();
    this.notify();
    return controller;
  }

  openSession(session: Session): TuiController {
    const existing = this.tabs.find(
      ({ controller }) =>
        controller.snapshot.sessionId === session.id &&
        resolve(controller.snapshot.projectPath) ===
          resolve(session.projectPath),
    );
    if (existing) {
      this.select(existing.key);
      return existing.controller;
    }
    const controller = this.newTab(session.projectPath);
    controller.switchSession(session);
    replaySessionIntoTranscript(controller, session);
    controller.setSessionUsage(session);
    return controller;
  }

  select(key?: string): void {
    if (key && !this.tabs.some((tab) => tab.key === key)) return;
    this.activeKey = key;
    this.notify();
  }

  cycle(direction: -1 | 1): void {
    const keys = this.tabs.map((tab) => tab.key);
    if (!keys.length) return;
    if (!this.activeKey) {
      this.select(direction === 1 ? keys[0] : keys.at(-1));
      return;
    }
    this.select(
      keys[
        (keys.indexOf(this.activeKey) + direction + keys.length) % keys.length
      ],
    );
  }

  /** Closing a tab never deletes the saved session. Busy tabs keep their owner. */
  close(key = this.activeKey): boolean {
    const index = this.tabs.findIndex((tab) => tab.key === key);
    const tab = this.tabs[index];
    if (
      !tab ||
      tab.controller.snapshot.busy ||
      this.execution(tab.controller).busy
    )
      return false;
    this.subscriptions.get(tab.key)?.();
    this.subscriptions.delete(tab.key);
    this.execution(tab.controller).dispose();
    this.executions.delete(tab.controller);
    tab.controller.dispose();
    this.tabs = this.tabs.filter((item) => item !== tab);
    if (this.activeKey === key)
      this.activeKey = this.tabs[index]?.key ?? this.tabs[index - 1]?.key;
    this.notify();
    return true;
  }

  dispose(): void {
    for (const execution of this.executions.values()) execution.dispose();
    this.executions.clear();
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    for (const tab of this.tabs) tab.controller.dispose();
    this.home.dispose();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
