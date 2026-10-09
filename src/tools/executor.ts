import { createHash } from "node:crypto";
import type { ToolGuardPoint, ToolGuardPort } from "../extensions/contracts.js";
import { allowsToolInMode, DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import type { ApprovalGate } from "../security/approval.js";
import { initializeSessionState } from "../sessions/migrations.js";
import { authorizeSubagentPlan } from "../subagents/capability.js";
import type { ToolCall, ToolExecutionResult } from "../types/domain.js";
import {
  abandonWorktreePlan,
  authorizeWorktreePlan,
  subagentCreateOwnsRevalidation,
} from "../worktrees/capability.js";
import { executionAccess, preparationAccess } from "./access.js";
import type { ToolCatalog } from "./catalog.js";
import { changesWorkspace } from "./effects.js";
import { canonicalInput, type ToolInvocationRecord } from "./invocation.js";
import { failure, normalizeResult } from "./result.js";
import type { ToolContext, ToolPlan, ToolSource } from "./types.js";
import { workspaceCoordinator } from "./workspace-coordinator.js";

export class ToolExecutor {
  private inFlight = new Map<string, Promise<ToolExecutionResult>>();
  private workspaceScope?: Promise<string[]>;
  private observedWorkspaceRevision = 0;
  constructor(
    readonly catalog: ToolCatalog,
    private readonly gate: ApprovalGate,
    readonly context: ToolContext,
    private readonly maxInlineTokens = 10_000,
    private readonly toolGuards?: ToolGuardPort,
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
    if (!call.id || (record && record.fingerprint !== fingerprint)) {
      let source = record?.toolSource;
      if (!source) {
        try {
          source = this.catalog.get(call.name).spec.source;
        } catch {
          /* Unknown tools have no owner. */
        }
      }
      const result = attributed(
        failure(
          new RuntimeError(
            "PROTOCOL_ERROR_DUPLICATE_CALL_ID",
            "Tool call ID was reused with different input.",
          ),
        ),
        source,
      );
      return this.context.sanitizeResult?.(result) ?? result;
    }
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
    const context = {
      ...this.context,
      invocationId: call.id,
      signal:
        signal && this.context.signal
          ? AbortSignal.any([signal, this.context.signal])
          : (signal ?? this.context.signal),
    };
    const runtime = context.session.runtime;
    if (!runtime) throw new Error("Session runtime missing.");
    let record = runtime.invocations[call.id];
    if (record?.state === "running") {
      const interrupted = attributed(
        failure(
          new RuntimeError(
            "INTERRUPTED_INVOCATION",
            "Execution was interrupted. Inspect the workspace before retrying with a new call ID; mutations are not replayed.",
          ),
        ),
        record.toolSource,
      );
      record.result = context.sanitizeResult?.(interrupted) ?? interrupted;
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
    let preparedPlan: ToolPlan | undefined;
    try {
      cancelled(context.signal);
      const handler = this.catalog.get(call.name);
      record.toolSource = handler.spec.source;
      await context.executionConstraint?.beforePrepare(handler);
      if (handler.lifetimeSignal)
        context.signal = context.signal
          ? AbortSignal.any([context.signal, handler.lifetimeSignal])
          : handler.lifetimeSignal;
      cancelled(context.signal);
      await context.events.emit({
        type: "tool_queued",
        invocationId: call.id,
        name: call.name,
        input: call.input,
        state: "queued",
        toolSource: record.toolSource,
      });
      const writesWorkspace =
        changesWorkspace(handler.spec.effect) ||
        handler.spec.workspaceAccess === "write";
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
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError("INVALID_TOOL_INPUT", String(error));
      }
      this.workspaceScope ??= workspaceCoordinator.scope(
        context.workspace.root,
      );
      const scope = await this.workspaceScope;
      const preparation = await preparationAccess(
        handler,
        context,
        input,
        scope,
      );
      const preparedResources = preparation.map((access) => access.resource);
      const { plan, preparedRevision } = await workspaceCoordinator.withPlan(
        preparation,
        context.signal,
        async () => {
          this.observeWorkspace(scope);
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
          return {
            plan: await handler.prepare(context, input),
            preparedRevision: workspaceCoordinator.revision(preparedResources),
          };
        },
      );
      const accesses = await executionAccess(handler, context, plan, scope);
      preparedPlan = plan;
      const executionScope = [
        ...new Set(accesses.map((access) => access.resource)),
      ];
      record.state = "prepared";
      await context.events.emit({
        type: "tool_prepared",
        invocationId: call.id,
        name: call.name,
        state: "prepared",
        toolSource: record.toolSource,
      });
      const request = {
        owner: context.approvalOwner
          ? { ...context.approvalOwner, invocationId: call.id }
          : undefined,
        tool: call.name,
        source: handler.spec.source,
        preview: plan.preview,
        command: plan.command,
        fileDiff: plan.diffs?.[0],
        diffs: plan.diffs,
        mcp: plan.approval,
        mcpPermissions: handler.permissions?.(),
        network: plan.network,
      };
      const approvalMode =
        context.approvalMode ??
        runtime.turnApprovalMode ??
        context.session.approvalMode ??
        this.gate.policy.approvalMode;
      const guard = async (point: ToolGuardPoint) => {
        cancelled(context.signal);
        // The empty path does not build or clone snapshots.
        if (!this.toolGuards?.has(point)) return;
        await this.toolGuards.run(
          point,
          {
            callId: call.id,
            tool: {
              name: call.name,
              source: handler.spec.source ?? { type: "local" },
              effect: handler.spec.effect,
            },
            input: JSON.parse(canonicalInput(call.input)),
            preview: plan.preview,
            resources: executionScope,
            command: plan.command,
            diffs: plan.diffs,
            network: plan.network,
            sessionId: context.session.id,
            turnId: runtime.turnId,
            mode,
            approvalMode,
          },
          context.signal,
        );
      };
      await guard("tool.afterPrepare");
      cancelled(context.signal);
      const ownPermission =
        handler.spec.effect === "workspace_write" &&
        handler.spec.source?.type !== "extension" &&
        plan.diffs?.length === 0 &&
        plan.resources.length === 0
          ? "allow"
          : this.gate.policy.decide(request, handler.spec.effect, approvalMode);
      const ceiling =
        context.executionConstraint?.decision(request, handler) ?? "allow";
      const permission =
        ownPermission === "deny" || ceiling === "deny"
          ? "deny"
          : ownPermission === "ask" || ceiling === "ask"
            ? "ask"
            : "allow";
      if (permission === "deny")
        throw new RuntimeError(
          request.network ? "WEB_NETWORK_DENIED" : "PERMISSION_DENIED",
          "Action denied by permission policy.",
        );
      let networkApprovedOnce = false;
      if (permission === "ask") {
        const displayed = context.sanitizeApproval?.(request) ?? request;
        record.state = "awaiting_approval";
        record.approvalPreview = displayed.preview;
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
          text: displayed.preview,
          toolSource: record.toolSource,
        });
        const decision = await abortable(
          this.gate.resolve(displayed, {
            effect: handler.spec.effect,
            approvalMode,
            signal: context.signal,
          }),
          context.signal,
        );
        if (decision === "unavailable") {
          const pending = attributed(
            {
              output:
                "APPROVAL_UNAVAILABLE: approval is pending; resume interactively to continue.",
              requiresApproval: true,
              preview: displayed.preview,
              errorCode: "APPROVAL_UNAVAILABLE",
            },
            record.toolSource,
          );
          return context.sanitizeResult?.(pending) ?? pending;
        }
        if (
          decision !== "approved" &&
          decision !== "approved_always" &&
          decision !== "approved_session"
        )
          throw new RuntimeError(
            request.network ? "WEB_NETWORK_DENIED" : "PERMISSION_DENIED",
            "User denied this action.",
          );
        networkApprovedOnce = true;
        if (
          decision === "approved_always" &&
          request.mcp &&
          !request.mcp.destructive
        )
          await handler.rememberApproval?.();
      }
      await guard("tool.beforeExecute");
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
        toolSource: handler.spec.source,
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
        const executionSignal = context.signal
          ? AbortSignal.any([context.signal, timeout.signal])
          : timeout.signal;
        const execute = async () => {
          this.observeWorkspace(scope);
          await context.executionConstraint?.beforeExecute(handler);
          if (
            context.executionConstraint &&
            (context.executionConstraint.decision(request, handler) ===
              "deny" ||
              (permission === "allow" &&
                context.executionConstraint.decision(request, handler) ===
                  "ask"))
          )
            throw new RuntimeError(
              "PERMISSION_DENIED",
              "Права помощника отозваны до выполнения.",
            );
          if (
            (handler.spec.effect === "process" ||
              handler.spec.effect === "git_write") &&
            !subagentCreateOwnsRevalidation(plan) &&
            workspaceCoordinator.revision(preparedResources) !==
              preparedRevision
          )
            throw new RuntimeError(
              "STALE_WORKSPACE",
              "Another tab changed this workspace after preparation. Inspect the current files or staged changes and submit a fresh tool call; the old approved action was not executed.",
            );
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
          if (
            request.mcp &&
            this.gate.policy.decide(
              { ...request, mcpPermissions: handler.permissions?.() },
              handler.spec.effect,
              approvalMode,
            ) === "deny"
          )
            throw new RuntimeError(
              "PERMISSION_DENIED",
              "MCP permission was revoked before execution.",
            );
          try {
            const ownNetwork = request.network
              ? this.gate.policy.authorizeNetwork(
                  request,
                  approvalMode,
                  networkApprovedOnce,
                )
              : undefined;
            const ceilingNetwork = request.network
              ? context.executionConstraint?.authorizeNetwork?.(
                  request,
                  networkApprovedOnce,
                )
              : undefined;
            const networkAuthorization =
              ownNetwork && ceilingNetwork
                ? {
                    destinations: ownNetwork.destinations?.filter(
                      (host) =>
                        !ceilingNetwork.destinations ||
                        ceilingNetwork.destinations.includes(host),
                    ),
                    assertDestination(host: string) {
                      ownNetwork.assertDestination(host);
                      ceilingNetwork.assertDestination(host);
                    },
                  }
                : ownNetwork;
            return await handler.execute(
              {
                ...context,
                worktreeAuthorization: authorizeWorktreePlan(plan, context),
                subagentAuthorization: authorizeSubagentPlan(plan, context),
                signal: executionSignal,
                networkAuthorization,
              },
              plan,
            );
          } finally {
            // Shell errors and interrupted patches may also have changed files.
            // Notify peers before releasing the lease, including on failure.
            if (writesWorkspace) {
              workspaceCoordinator.changed(
                accesses
                  .filter((access) => access.mode === "write")
                  .map((access) => access.resource),
              );
              this.observedWorkspaceRevision =
                workspaceCoordinator.revision(scope);
            }
          }
        };
        result = await workspaceCoordinator.withPlan(
          accesses,
          executionSignal,
          execute,
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
        context.sanitizeResult?.(attributed(result, record.toolSource)) ??
          attributed(result, record.toolSource),
        context.artifacts,
        handler.spec.outputPolicy?.maxInlineTokens ?? this.maxInlineTokens,
      );
      record.result = result;
      record.state = result.isError ? "failed" : "succeeded";
      if (writesWorkspace && !result.isError) {
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
        toolSource: record.toolSource,
      });
      return result;
    } catch (error) {
      let worktreeRecoveryRequired = false;
      try {
        await abandonWorktreePlan(preparedPlan);
      } catch {
        worktreeRecoveryRequired = true;
      }
      if (!record.toolSource) {
        try {
          record.toolSource = this.catalog.get(call.name).spec.source;
        } catch {
          /* Unknown tools have no owner. */
        }
      }
      let result = failure(error);
      if (worktreeRecoveryRequired)
        result.details = { ...result.details, worktreeRecoveryRequired: true };
      result = attributed(result, record.toolSource);
      if (record.toolSource?.type === "mcp")
        result.details = {
          ...result.details,
          mcp: {
            server: record.toolSource.serverTitle,
            tool: record.toolSource.title ?? record.toolSource.originalName,
          },
        };
      try {
        result = context.sanitizeResult?.(result) ?? result;
        result = await normalizeResult(result, context.artifacts, outputLimit);
      } catch {
        result = {
          ...result,
          output: `${result.errorCode}: Error artifact unavailable. ${result.output.slice(0, Math.max(0, outputLimit * 2 - 100))}`,
        };
      }
      record.result = result;
      record.state =
        result.errorCode === "CANCELLED" || result.errorCode === "MCP_CANCELLED"
          ? "cancelled"
          : result.errorCode === "PERMISSION_DENIED" ||
              result.errorCode === "WEB_NETWORK_DENIED" ||
              result.errorCode === "MODE_RESTRICTION" ||
              result.errorCode === "EXTENSION_HOOK_DENIED"
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
        toolSource: record.toolSource,
      });
      return result;
    }
  }
  private observeWorkspace(scope: readonly string[]): void {
    const revision = workspaceCoordinator.revision(scope);
    if (revision !== this.observedWorkspaceRevision) {
      const runtime = this.context.session.runtime;
      if (runtime)
        runtime.workspaceVersion = (runtime.workspaceVersion ?? 0) + 1;
      this.observedWorkspaceRevision = revision;
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
function attributed(
  result: ToolExecutionResult,
  source?: ToolSource,
): ToolExecutionResult {
  return source?.type === "extension"
    ? {
        ...result,
        details: {
          ...result.details,
          extension: { id: source.extensionId, tool: source.originalName },
        },
      }
    : result;
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
