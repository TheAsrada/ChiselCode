import { createHash } from "node:crypto";
import { allowsToolInMode, DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { ApprovalGate } from "../security/approval.js";
import { initializeSessionState } from "../sessions/migrations.js";
import type { ToolCall, ToolExecutionResult } from "../types/domain.js";
import type { ToolCatalog } from "./catalog.js";
import { canonicalInput, type ToolInvocationRecord } from "./invocation.js";
import { failure, normalizeResult } from "./result.js";
import type { ToolContext } from "./types.js";

export class ToolExecutor {
  private inFlight = new Map<string, Promise<ToolExecutionResult>>();
  constructor(
    readonly catalog: ToolCatalog,
    private readonly gate: ApprovalGate,
    readonly context: ToolContext,
    private readonly maxInlineTokens = 10_000,
  ) {
    initializeSessionState(context.session);
  }
  async execute(
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const fingerprint = createHash("sha256")
      .update(`${call.name}:${canonicalInput(call.input)}`)
      .digest("hex");
    const record = this.context.session.runtime?.invocations[call.id];
    if (!call.id || (record && record.fingerprint !== fingerprint))
      return failure(
        new RuntimeError(
          "PROTOCOL_ERROR_DUPLICATE_CALL_ID",
          "Tool call ID was reused with different input.",
        ),
      );
    if (record?.result && record.state !== "awaiting_approval")
      return record.result;
    const ongoing = this.inFlight.get(call.id);
    if (ongoing) return ongoing;
    const task = this.perform(call, fingerprint, signal);
    this.inFlight.set(call.id, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(call.id);
    }
  }
  private async perform(
    call: ToolCall,
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const context = { ...this.context, signal: signal ?? this.context.signal };
    const runtime = context.session.runtime;
    if (!runtime) throw new Error("Session runtime missing.");
    let record = runtime.invocations[call.id];
    if (record?.state === "running") {
      record.result = failure(
        new RuntimeError(
          "INTERRUPTED_INVOCATION",
          "Execution was interrupted. Inspect the workspace before retrying with a new call ID; mutations are not replayed.",
        ),
      );
      record.state = "failed";
      await context.checkpoint();
      return record.result;
    }
    record ??= {
      id: call.id,
      name: call.name,
      input: structuredClone(call.input),
      fingerprint,
      state: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    runtime.invocations[call.id] = record;
    const started = performance.now();
    let outputLimit = this.maxInlineTokens;
    try {
      cancelled(context.signal);
      await context.events.emit({
        type: "tool_queued",
        invocationId: call.id,
        name: call.name,
        input: call.input,
        state: "queued",
      });
      const handler = this.catalog.get(call.name);
      const mode =
        context.mode ??
        context.session.runtime?.turnMode ??
        context.session.mode ??
        DEFAULT_AGENT_MODE;
      if (!allowsToolInMode(mode, handler.spec.effect))
        throw new RuntimeError(
          "MODE_RESTRICTION",
          "Plan mode permits only read-only tools. Switch to Build using Shift+Tab or /build before requesting changes or shell execution.",
        );
      outputLimit =
        handler.spec.outputPolicy?.maxInlineTokens ?? this.maxInlineTokens;
      let input: unknown;
      try {
        input = handler.parse(call.input);
      } catch (error) {
        throw new RuntimeError("INVALID_TOOL_INPUT", String(error));
      }
      const failed = runtime.failedCalls[fingerprint];
      if (
        failed &&
        failed.count >= 3 &&
        failed.workspaceVersion === (runtime.workspaceVersion ?? 0)
      )
        throw new RuntimeError(
          "REPEATED_CALL_DETECTED",
          "Three identical calls failed without a workspace change. Read fresh evidence or choose a different strategy.",
        );
      const plan = await handler.prepare(context, input);
      record.state = "prepared";
      await context.events.emit({
        type: "tool_prepared",
        invocationId: call.id,
        name: call.name,
        state: "prepared",
      });
      const request = {
        tool: call.name,
        preview: plan.preview,
        command: plan.command,
        fileDiff: plan.diffs?.[0],
        diffs: plan.diffs,
      };
      const approvalMode =
        context.approvalMode ??
        runtime.turnApprovalMode ??
        context.session.approvalMode ??
        this.gate.policy.approvalMode;
      const permission =
        handler.spec.effect === "workspace_write" &&
        plan.diffs?.length === 0 &&
        plan.resources.length === 0
          ? "allow"
          : this.gate.policy.decide(request, handler.spec.effect, approvalMode);
      if (permission === "deny")
        throw new RuntimeError(
          "PERMISSION_DENIED",
          "Action denied by permission policy.",
        );
      if (permission === "ask") {
        record.state = "awaiting_approval";
        record.approvalPreview = plan.preview;
        await context.events.emit({
          type: "turn_state",
          state: "awaiting_approval",
        });
        await context.checkpoint();
        await context.events.emit({
          type: "tool_approval_requested",
          invocationId: call.id,
          name: call.name,
          state: "awaiting_approval",
          text: plan.preview,
        });
        const decision = await abortable(
          this.gate.resolve(request),
          context.signal,
        );
        if (decision === "unavailable")
          return {
            output:
              "APPROVAL_UNAVAILABLE: approval is pending; resume interactively to continue.",
            requiresApproval: true,
            preview: plan.preview,
            errorCode: "APPROVAL_UNAVAILABLE",
          };
        if (decision !== "approved")
          throw new RuntimeError(
            "PERMISSION_DENIED",
            "User denied this action.",
          );
      }
      cancelled(context.signal);
      await context.events.emit({
        type: "turn_state",
        state: "executing_tools",
      });
      record.state = "running";
      record.updatedAt = new Date().toISOString();
      await context.checkpoint();
      await context.events.emit({
        type: "tool_started",
        invocationId: call.id,
        name: call.name,
        input: call.input,
        state: "running",
      });
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(),
        handler.spec.timeoutMs ?? 610_000,
      );
      let result: ToolExecutionResult;
      try {
        if (
          permission === "allow" &&
          approvalMode === "bypassPermissions" &&
          !this.gate.policy.bypassAllowed &&
          this.gate.policy.decide(
            request,
            handler.spec.effect,
            approvalMode,
          ) !== "allow"
        )
          throw new RuntimeError(
            "PERMISSION_DENIED",
            "Bypass was disabled before execution. Retry under Manual permissions.",
          );
        result = await handler.execute(
          {
            ...context,
            signal: context.signal
              ? AbortSignal.any([context.signal, timeout.signal])
              : timeout.signal,
          },
          plan,
        );
      } catch (error) {
        if (context.signal?.aborted)
          throw new RuntimeError("CANCELLED", "Tool execution cancelled.");
        if (timeout.signal.aborted)
          throw new RuntimeError("TOOL_TIMEOUT", "Tool execution timed out.");
        throw error;
      } finally {
        clearTimeout(timer);
      }
      if (timeout.signal.aborted)
        throw new RuntimeError("TOOL_TIMEOUT", "Tool execution timed out.");
      result = await normalizeResult(
        result,
        context.artifacts,
        handler.spec.outputPolicy?.maxInlineTokens ?? this.maxInlineTokens,
      );
      record.result = result;
      record.state = result.isError ? "failed" : "succeeded";
      if (handler.spec.effect !== "read" && !result.isError) {
        runtime.workspaceVersion = (runtime.workspaceVersion ?? 0) + 1;
        await context.events.emit({
          type: "workspace_changed",
          invocationId: call.id,
          name: call.name,
          result,
        });
      }
      this.failureCount(record, fingerprint);
      record.updatedAt = new Date().toISOString();
      await context.checkpoint();
      await context.events.emit({
        type: result.isError ? "tool_failed" : "tool_completed",
        invocationId: call.id,
        name: call.name,
        result,
        state: record.state,
        durationMs: performance.now() - started,
      });
      return result;
    } catch (error) {
      let result = failure(error);
      try {
        result = await normalizeResult(result, context.artifacts, outputLimit);
      } catch {
        result = {
          ...result,
          output: `${result.errorCode}: Error artifact unavailable. ${result.output.slice(0, Math.max(0, outputLimit * 2 - 100))}`,
        };
      }
      record.result = result;
      record.state =
        result.errorCode === "CANCELLED"
          ? "cancelled"
          : result.errorCode === "PERMISSION_DENIED" ||
              result.errorCode === "MODE_RESTRICTION"
            ? "denied"
            : "failed";
      record.updatedAt = new Date().toISOString();
      this.failureCount(record, fingerprint);
      await context.checkpoint();
      await context.events.emit({
        type: "tool_failed",
        invocationId: call.id,
        name: call.name,
        result,
        errorCode: result.errorCode,
        state: record.state,
        durationMs: performance.now() - started,
      });
      return result;
    }
  }
  private failureCount(
    record: ToolInvocationRecord,
    fingerprint: string,
  ): void {
    const runtime = this.context.session.runtime;
    if (!runtime) return;
    if (record.state === "failed") {
      const previous = runtime.failedCalls[fingerprint];
      const version = runtime.workspaceVersion ?? 0;
      runtime.failedCalls[fingerprint] = {
        count: previous?.workspaceVersion === version ? previous.count + 1 : 1,
        workspaceVersion: version,
      };
    } else if (record.state === "succeeded")
      delete runtime.failedCalls[fingerprint];
  }
}
async function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  cancelled(signal);
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        abort = () =>
          reject(
            new RuntimeError(
              "CANCELLED",
              "Operation cancelled while awaiting approval.",
            ),
          );
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
