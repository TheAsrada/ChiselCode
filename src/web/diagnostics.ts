import { DEFAULT_PROJECT_CONFIG } from "../config/load.js";
import { ApprovalGate, type ApprovalResolver } from "../security/approval.js";
import { createSession } from "../sessions/store.js";
import { createLocalToolRuntime } from "../tools/local-runtime.js";
import type { ProjectConfig, ToolExecutionResult } from "../types/domain.js";
import type { WebToolProvider } from "./provider.js";

/** Diagnostics use the same catalog, preview, policy and executor as an agent turn. */
export async function testWebAccess(
  provider: WebToolProvider,
  root: string,
  requests: { url?: string; query?: string },
  options: {
    allow?: string[];
    approvalMode?: import("../security/approval-mode.js").ApprovalModeInput;
    allowBypassPermissions?: boolean;
    project?: ProjectConfig;
    signal?: AbortSignal;
    resolver?: ApprovalResolver;
    artifactDirectory?: string;
  } = {},
): Promise<Array<{ tool: string; result: ToolExecutionResult }>> {
  const session = createSession(root, "diagnostic", "web-test");
  const project = options.project ?? DEFAULT_PROJECT_CONFIG;
  const gate = new ApprovalGate(
    project,
    {
      autoApprove: false,
      approvalMode: options.approvalMode,
      allowBypassPermissions: options.allowBypassPermissions,
      allowedTools: new Set(options.allow ?? []),
      nonInteractive: !options.resolver,
      network: { scope: `${root}:${session.id}`, config: provider.config },
    },
    options.resolver ?? { requestApproval: async () => "unavailable" },
  );
  const tools = createLocalToolRuntime(
    root,
    project.ignorePatterns,
    gate,
    session,
    [],
    {
      signal: options.signal,
      mode: "plan",
      artifactDirectory: options.artifactDirectory,
      sanitizeResult: (result) => provider.redactor.value(result),
      sanitizeApproval: (request) => provider.redactor.value(request),
    },
  );
  await tools.catalog.addProvider(provider);
  const results: Array<{ tool: string; result: ToolExecutionResult }> = [];
  for (const [tool, input] of [
    ...(requests.query
      ? [["web_search", { query: requests.query, limit: 3 }] as const]
      : []),
    ...(requests.url
      ? [["web_fetch", { url: requests.url, maxChars: 2000 }] as const]
      : []),
  ]) {
    const result = await tools.executor.execute(
      { id: `diagnostic-${results.length}`, name: tool, input },
      options.signal,
    );
    results.push({ tool, result });
    if (result.requiresApproval || result.errorCode === "CANCELLED") break;
  }
  return results;
}
