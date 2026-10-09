import { worktreeServiceToken } from "../extensions/builtins/worktrees.js";
import type { WorkspaceExtensionScope } from "../extensions/host.js";
import { attachExtensionTools } from "../extensions/tools.js";
import { McpConnectionManager } from "../mcp/manager.js";
import { McpRuntimeBinding } from "../mcp/runtime.js";
import { McpConfigStore } from "../mcp/storage.js";
import type { AgentMode } from "../runtime/agent-mode.js";
import type { RuntimeEventBus } from "../runtime/events.js";
import { ApprovalGate, type ApprovalResolver } from "../security/approval.js";
import type { ApprovalMode } from "../security/approval-mode.js";
import type { projectSessionStore } from "../sessions/project-store.js";
import { loadSkills } from "../skills/skills.js";
import { createLocalToolRuntime } from "../tools/local-runtime.js";
import type { GlobalConfig, ProjectConfig, Session } from "../types/domain.js";
import { createWebToolProvider } from "../web/provider.js";
import { resolveWebConfig } from "../web/schema.js";
import type { RunOptions } from "./run-prompt.js";

/** Shared composition for model turns and deterministic commands; no model adapter. */
export async function createSessionToolRuntime(input: {
  root: string;
  session: Session;
  store: Awaited<ReturnType<typeof projectSessionStore>>;
  config: ProjectConfig;
  global: GlobalConfig;
  options: RunOptions;
  mode: AgentMode;
  approvalMode: ApprovalMode;
  scope: WorkspaceExtensionScope;
  events: RuntimeEventBus;
  resolver: ApprovalResolver;
  signal: AbortSignal;
  sanitizeExtra?: <T>(value: T) => T;
}) {
  const {
    root,
    session,
    store,
    config,
    global,
    options,
    mode,
    approvalMode,
    scope,
    events,
    resolver,
    signal,
  } = input;
  const web = await createWebToolProvider(
    resolveWebConfig(global.web, config.web),
  );
  const mcp =
    global.mcp || config.mcp || options.mcpManager?.list().length
      ? (options.mcpManager ??
        new McpConnectionManager(
          new McpConfigStore(root, { globalPath: options.configPath }),
        ))
      : undefined;
  const sanitize = <T>(value: T): T => {
    const clean = web.redactor.value(mcp ? mcp.redactor.value(value) : value);
    return input.sanitizeExtra?.(clean) ?? clean;
  };
  events.sanitize = sanitize;
  const saveCheckpoint = () => {
    session.messages = sanitize(session.messages);
    if (session.title) session.title = sanitize(session.title);
    if (session.context?.activeCheckpoint)
      Object.assign(
        session.context.activeCheckpoint.summary,
        sanitize(session.context.activeCheckpoint.summary),
      );
    for (const record of Object.values(session.runtime?.invocations ?? {})) {
      record.input = sanitize(record.input);
      if (record.toolSource) record.toolSource = sanitize(record.toolSource);
      if (record.result) record.result = sanitize(record.result);
      if (record.approvalPreview)
        record.approvalPreview = sanitize(record.approvalPreview);
    }
    return store.save(session);
  };
  let mcpBinding: McpRuntimeBinding | undefined;
  let extensionBinding:
    | import("../extensions/contracts.js").Disposable
    | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= (async () => {
      const failures: unknown[] = [];
      for (const cleanup of [
        () => extensionBinding?.dispose(),
        () => mcpBinding?.dispose(),
        () => (mcp && !options.mcpManager ? mcp.dispose() : undefined),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Tool resource cleanup failed; all cleanup operations were attempted.",
        );
    })());
  try {
    const gate = new ApprovalGate(
      config,
      {
        autoApprove: Boolean(options.yes),
        approvalMode,
        allowBypassPermissions: () =>
          global.permissions?.allowBypassPermissions === true &&
          (options.isBypassAllowed?.() ?? true),
        allowedTools: new Set(
          (options.allow ?? "")
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        ),
        nonInteractive:
          options.interactive === undefined
            ? !process.stdin.isTTY
            : !options.interactive,
        network: {
          scope: `${root}:${session.id}`,
          config: () =>
            resolveWebConfig(
              options.getWebConfig?.() ?? global.web,
              config.web,
            ),
        },
      },
      resolver,
    );
    const skills = loadSkills(root);
    const tools = createLocalToolRuntime(
      root,
      config.ignorePatterns,
      gate,
      session,
      skills,
      {
        events,
        mode,
        approvalMode,
        signal,
        maxInlineTokens: config.context?.maxInlineToolResultTokens,
        maxParallelReads: config.tools?.maxParallelReads,
        requireFreshRead: config.editing?.requireFreshRead,
        checkpoint: saveCheckpoint,
        sanitizeResult: sanitize,
        sanitizeApproval: sanitize,
        toolGuards: scope.toolGuards,
        worktrees: scope.services.lookup(worktreeServiceToken),
      },
    );
    await tools.catalog.addProvider(web);
    mcpBinding = mcp ? new McpRuntimeBinding(mcp, tools.catalog) : undefined;
    extensionBinding = await attachExtensionTools(scope, tools.catalog);
    return {
      ...tools,
      skills,
      sanitize,
      saveCheckpoint,
      dispose,
      refresh: () => mcpBinding?.refresh(signal) ?? Promise.resolve(),
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Tool setup and cleanup failed.",
      );
    }
    throw error;
  }
}
