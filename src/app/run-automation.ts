import { backgroundActive } from "../background/contracts.js";
import { loadGlobalConfig, loadProjectConfig } from "../config/load.js";
import type { AutomationDispatch } from "../extensions/automations.js";
import type { WorkspaceExtensionScope } from "../extensions/host.js";
import type { AgentMode } from "../runtime/agent-mode.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { RuntimeEventBus } from "../runtime/events.js";
import type { ApprovalResolver } from "../security/approval.js";
import { resolveApprovalMode } from "../security/approval-mode.js";
import { projectSessionStore } from "../sessions/project-store.js";
import { createSession } from "../sessions/store.js";
import { acquireExecutionLease } from "./execution-lease.js";
import type { RunOptions } from "./run-prompt.js";
import { createSessionToolRuntime } from "./tool-runtime.js";

export function automationDispatcher(
  scope: WorkspaceExtensionScope,
  options: Pick<RunOptions, "configPath">,
  current: () => { mode: AgentMode; resolver: ApprovalResolver },
): AutomationDispatch {
  return {
    async reserve() {
      try {
        return await acquireExecutionLease(scope.workspaceRoot);
      } catch (error) {
        if (error instanceof RuntimeError && error.code === "WORKSPACE_BUSY")
          return;
        throw error;
      }
    },
    async execute({ owner, definition, runId, signal }) {
      const root = scope.workspaceRoot;
      const { mode, resolver } = current();
      const [global, config, store] = await Promise.all([
        loadGlobalConfig(options.configPath),
        loadProjectConfig(root),
        projectSessionStore(root),
      ]);
      cancelled(signal);
      const session = createSession(root, "local", "");
      session.title = `Автоматизация ${owner.extensionId} / ${definition.id}`;
      session.mode = mode;
      const approvalMode = resolveApprovalMode({
        autoApprove: config.autoApprove,
      });
      session.approvalMode = approvalMode;
      const events = new RuntimeEventBus(session.id, runId);
      const tools = await createSessionToolRuntime({
        root,
        scope,
        session,
        store,
        config,
        global,
        mode,
        approvalMode,
        options: { ...options, interactive: true },
        resolver,
        events,
        signal,
        extensionActivation: owner,
        // The run owns its own background binding. Revoke it explicitly after cleanup.
        backgroundOwner: { signal: owner.signal, childLabel: session.title },
      });
      try {
        const handler = tools.catalog.get(definition.tool.name);
        if (
          handler.spec.source?.type !== "local" &&
          handler.extensionActivation !== owner
        )
          throw new Error("Инструмент недоступен для этой автоматизации.");
        const result = await tools.executor.execute(
          {
            id: runId,
            name: definition.tool.name,
            input: structuredClone(definition.tool.input),
          },
          signal,
        );
        if (signal.aborted) return { status: "cancelled" };
        if (result.isError || result.requiresApproval)
          return {
            status: "failed",
            result: result.errorCode ?? "Требуется подтверждение",
          };
        const background = result.details?.backgroundTask;
        const port = tools.context.background?.port;
        if (
          port &&
          background &&
          typeof background === "object" &&
          "id" in background &&
          typeof background.id === "string"
        ) {
          let task = await port.status(background.id);
          while (backgroundActive(task.state)) {
            const [status] = await port.wait([task.id], undefined, signal);
            if (!status) throw new Error("Фоновая задача недоступна.");
            task = status;
          }
          return {
            status: task.state === "completed" ? "succeeded" : "failed",
            result: task.state,
          };
        }
        return { status: "succeeded" };
      } finally {
        try {
          await tools.backgrounds?.closeOwner(session.id);
        } finally {
          await tools.dispose();
        }
      }
    },
  };
}
