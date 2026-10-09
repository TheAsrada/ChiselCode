import type { CapturedCommandModel } from "../app/model-command.js";
import type { PreparedExtensionCommand } from "../app/run-command.js";
import type { RunOptions } from "../app/run-prompt.js";
import type { WorkspaceExtensionScope } from "../extensions/host.js";
import type { AgentMode } from "../runtime/agent-mode.js";
import type { ApprovalMode } from "../security/approval-mode.js";
import type { ToolExecutionResult } from "../types/domain.js";
import { createTuiApprovalResolver } from "./tui-contract.js";
import type { TuiController } from "./tui-controller.js";

export interface QueuedTabPrompt {
  kind: "prompt";
  input: string;
  mode: AgentMode;
  approvalMode: ApprovalMode;
  modelOptions: RunOptions;
  generation: number;
  root: string;
}
export interface QueuedTabCommand extends Omit<QueuedTabPrompt, "kind"> {
  kind: "command";
  prepared: PreparedExtensionCommand;
  capturedModel?: CapturedCommandModel;
  scope: WorkspaceExtensionScope;
  /** Optional Settings waiter; the operation still belongs to this conversation. */
  onResult?(result: ToolExecutionResult): void;
}
export type QueuedTabOperation = QueuedTabPrompt | QueuedTabCommand;

/** Execution belongs to the conversation, even while its screen is unmounted. */
export class TuiTabExecution {
  readonly sideRuns = new Map<
    string,
    { abort: AbortController; promise: Promise<void> }
  >();
  get foregroundBusy(): boolean {
    return (
      !!this.activeRun ||
      this.pendingOperations.length > 0 ||
      this.pendingSubmissions.size > 0
    );
  }
  cancelSides(): void {
    for (const run of this.sideRuns.values()) run.abort.abort();
  }
  activeRun?: Promise<void>;
  abort?: AbortController;
  readonly pendingOperations: QueuedTabOperation[] = [];
  /** Cancellable waits before a slash head can be resolved, never a second execution queue. */
  readonly pendingSubmissions = new Set<AbortController>();
  readonly approvalResolver;

  constructor(controller: TuiController) {
    this.approvalResolver = createTuiApprovalResolver({
      allowUnbound: true,
      onChange: (request) => controller.setAwaitingApproval(!!request),
    });
  }

  get busy(): boolean {
    return (
      !!this.activeRun ||
      this.pendingOperations.length > 0 ||
      this.pendingSubmissions.size > 0 ||
      this.sideRuns.size > 0
    );
  }

  cancel(): void {
    for (const item of this.pendingOperations)
      if (item.kind === "command")
        item.onResult?.({
          output: "Queued command cancelled.",
          isError: true,
          errorCode: "CANCELLED",
        });
    this.pendingOperations.length = 0;
    for (const submission of this.pendingSubmissions) submission.abort();
    this.pendingSubmissions.clear();
    this.abort?.abort();
    this.approvalResolver.cancel();
  }

  dispose(): void {
    this.cancelSides();
    this.cancel();
    this.approvalResolver.dispose();
  }
}
