import { join } from "node:path";
import { ToolResultStore } from "../context/tool-result-store.js";
import type { ToolGuardPort } from "../extensions/contracts.js";
import { sessionsRootDir } from "../paths/home.js";
import { type AgentMode, DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import { RuntimeEventBus } from "../runtime/events.js";
import type { ApprovalGate, ApprovalRequest } from "../security/approval.js";
import {
  type ApprovalMode,
  resolveApprovalMode,
} from "../security/approval-mode.js";
import { HostSandboxExecutor } from "../security/sandbox.js";
import { WorkspacePolicy } from "../security/workspace-policy.js";
import { initializeSessionState } from "../sessions/migrations.js";
import type { Skill } from "../skills/skills.js";
import type { Session, ToolExecutionResult } from "../types/domain.js";
import { ToolCatalog } from "./catalog.js";
import { EditingService } from "./editing/service.js";
import { ToolExecutor } from "./executor.js";
import { LocalToolProvider, SkillsToolProvider } from "./local/provider.js";
import { ToolScheduler } from "./scheduler.js";
import type { ToolContext } from "./types.js";
export function createLocalToolRuntime(
  root: string,
  ignorePatterns: string[],
  gate: ApprovalGate,
  session: Session,
  skills: readonly Skill[] = [],
  options: {
    mode?: AgentMode;
    approvalMode?: ApprovalMode;
    events?: RuntimeEventBus;
    signal?: AbortSignal;
    checkpoint?: () => Promise<void>;
    sanitizeResult?: (result: ToolExecutionResult) => ToolExecutionResult;
    sanitizeApproval?: (request: ApprovalRequest) => ApprovalRequest;
    artifactDirectory?: string;
    maxInlineTokens?: number;
    maxParallelReads?: number;
    requireFreshRead?: boolean;
    toolGuards?: ToolGuardPort;
    executionConstraint?: import("./types.js").ToolExecutionConstraint;
    approvalOwner?: import("./types.js").ToolContext["approvalOwner"];
    subagentTools?: import("../subagents/service.js").SubagentToolBinding;
    worktrees?: import("../worktrees/service.js").WorktreeWorkspacePort;
  } = {},
) {
  initializeSessionState(session);
  const workspace = new WorkspacePolicy(root, ignorePatterns);
  const catalog = new ToolCatalog(
    () =>
      options.mode ??
      session.runtime?.turnMode ??
      session.mode ??
      DEFAULT_AGENT_MODE,
    (handler) => options.executionConstraint?.allows(handler) ?? true,
  );
  for (const handler of [
    ...new LocalToolProvider().handlers,
    ...new SkillsToolProvider(skills).handlers,
  ])
    catalog.register(handler);
  const context: ToolContext = {
    executionConstraint: options.executionConstraint,
    approvalOwner: options.approvalOwner,
    subagentTools: options.subagentTools,
    worktrees: options.worktrees,
    mode: options.mode,
    approvalMode: options.approvalMode,
    session,
    workspace,
    editing: new EditingService(
      workspace,
      session.runtime?.workspaceObservations ?? {},
      options.requireFreshRead,
    ),
    artifacts: new ToolResultStore(
      options.artifactDirectory ??
        join(sessionsRootDir(), "artifacts", session.id),
    ),
    sandbox: new HostSandboxExecutor(),
    events: options.events ?? new RuntimeEventBus(session.id),
    signal: options.signal,
    checkpoint: options.checkpoint ?? (async () => {}),
    sanitizeResult: options.sanitizeResult,
    sanitizeApproval: options.sanitizeApproval,
  };
  const executor = new ToolExecutor(
    catalog,
    gate,
    context,
    options.maxInlineTokens,
    options.toolGuards,
  );
  const scheduler = new ToolScheduler(executor, options.maxParallelReads);
  const getApprovalMode = (requested?: ApprovalMode) =>
    resolveApprovalMode({
      saved:
        requested ??
        options.approvalMode ??
        session.runtime?.turnApprovalMode ??
        session.approvalMode ??
        gate.policy.approvalMode,
      allowBypassPermissions: gate.policy.bypassAllowed,
    });
  return { catalog, executor, scheduler, context, getApprovalMode };
}
