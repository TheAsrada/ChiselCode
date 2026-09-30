import type { ProjectConfig } from "../types/domain.js";
import type { ApprovalOptions, ApprovalRequest } from "./approval.js";
import { analyzeShell, commandMatches, simpleCommand } from "./shell-policy.js";
export type PermissionDecision = "allow" | "ask" | "deny";
export class PermissionPolicy {
  constructor(
    private readonly config: ProjectConfig,
    private readonly options: ApprovalOptions,
  ) {}
  decide(request: ApprovalRequest, effect: string): PermissionDecision {
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
    if (
      this.options.autoApprove ||
      this.config.autoApprove ||
      this.options.allowedTools.has(request.tool)
    )
      return "allow";
    return "ask";
  }
}
