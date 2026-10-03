import type { RunOptions } from "../app/run-prompt.js";
import type { AgentMode } from "../runtime/agent-mode.js";
import type { ApprovalMode } from "../security/approval-mode.js";
import { createTuiApprovalResolver } from "./tui-contract.js";
import type { TuiController } from "./tui-controller.js";

export interface QueuedTabPrompt {
  input: string;
  mode: AgentMode;
  approvalMode: ApprovalMode;
  modelOptions: RunOptions;
  generation: number;
}

/** Execution belongs to the conversation, even while its screen is unmounted. */
export class TuiTabExecution {
  activeRun?: Promise<void>;
  abort?: AbortController;
  readonly pendingPrompts: QueuedTabPrompt[] = [];
  readonly approvalResolver;

  constructor(controller: TuiController) {
    this.approvalResolver = createTuiApprovalResolver({
      allowUnbound: true,
      onChange: (request) => controller.setAwaitingApproval(!!request),
    });
  }

  get busy(): boolean {
    return !!this.activeRun || this.pendingPrompts.length > 0;
  }

  cancel(): void {
    this.pendingPrompts.length = 0;
    this.abort?.abort();
    this.approvalResolver.cancel();
  }

  dispose(): void {
    this.cancel();
    this.approvalResolver.dispose();
  }
}
