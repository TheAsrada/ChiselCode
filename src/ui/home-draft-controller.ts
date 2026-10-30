import { randomUUID } from "node:crypto";
import type { WorkspaceRef } from "../projects/admission.js";
import { type AgentMode, DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import {
  type ApprovalMode,
  DEFAULT_APPROVAL_MODE,
} from "../security/approval-mode.js";
import { TuiPresentationController } from "./tui-controller.js";

/** Application draft: no executor, session, dummy root or workspace scope. */
export class HomeDraftController extends TuiPresentationController {
  readonly draftId = randomUUID();
  selection?: WorkspaceRef;
  constructor(
    root?: string,
    mode: AgentMode = DEFAULT_AGENT_MODE,
    approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE,
  ) {
    super(root, mode, approvalMode, undefined, "dialog");
  }
  selectProject(ref: WorkspaceRef): void {
    const draft = this.snapshot.draft;
    const model = this.snapshot.modelSelection,
      capabilities = this.snapshot.modelCapabilities;
    const history = this.presentation.history;
    this.switchSession(undefined, ref.root);
    this.selection = ref;
    this.setDraft(draft);
    if (model && capabilities) this.setModelCapabilities(model, capabilities);
    Object.assign(this.presentation.history, history);
  }
}
