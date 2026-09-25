import type { FileDiff, ProjectConfig, ToolName } from "../types/domain.js";

const MUTATING_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  "write_file",
  "edit_file",
  "delete_file",
  "run_shell",
  "git_commit",
  "create_skill",
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
  constructor(
    private readonly config: ProjectConfig,
    private readonly options: ApprovalOptions,
    private readonly resolver: ApprovalResolver,
  ) {}

  async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (!MUTATING_TOOLS.has(request.tool)) return "approved";
    if (request.tool === "run_shell" && request.command)
      return this.decideCommand(request);
    if (
      this.options.autoApprove ||
      this.config.autoApprove ||
      this.options.allowedTools.has(request.tool as ToolName)
    )
      return "approved";
    if (this.options.nonInteractive) return "unavailable";
    return this.resolver.requestApproval(request);
  }

  private async decideCommand(
    request: ApprovalRequest,
  ): Promise<ApprovalDecision> {
    const command = request.command ?? "";
    if (matchesAny(command, this.config.deniedCommands)) return "denied";
    if (matchesAny(command, this.config.allowedCommands)) return "approved";
    if (
      this.options.autoApprove ||
      this.config.autoApprove ||
      this.options.allowedTools.has("run_shell")
    )
      return "approved";
    if (this.options.nonInteractive) return "unavailable";
    return this.resolver.requestApproval(request);
  }
}

function matchesAny(command: string, rules: string[]): boolean {
  return rules.some((rule) => {
    const trimmed = rule.trim();
    if (!trimmed) return false;
    return command === trimmed || command.startsWith(`${trimmed} `);
  });
}

export function mutatesWorkspace(tool: ToolName): boolean {
  return MUTATING_TOOLS.has(tool);
}
