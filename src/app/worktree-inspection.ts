import { randomUUID } from "node:crypto";
import { loadProjectConfig } from "../config/load.js";
import { worktreeServiceToken } from "../extensions/builtins/worktrees.js";
import type { WorkspaceExtensionScope } from "../extensions/host.js";
import { operationSignal } from "../extensions/lifecycle.js";
import { cancelled } from "../runtime/errors.js";
import { ApprovalGate } from "../security/approval.js";
import { SecretRedactor } from "../security/redaction.js";
import { createSession } from "../sessions/store.js";
import { createLocalToolRuntime } from "../tools/local-runtime.js";
import type { JsonObject } from "../types/domain.js";

/** Inspect through the same tool plans and leases without using the chat session. */
export async function runWorktreeInspection(
  scope: WorkspaceExtensionScope,
  action: "list" | "status" | "diff",
  input: JsonObject,
  operation: AbortSignal,
) {
  const signal = operationSignal(scope.signal, operation);
  cancelled(signal);
  const root = scope.workspaceRoot;
  const name = `ext:builtin.worktrees:${action}`;
  const [config, handler] = await Promise.all([
    loadProjectConfig(root),
    scope.tools.getHandler(name),
  ]);
  cancelled(signal);
  const gate = new ApprovalGate(
    config,
    { autoApprove: false, allowedTools: new Set(), nonInteractive: true },
    { requestApproval: async () => "unavailable" },
  );
  const redactor = new SecretRedactor();
  const runtime = createLocalToolRuntime(
    root,
    config.ignorePatterns,
    gate,
    createSession(root, "local", ""),
    [],
    {
      mode: "plan",
      signal,
      maxInlineTokens: config.context?.maxInlineToolResultTokens,
      sanitizeResult: (result) => redactor.value(result),
      toolGuards: scope.toolGuards,
      worktrees: scope.services.lookup(worktreeServiceToken),
    },
  );
  runtime.catalog.register(handler);
  return runtime.executor.execute({ id: randomUUID(), name, input });
}
