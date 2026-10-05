import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { DEFAULT_PROJECT_CONFIG } from "../src/config/load.js";
import { ContextManager } from "../src/context/context-manager.js";
import { BASE_SYSTEM_PROMPT } from "../src/core/prompt.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { RuntimeEventBus } from "../src/runtime/events.js";
import { ApprovalGate } from "../src/security/approval.js";
import { createSession } from "../src/sessions/store.js";
import { createLocalToolRuntime } from "../src/tools/local-runtime.js";
import type {
  AgentResult,
  ProviderAdapter,
  StreamEvent,
} from "../src/types/domain.js";
import { scanGlob } from "../src/utils/fs-scan.js";
import { matchesPattern, resolveProjectPath } from "../src/utils/paths.js";
import { WebToolProvider } from "../src/web/provider.js";
import { startHostedSearchFixture } from "../tests/fixtures/mcp-search.js";
import { startWebFixture } from "../tests/fixtures/web-http.js";
import { grade } from "./graders/index.js";
import { writeTrialProviderConfig } from "./provider-profile.js";
import type { EvalTask } from "./task-schema.js";
import { traceRecorder } from "./trace-recorder.js";
import { emptyMetrics, type TrialReport } from "./trial.js";

export async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for await (const path of scanGlob("**/*", { cwd: root, onlyFiles: true })) {
    if (
      ["node_modules/", ".git/", ".chisel/"].some((prefix) =>
        path.startsWith(prefix),
      )
    )
      continue;
    const safe = await resolveProjectPath(root, path);
    result[path] = createHash("sha256")
      .update(await readFile(safe))
      .digest("hex");
  }
  return result;
}

export async function runTrial(
  task: EvalTask,
  trial: number,
  mode: "mock" | "live" = "mock",
  model = "scripted",
  provider = "anthropic",
  profileId?: string,
): Promise<TrialReport> {
  const root = await mkdtemp(join(tmpdir(), "chisel-eval-"));
  const start = performance.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), task.timeout * 1000);
  const metrics = emptyMetrics();
  const report: TrialReport = {
    task: task.id,
    trial,
    status: "infra_error",
    task_success: false,
    model,
    provider,
    environment: {
      fixture_hash: "",
      chisel_commit: "",
      bun: Bun.version,
      platform: process.platform,
      network: mode === "mock" ? "no model network" : "host network",
      timeout: task.timeout,
      model_parameters: task.context ? { context: task.context } : {},
      resources: "host (no CPU/RAM limit configured)",
    },
    tests_before: [],
    tests_after: [],
    metrics,
    trace: [],
  };
  const record = traceRecorder(report);
  let webFixture: Awaited<ReturnType<typeof startWebFixture>> | undefined;
  let hostedSearchFixture:
    | Awaited<ReturnType<typeof startHostedSearchFixture>>
    | undefined;
  try {
    const fixture = await resolveProjectPath(
      join(import.meta.dir, "fixtures"),
      task.fixture,
    );
    await cp(fixture, root, { recursive: true, dereference: false });
    report.environment.chisel_commit = (
      await execa("git", ["rev-parse", "HEAD"], { cwd: import.meta.dir })
    ).stdout;
    report.environment.fixture_hash = createHash("sha256")
      .update(JSON.stringify(await snapshot(root)))
      .digest("hex");
    for (const command of task.setup)
      await execa(command, {
        cwd: root,
        shell: true,
        cancelSignal: abort.signal,
      });
    const before = await snapshot(root);
    report.tests_before = await grade(task, root, abort.signal);
    let result: AgentResult;
    if (mode === "live") {
      const { runPrompt } = await import("../src/commands/run.js");
      const configPath = join(root, ".chisel", "eval-config.json");
      await writeTrialProviderConfig(configPath, provider, model, profileId);
      result = (
        await runPrompt(
          task.prompt,
          {
            cwd: root,
            model,
            provider: provider,
            profile: "eval-trial",
            configPath,
            yes: true,
          },
          { requestApproval: async () => "approved" },
          {
            onEvent: record,
            onText: () => {},
            onThinking: () => {},
            onToolStart: () => {},
            onToolResult: () => {},
          },
          abort.signal,
        )
      ).result;
    } else {
      let turn = 0;
      const adapter: ProviderAdapter = {
        kind: "anthropic",
        providerId: "anthropic",
        listModels: async () => [],
        countTokens: async () => 0,
        async *streamChat(request): AsyncIterable<StreamEvent> {
          report.trace.push({
            type: "provider_request",
            request: { ...request, signal: undefined },
          });
          const calls =
            task.mockTurns?.[turn++] ??
            (task.mockTurns
              ? []
              : task.mockCalls[turn]
                ? [task.mockCalls[turn++]]
                : []);
          yield {
            type: "turn_complete",
            stopReason: calls.length ? "tool_use" : "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
            message: {
              role: "assistant",
              content: calls.length
                ? calls.map((call, index) => ({
                    type: "tool_use" as const,
                    id: `eval-${turn}-${index}`,
                    name: call?.name ?? "",
                    input: call?.input ?? {},
                  }))
                : [{ type: "text", text: "Done" }],
            },
          };
        },
      };
      const session = createSession(root, "anthropic", model);
      session.messages = structuredClone(task.seedMessages);
      const events = new RuntimeEventBus(session.id);
      events.subscribe(record);
      if (task.webFixture) webFixture = await startWebFixture();
      if (task.webFixture && task.webSearchBackend !== "brave")
        hostedSearchFixture = await startHostedSearchFixture(
          task.webSearchBackend,
        );
      const tools = createLocalToolRuntime(
        root,
        DEFAULT_PROJECT_CONFIG.ignorePatterns,
        new ApprovalGate(
          DEFAULT_PROJECT_CONFIG,
          // Execution evals explicitly opt in; permission modes have separate regression tests.
          {
            approvalMode: "bypassPermissions",
            allowBypassPermissions: true,
            autoApprove: false,
            allowedTools: new Set(),
            nonInteractive: true,
            network: webFixture
              ? { scope: `${root}:${session.id}`, config: webFixture.config }
              : undefined,
          },
          { requestApproval: async () => "approved" },
        ),
        session,
        [],
        {
          events,
          signal: abort.signal,
          maxInlineTokens: task.context?.maxInlineToolResultTokens,
          artifactDirectory: join(root, ".chisel", "artifacts"),
        },
      );
      if (webFixture)
        await tools.catalog.addProvider(
          hostedSearchFixture
            ? new WebToolProvider(
                webFixture.config,
                webFixture.client,
                hostedSearchFixture.backend,
              )
            : webFixture.provider,
        );
      result = await new AgentRuntime(
        adapter,
        new ContextManager(task.context, events),
        {
          selectForTurn: () => tools.catalog.selectForTurn(),
          instructionsForTurn: (selected) =>
            tools.catalog.instructionsForTurn(selected),
          execute: (calls, signal) => tools.scheduler.execute(calls, signal),
        },
        BASE_SYSTEM_PROMPT,
        events,
      ).run(session, task.prompt, { signal: abort.signal });
    }
    if (abort.signal.aborted)
      throw new Error("Eval runner timeout (infrastructure)");
    report.tests_after = await grade(task, root, abort.signal, report.trace);
    const after = await snapshot(root);
    metrics.files_changed = [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].filter((path) => before[path] !== after[path]);
    metrics.input_tokens = result.session.totalTokens.inputTokens;
    metrics.output_tokens = result.session.totalTokens.outputTokens;
    metrics.cache_read_tokens = result.session.totalTokens.cacheReadTokens ?? 0;
    metrics.cache_write_tokens =
      result.session.totalTokens.cacheCreationTokens ?? 0;
    metrics.estimated_cost =
      result.session.costEstimate?.source === "unknown"
        ? undefined
        : (result.session.costEstimate?.usd ?? result.session.totalCost);
    report.status =
      result.status === "completed" &&
      report.tests_after.every((entry) => (entry as { pass: boolean }).pass) &&
      !metrics.files_changed.some((path) =>
        task.constraints.forbidden_paths.some(
          (pattern) =>
            matchesPattern(path, pattern) || path.startsWith(`${pattern}/`),
        ),
      )
        ? "success"
        : "failure";
    if (
      [
        "authentication",
        "model_not_found",
        "transport",
        "rate_limit",
        "timeout",
      ].includes(result.errorCode ?? "")
    )
      report.status = "infra_error";
    if (
      metrics.files_changed.some((path) =>
        task.constraints.forbidden_paths.some(
          (pattern) =>
            matchesPattern(path, pattern) || path.startsWith(`${pattern}/`),
        ),
      ) ||
      report.tests_after.some(
        (entry) =>
          (entry as { safety?: boolean; pass: boolean }).safety &&
          !(entry as { pass: boolean }).pass,
      )
    )
      report.status = "safety_violation";
    if (
      report.status !== "safety_violation" &&
      task.webFixture &&
      report.trace.some(
        (entry) =>
          (entry as { type?: string; result?: { errorCode?: string } }).type ===
            "tool_failed" &&
          [
            "WEB_TIMEOUT",
            "WEB_FETCH_FAILED",
            "WEB_SEARCH_FAILED",
            "WEB_PROTOCOL_ERROR",
            "WEB_HTTP_ERROR",
            "WEB_RATE_LIMITED",
            "WEB_NETWORK_CONFIGURATION",
          ].includes(
            (entry as { result?: { errorCode?: string } }).result?.errorCode ??
              "",
          ),
      )
    )
      report.status = "infra_error";
    report.task_success = report.status === "success";
    report.error = result.error;
  } catch (error) {
    report.error = String(error);
  } finally {
    clearTimeout(timer);
    await hostedSearchFixture?.close();
    await webFixture?.close();
    metrics.wall_time = performance.now() - start;
    await rm(root, { recursive: true, force: true });
  }
  return report;
}
