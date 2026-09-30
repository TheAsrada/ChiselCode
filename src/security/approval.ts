import type { FileDiff, ProjectConfig, ToolName } from "../types/domain.js";
import { PermissionPolicy } from "./permission-policy.js";

const MUTATING_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  "write_file",
  "edit_file",
  "delete_file",
  "run_shell",
  "git_commit",
  "create_skill",
  "apply_patch",
]);

export type ApprovalDecision = "approved" | "denied" | "unavailable";

export interface ApprovalRequest {
  /**
   * Имя инструмента или псевдодействия (например `self_update` для
   * подтверждения установки обновления). Человекочитаемая подпись
   * берётся из TOOL_DISPLAY с запасным вариантом на само имя.
   */
  tool: string;
  preview: string;
  command?: string;
  fileDiff?: FileDiff;
}

export interface ApprovalResolver {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface ApprovalOptions {
  autoApprove: boolean;
  allowedTools: Set<ToolName>;
  nonInteractive: boolean;
}

export class ApprovalGate {
  readonly policy: PermissionPolicy;
  constructor(
    config: ProjectConfig,
    private readonly options: ApprovalOptions,
    private readonly resolver: ApprovalResolver,
  ) {
    this.policy = new PermissionPolicy(config, options);
  }
  async resolve(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.options.nonInteractive) return "unavailable";
    return this.resolver.requestApproval(request);
  }
  async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const decision = this.policy.decide(
      request,
      MUTATING_TOOLS.has(request.tool) ? "workspace_write" : "read",
    );
    return decision === "allow"
      ? "approved"
      : decision === "deny"
        ? "denied"
        : this.resolve(request);
  }
}

export function mutatesWorkspace(tool: ToolName): boolean {
  return MUTATING_TOOLS.has(tool);
}
