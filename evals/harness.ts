import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { DEFAULT_PROJECT_CONFIG } from "../src/config/load.js";
import { AgentLoop } from "../src/core/agent-loop.js";
import { ApprovalGate } from "../src/security/approval.js";
import { createSession } from "../src/sessions/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type {
  AgentResult,
  ProviderAdapter,
  StreamEvent,
  ToolName,
} from "../src/types/domain.js";
import { scanGlob } from "../src/utils/fs-scan.js";
import { resolveProjectPath } from "../src/utils/paths.js";
import { grade } from "./graders/index.js";
import type { EvalTask } from "./task-schema.js";
import { emptyMetrics, type TrialReport } from "./trial.js";

export async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for await (const path of scanGlob("**/*", { cwd: root, onlyFiles: true })) {
    if (path.startsWith("node_modules/")) continue;
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
      model_parameters: {},
      resources: "host (no CPU/RAM limit configured)",
    },
    tests_before: [],
    tests_after: [],
    metrics,
    trace: [],
  };
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
      result = (
        await runPrompt(
          task.prompt,
          {
            cwd: root,
            model,
            provider: provider as ProviderAdapter["kind"],
            yes: true,
          },
          { requestApproval: async () => "approved" },
          {
            onText: (text) => report.trace.push({ type: "text", text }),
            onThinking: () => {},
            onToolStart: (name, input) => {
              metrics.tool_call_count++;
              report.trace.push({ type: "tool_started", name, input });
            },
            onToolResult: (name, outcome) => {
              if (outcome.isError) metrics.tool_error_count++;
              report.trace.push({ type: "tool_completed", name, outcome });
            },
          },
          abort.signal,
        )
      ).result;
    } else {
      let turn = 0;
      const adapter: ProviderAdapter = {
        kind: "anthropic",
        listModels: async () => [],
        countTokens: async () => 0,
        async *streamChat(request): AsyncIterable<StreamEvent> {
          metrics.provider_request_count++;
          metrics.turn_count++;
          report.trace.push({
            type: "provider_request",
            request: { ...request, signal: undefined },
          });
          const call = task.mockCalls[turn++];
          yield {
            type: "turn_complete",
            stopReason: call ? "tool_use" : "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
            message: {
              role: "assistant",
              content: call
                ? [
                    {
                      type: "tool_use",
                      id: `eval-${turn}`,
                      name: call.name as ToolName,
                      input: call.input,
                    },
                  ]
                : [{ type: "text", text: "Done" }],
            },
          };
        },
      };
      const session = createSession(root, "anthropic", model);
      const tools = new ToolRegistry(
        root,
        DEFAULT_PROJECT_CONFIG.ignorePatterns,
        new ApprovalGate(
          DEFAULT_PROJECT_CONFIG,
          { autoApprove: true, allowedTools: new Set(), nonInteractive: true },
          { requestApproval: async () => "approved" },
        ),
        session,
      );
      result = await new AgentLoop(
        adapter,
        tools,
        "Complete the task using evidence.",
        {
          onToolStart: (name, input) => {
            metrics.tool_call_count++;
            if (name === "read_file")
              metrics.files_read.push(String(input.path));
            report.trace.push({ type: "tool_started", name, input });
          },
          onToolResult: (name, outcome) => {
            if (outcome.isError) metrics.tool_error_count++;
            metrics.tool_output_tokens += Math.ceil(outcome.output.length / 3);
            report.trace.push({ type: "tool_completed", name, outcome });
          },
        },
      ).run(session, task.prompt, { signal: abort.signal });
    }
    report.tests_after = await grade(task, root, abort.signal);
    const after = await snapshot(root);
    metrics.files_changed = [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].filter((path) => before[path] !== after[path]);
    metrics.input_tokens = result.session.totalTokens.inputTokens;
    metrics.output_tokens = result.session.totalTokens.outputTokens;
    metrics.cache_read_tokens = result.session.totalTokens.cacheReadTokens ?? 0;
    metrics.cache_write_tokens =
      result.session.totalTokens.cacheCreationTokens ?? 0;
    metrics.estimated_cost = result.session.totalCost;
    report.status =
      result.status === "completed" &&
      report.tests_after.every((entry) => (entry as { pass: boolean }).pass) &&
      !metrics.files_changed.some((path) =>
        task.constraints.forbidden_paths.includes(path),
      )
        ? "success"
        : "failure";
    report.task_success = report.status === "success";
    report.error = result.error;
  } catch (error) {
    report.error = String(error);
  } finally {
    clearTimeout(timer);
    metrics.wall_time = performance.now() - start;
    await rm(root, { recursive: true, force: true });
  }
  return report;
}
