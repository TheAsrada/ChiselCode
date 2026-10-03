import type { ProjectConfig } from "../types/domain.js";
import type { ApprovalOptions, ApprovalRequest } from "./approval.js";
import { type ApprovalMode, resolveApprovalMode } from "./approval-mode.js";
import { analyzeShell, commandMatches, simpleCommand } from "./shell-policy.js";
export type PermissionDecision = "allow" | "ask" | "deny";
export class PermissionPolicy {
  constructor(
    private readonly config: ProjectConfig,
    private readonly options: ApprovalOptions,
  ) {}
  get approvalMode(): ApprovalMode {
    return resolveApprovalMode({
      approvalMode:
        this.options.approvalMode === "bypassPermissions" && !this.bypassAllowed
          ? "default"
          : this.options.approvalMode,
      yes: this.options.autoApprove,
      autoApprove: this.config.autoApprove,
      allowBypassPermissions: this.bypassAllowed,
    });
  }
  get bypassAllowed(): boolean {
    const available = this.options.allowBypassPermissions;
    return typeof available === "function"
      ? available() === true
      : available === true;
  }
  decide(
    request: ApprovalRequest,
    effect: string,
    approvalMode = this.approvalMode,
  ): PermissionDecision {
    if (request.mcp) {
      const rules = request.mcpPermissions;
      const tool = rules?.tools[request.mcp.originalName];
      const category = rules?.categories[request.mcp.category];
      const server = rules?.default;
      if ([tool, category, server].includes("deny")) return "deny";
      const decision = tool ?? category ?? server ?? "ask";
      if (decision === "allow" || this.options.allowedTools.has(request.tool))
        return "allow";
      if (approvalMode === "bypassPermissions" && this.bypassAllowed)
        return "allow";
      return approvalMode === "dontAsk" ? "deny" : "ask";
    }
    if (effect === "read") return "allow";
    if (request.command) {
      const analysis = analyzeShell(request.command);
      // Denies win, including obvious executable matches in compound commands.
      if (
        this.config.deniedCommands.some(
          (rule) =>
            commandMatches(request.command ?? "", rule) ||
            analysis.commands.some(
              (part) => part.executable === rule.trim().split(/\s+/)[0],
            ) ||
            request.command?.includes(rule),
        )
      )
        return "deny";
      if (
        simpleCommand(request.command) &&
        this.config.allowedCommands.some((rule) =>
          commandMatches(request.command ?? "", rule),
        )
      )
        return "allow";
      // Broad explicit tool approval can still authorize complex shell; prefix rules cannot.
    }
    if (this.options.allowedTools.has(request.tool)) return "allow";
    if (approvalMode === "bypassPermissions" && this.bypassAllowed)
      return "allow";
    if (approvalMode === "acceptEdits" && effect === "workspace_write")
      return "allow";
    if (approvalMode === "dontAsk") return "deny";
    return "ask";
  }
}
