import type { ProjectConfig } from "../types/domain.js";
import { resolveWebConfig } from "../web/schema.js";
import type { ApprovalOptions, ApprovalRequest } from "./approval.js";
import { type ApprovalMode, resolveApprovalMode } from "./approval-mode.js";
import {
  type NetworkAuthorization,
  type NetworkRequest,
  networkDecision,
  networkDenied,
  networkSessionGrants,
} from "./network-policy.js";
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
    if (request.network) {
      const current = networkDecision(
        request.network,
        this.webConfig,
        this.grants,
      );
      if (current === "deny" || current === "allow") return current;
      if (this.options.allowedTools.has(request.tool)) return "allow";
      if (approvalMode === "bypassPermissions" && this.bypassAllowed)
        return "allow";
      return approvalMode === "dontAsk" ? "deny" : "ask";
    }
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
  private get webConfig() {
    const config = this.options.network?.config;
    return resolveWebConfig(
      typeof config === "function" ? config() : config,
      this.config.web,
    );
  }
  private get grants() {
    return this.options.network
      ? networkSessionGrants(this.options.network.scope)
      : undefined;
  }
  grantNetwork(request: NetworkRequest): void {
    const grants = this.grants;
    if (!grants) return;
    if (request.operation === "search") grants.search = true;
    else grants.domains.add(request.hostname);
  }
  authorizeNetwork(
    request: ApprovalRequest,
    approvalMode: ApprovalMode,
    allowOnce: boolean,
  ): NetworkAuthorization {
    const initial = request.network;
    if (!initial) throw new Error("Network approval metadata is missing.");
    const searchHosts =
      initial.operation === "search"
        ? [
            ...new Set(
              initial.searchHosts?.length
                ? initial.searchHosts
                : [initial.hostname],
            ),
          ]
        : undefined;
    const destinations = searchHosts?.filter(
      (hostname) =>
        networkDecision(
          { ...initial, hostname, searchHosts: undefined },
          this.webConfig,
          this.grants,
        ) !== "deny",
    );
    return {
      ...(destinations ? { destinations: Object.freeze(destinations) } : {}),
      assertDestination: (hostname) => {
        if (searchHosts && !searchHosts.includes(hostname))
          networkDenied(
            "Search access is restricted to the approved service endpoints.",
          );
        const destination = { ...initial, hostname, searchHosts: undefined };
        if (
          networkDecision(destination, this.webConfig, this.grants) === "deny"
        )
          networkDenied();
        if (
          allowOnce &&
          (searchHosts?.includes(hostname) || hostname === initial.hostname)
        )
          return;
        if (
          this.decide(
            { ...request, network: destination },
            "external_read",
            approvalMode,
          ) !== "allow"
        )
          networkDenied(
            `Network access to ${hostname} requires permission. For a redirect, call web_fetch on the destination URL to approve it separately.`,
          );
      },
    };
  }
}
