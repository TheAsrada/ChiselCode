import { loadGlobalConfig, loadProjectConfig } from "../config/load.js";
import {
  commonGitResource,
  gitIdentity,
  localGitResource,
} from "../git/driver.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { PermissionPolicy } from "../security/permission-policy.js";
import { SENSITIVE_KEY } from "../security/redaction.js";
import { WorkspacePolicy } from "../security/workspace-policy.js";
import type { ToolContext } from "../tools/types.js";
import {
  type WorkspaceAccess,
  workspaceCoordinator,
} from "../tools/workspace-coordinator.js";
import { terminalSafeText } from "../ui/terminal-text.js";
import { BACKGROUND_LIMITS, effectiveBackgroundConfig } from "./config.js";
import type { BackgroundTaskRecord } from "./contracts.js";
import { type ShellData, type ShellInput, ShellInputSchema } from "./input.js";
import type { ProcessLog } from "./log.js";
import type { BackgroundOwnerBinding } from "./owner-binding.js";

export interface ShellPolicyTarget {
  binding: BackgroundOwnerBinding;
  owner: { binding: BackgroundOwnerBinding };
  data: ShellData;
  context: ToolContext;
  record: BackgroundTaskRecord;
  log?: Pick<ProcessLog, "narrowLimit">;
}
export async function resolveShell(
  binding: BackgroundOwnerBinding,
  context: ToolContext,
  raw: ShellInput,
): Promise<ShellData> {
  const input = ShellInputSchema.parse(structuredClone(raw));
  let root = binding.root;
  let worktree = binding.worktree;
  if (input.targetWorktreeId) {
    if (binding.childId && input.targetWorktreeId !== binding.worktree?.id)
      throw new RuntimeError(
        "PERMISSION_DENIED",
        "Помощник может запускать команды только в собственной копии.",
      );
    if (!binding.childId) {
      const target = await context.worktrees?.ownedBackgroundTarget(
        input.targetWorktreeId,
        binding.session.id,
      );
      if (
        !target?.id ||
        !target.base ||
        target.readOnly ||
        target.state !== "ready"
      )
        throw new RuntimeError(
          "WORKTREE_UNAVAILABLE",
          "Нужна доступная собственная рабочая копия.",
        );
      root = target.path;
      worktree = { id: target.id, label: target.label, base: target.base };
    }
  }
  const workspace = new WorkspacePolicy(root, binding.config.ignorePatterns);
  const cwd = await workspace.resolve(input.cwd ?? ".");
  return {
    ...input,
    cwd,
    actualRoot: root,
    timeout: input.timeout ?? 120000,
    ...(worktree ? { worktree } : {}),
  };
}
export async function shellAccesses(
  root: string,
): Promise<readonly WorkspaceAccess[]> {
  const scope = await workspaceCoordinator.scope(root);
  const plan: WorkspaceAccess[] = scope.map((resource) => ({
    resource,
    mode: "write",
  }));
  try {
    const identity = await gitIdentity(root);
    plan.push(
      { resource: commonGitResource(identity), mode: "write" },
      { resource: localGitResource(identity), mode: "write" },
    );
  } catch {
    /* Non-Git projects still have the conservative workspace write fence. */
  }
  return plan;
}
export function redactCommand(
  binding: BackgroundOwnerBinding,
  command: string,
): string {
  for (const [key, value] of Object.entries(process.env))
    if (value && SENSITIVE_KEY.test(key)) binding.redactor.add(value);
  for (const match of command.matchAll(
    /(?:--?(?:password|token|secret|api[-_]?key)\s+|(?:password|token|secret|api[-_]?key)=)("[^"]*"|'[^']*'|[^\s;]+)/gi,
  )) {
    const value = match[1];
    if (value) binding.redactor.add(value.replace(/^["']|["']$/g, ""));
  }
  return terminalSafeText(
    binding.redactor.text(command),
    BACKGROUND_LIMITS.commandBytes,
  );
}
export async function recheckShell(item: ShellPolicyTarget): Promise<void> {
  const { binding } = item;
  binding.assertAvailable();
  cancelled(binding.signal);
  const [global, origin, actual] = await Promise.all([
    loadGlobalConfig(binding.configPath),
    loadProjectConfig(binding.origin ?? item.owner.binding.root),
    loadProjectConfig(item.data.actualRoot),
  ]);
  const config = effectiveBackgroundConfig(
    global.backgroundTasks,
    origin.backgroundTasks,
  );
  if (!config.enabled || actual.backgroundTasks?.enabled === false)
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Фоновые задачи отключены; команда не запускается.",
    );
  const deniedConfig = {
    ...origin,
    deniedCommands: [...origin.deniedCommands, ...actual.deniedCommands],
  };
  const policy = new PermissionPolicy(deniedConfig, {
    approvalMode: "default",
    autoApprove: false,
    nonInteractive: true,
    allowedTools: new Set(),
    allowBypassPermissions: false,
  });
  if (
    policy.decide(
      { tool: "run_shell", command: item.data.command, preview: "" },
      "process",
    ) === "deny"
  )
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Команда запрещена текущими правилами проекта.",
    );
  const previousPolicy = new PermissionPolicy(binding.config, {
    approvalMode: "default",
    autoApprove: false,
    nonInteractive: true,
    allowedTools: new Set(),
    allowBypassPermissions: false,
  });
  const request = {
    tool: "run_shell",
    command: item.data.command,
    preview: "",
  };
  if (
    previousPolicy.decide(request, "process") === "allow" &&
    policy.decide(request, "process") !== "allow"
  )
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Правило разрешённой команды сужено; требуется новое разрешение.",
    );
  if (
    item.context.approvalMode === "bypassPermissions" &&
    !global.permissions?.allowBypassPermissions
  )
    throw new RuntimeError(
      "PERMISSION_DENIED",
      "Bypass отключён; фоновая команда останавливается.",
    );
  binding.global = global;
  binding.config = {
    ...origin,
    backgroundTasks: effectiveBackgroundConfig(
      effectiveBackgroundConfig(global.backgroundTasks, origin.backgroundTasks),
      actual.backgroundTasks,
    ),
  };
  const outputCeiling = Math.min(
    config.outputBytes,
    actual.backgroundTasks?.outputBytes ?? config.outputBytes,
  );
  if (!item.record.foreground && outputCeiling < item.record.outputLimit) {
    if (item.record.outputBytes > outputCeiling)
      throw new RuntimeError("BACKGROUND_LIMIT", "Лимит вывода сужен.");
    item.record.outputLimit = outputCeiling;
    item.log?.narrowLimit(outputCeiling);
  }
  const duration =
    item.record.kind === "service"
      ? config.serviceDeadlineMs
      : config.batchDeadlineMs;
  if (
    !item.record.foreground &&
    Date.now() >= Date.parse(item.record.acceptedAt) + duration
  )
    throw new RuntimeError(
      "TOOL_TIMEOUT",
      "Текущий лимит времени задачи истёк.",
    );
  if (Date.now() >= Date.parse(item.record.deadline))
    throw new RuntimeError("TOOL_TIMEOUT", "Срок задачи истёк до запуска.");
}
