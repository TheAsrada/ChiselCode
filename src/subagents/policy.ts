import { loadGlobalConfig, loadProjectConfig } from "../config/load.js";
import { RuntimeError } from "../runtime/errors.js";
import type { ApprovalOptions, ApprovalRequest } from "../security/approval.js";
import type { ApprovalMode } from "../security/approval-mode.js";
import {
  type PermissionDecision,
  PermissionPolicy,
} from "../security/permission-policy.js";
import type { ToolExecutionConstraint, ToolHandler } from "../tools/types.js";
import type { GlobalConfig, ProjectConfig } from "../types/domain.js";
import { resolveWebConfig } from "../web/schema.js";
import { effectiveSubagentConfig } from "./config.js";
import type { SubagentMode } from "./contracts.js";

export class ChildToolPolicy implements ToolExecutionConstraint {
  private readonly identities = new Map<ToolHandler, string>();
  private current?: PermissionPolicy;
  private frozen: PermissionPolicy;
  private readonly approval: ApprovalMode;
  private readonly allowedTools: Set<string>;
  constructor(
    readonly mode: SubagentMode,
    private readonly origin: string,
    private readonly childRoot: string,
    private readonly configPath: string | undefined,
    private readonly capturedConfig: ProjectConfig,
    capturedGlobal: GlobalConfig,
    approvalMode: ApprovalMode,
    explicitAllow: string | undefined,
    private readonly beforeTool: () => Promise<void>,
  ) {
    this.approval =
      approvalMode === "bypassPermissions" ? "default" : approvalMode;
    this.allowedTools = new Set(
      (explicitAllow ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    );
    this.frozen = this.make(capturedConfig, capturedGlobal);
  }
  private make(config: ProjectConfig, global: GlobalConfig) {
    const options: ApprovalOptions = {
      approvalMode: this.approval,
      autoApprove: false,
      allowedTools: this.allowedTools,
      nonInteractive: false,
      allowBypassPermissions: false,
      network: {
        scope: `child-ceiling:${this.childRoot}`,
        config: resolveWebConfig(global.web, config.web),
      },
    };
    return new PermissionPolicy({ ...config, autoApprove: false }, options);
  }
  private fingerprint(handler: ToolHandler) {
    return JSON.stringify([
      handler.spec.name,
      handler.spec.source,
      handler.spec.effect,
      handler.spec.workspaceAccess,
      handler.spec.permission,
    ]);
  }
  private eligible(handler: ToolHandler): boolean {
    const spec = handler.spec;
    if (spec.source?.type === "local") {
      if (spec.effect === "read") return true;
      return (
        this.mode === "coding" &&
        (spec.effect === "workspace_write" ||
          (spec.effect === "process" && spec.name === "run_shell"))
      );
    }
    if (spec.source?.type === "web") return spec.effect === "external_read";
    return (
      spec.source?.type === "extension" &&
      spec.effect === "read" &&
      ((spec.source.extensionId === "builtin.project" &&
        spec.source.originalName === "manifest") ||
        (spec.source.extensionId === "builtin.lsp" &&
          [
            "status",
            "diagnostics",
            "definition",
            "references",
            "symbols",
          ].includes(spec.source.originalName)))
    );
  }
  seal(handlers: readonly ToolHandler[]): void {
    for (const handler of handlers)
      if (this.eligible(handler))
        this.identities.set(handler, this.fingerprint(handler));
  }
  allows(handler: ToolHandler): boolean {
    return (
      this.eligible(handler) &&
      this.identities.get(handler) === this.fingerprint(handler)
    );
  }
  private assert(handler: ToolHandler): void {
    if (!this.allows(handler))
      throw new RuntimeError(
        "PERMISSION_DENIED",
        "Инструмент недоступен этому помощнику; права не выдаются текстом модели, aliases или обновлением provider.",
      );
  }
  async refresh(): Promise<void> {
    const [global, origin, child] = await Promise.all([
      loadGlobalConfig(this.configPath),
      loadProjectConfig(this.origin),
      loadProjectConfig(this.childRoot),
    ]);
    if (
      !effectiveSubagentConfig(global.subagents, origin.subagents).enabled ||
      child.subagents?.enabled === false
    )
      throw new RuntimeError(
        "PERMISSION_DENIED",
        "Делегирование отключено пользователем или проектом.",
      );
    this.current = this.make(
      {
        ...origin,
        deniedCommands: [
          ...new Set([...origin.deniedCommands, ...child.deniedCommands]),
        ],
      },
      global,
    );
  }
  async beforePrepare(handler: ToolHandler): Promise<void> {
    this.assert(handler);
    await this.refresh();
    await this.beforeTool();
  }
  async beforeExecute(handler: ToolHandler): Promise<void> {
    this.assert(handler);
    await this.refresh();
  }
  authorizeNetwork(request: ApprovalRequest, approvedOnce: boolean) {
    const frozen = this.frozen.authorizeNetwork(
      request,
      this.approval,
      approvedOnce,
    );
    const current = this.current?.authorizeNetwork(
      request,
      this.approval,
      approvedOnce,
    );
    if (!current)
      throw new RuntimeError(
        "PERMISSION_DENIED",
        "Сетевая политика помощника не проверена.",
      );
    return {
      destinations: frozen.destinations?.filter(
        (host) => !current.destinations || current.destinations.includes(host),
      ),
      assertDestination(host: string) {
        frozen.assertDestination(host);
        current.assertDestination(host);
      },
    };
  }
  decision(request: ApprovalRequest, handler: ToolHandler): PermissionDecision {
    this.assert(handler);
    const decisions = [
      this.frozen.decide(request, handler.spec.effect, this.approval),
      this.current?.decide(request, handler.spec.effect, this.approval) ??
        "ask",
    ];
    return decisions.includes("deny")
      ? "deny"
      : decisions.includes("ask")
        ? "ask"
        : "allow";
  }
}
