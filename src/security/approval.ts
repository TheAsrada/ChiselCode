import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { FileDiff, ProjectConfig, ToolName } from "../types/domain.js";
import type { WebConfig } from "../web/schema.js";
import type { ApprovalModeInput } from "./approval-mode.js";
import type { NetworkRequest } from "./network-policy.js";
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

export type ApprovalDecision =
  | "approved"
  | "approved_always"
  | "approved_session"
  | "denied"
  | "unavailable";
export interface McpApprovalPreview {
  serverId: string;
  serverTitle: string;
  originalName: string;
  title: string;
  category: import("../tools/types.js").McpToolCategory;
  fields: Array<{ label: string; value: string }>;
  consequence: string;
  destructive: boolean;
}

export interface ApprovalRequest {
  /** Core-owned attribution; permission/grant identity remains the canonical tool name. */
  source?: import("../tools/types.js").ToolSource;
  /**
   * Имя инструмента или псевдодействия (например `self_update` для
   * подтверждения установки обновления). Человекочитаемая подпись
   * берётся из TOOL_DISPLAY с запасным вариантом на само имя.
   */
  tool: string;
  preview: string;
  command?: string;
  fileDiff?: FileDiff;
  /** All files covered by this one atomic action; fileDiff remains compatible. */
  diffs?: FileDiff[];
  mcp?: McpApprovalPreview;
  mcpPermissions?: import("../mcp/schema.js").McpPermissions;
  network?: NetworkRequest;
}

export interface ApprovalResolver {
  requestApproval(
    request: ApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision>;
}

export interface ApprovalOptions {
  approvalMode?: ApprovalModeInput;
  /** User setting, never granted by project instructions or a session record. */
  allowBypassPermissions?: boolean | (() => boolean);
  autoApprove: boolean;
  allowedTools: Set<ToolName>;
  nonInteractive: boolean;
  network?: { scope: string; config: WebConfig | (() => WebConfig) };
}

export class ApprovalGate {
  readonly policy: PermissionPolicy;
  private approvalQueue: Promise<void> = Promise.resolve();
  constructor(
    config: ProjectConfig,
    private readonly options: ApprovalOptions,
    private readonly resolver: ApprovalResolver,
  ) {
    this.policy = new PermissionPolicy(config, options);
  }
  async resolve(
    request: ApprovalRequest,
    options: {
      effect?: string;
      approvalMode?: import("./approval-mode.js").ApprovalMode;
      signal?: AbortSignal;
    } = {},
  ): Promise<ApprovalDecision> {
    if (this.options.nonInteractive) return "unavailable";
    const previous = this.approvalQueue;
    let release = () => {};
    this.approvalQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waiting(previous, options.signal);
      cancelled(options.signal);
      if (options.effect) {
        const current = this.policy.decide(
          request,
          options.effect,
          options.approvalMode,
        );
        if (current !== "ask")
          return current === "allow" ? "approved" : "denied";
      }
      const decision = await waiting(
        this.resolver.requestApproval(request, options.signal),
        options.signal,
      );
      cancelled(options.signal);
      if (decision === "approved_session" && request.network)
        this.policy.grantNetwork(request.network);
      return decision;
    } finally {
      // A cancelled queued request must not let later prompts overtake the active popup.
      void previous.then(release, release);
    }
  }
  async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
    const decision = this.policy.decide(
      request,
      request.tool === "run_shell"
        ? "process"
        : request.tool === "git_commit"
          ? "git_write"
          : request.tool === "create_skill"
            ? "external"
            : MUTATING_TOOLS.has(request.tool)
              ? "workspace_write"
              : "read",
    );
    return decision === "allow"
      ? "approved"
      : decision === "deny"
        ? "denied"
        : this.resolve(request);
  }
}

async function waiting<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  cancelled(signal);
  if (!signal) return promise;
  let abort = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        abort = () =>
          reject(new RuntimeError("CANCELLED", "Approval cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function mutatesWorkspace(tool: ToolName): boolean {
  return MUTATING_TOOLS.has(tool);
}
