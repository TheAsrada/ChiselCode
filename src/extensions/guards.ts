import { cancelled } from "../runtime/errors.js";
import type {
  Disposable,
  ToolGuard,
  ToolGuardDecision,
  ToolGuardInvocation,
  ToolGuardPoint,
  ToolGuardPort,
} from "./contracts.js";
import {
  abortable,
  extensionFailure,
  frozenClone,
  operationSignal,
} from "./lifecycle.js";

export class RuntimeHookPipeline implements ToolGuardPort, Disposable {
  private entries: {
    extensionId: string;
    point: ToolGuardPoint;
    guard: ToolGuard;
  }[] = [];
  private closed = false;
  private sealed = false;
  constructor(
    private readonly workspaceRoot: string,
    private readonly lifetime: AbortSignal,
  ) {}
  register(
    extensionId: string,
    point: ToolGuardPoint,
    guard: ToolGuard,
  ): Disposable {
    this.assertOpen();
    if (this.sealed) throw new Error("Tool guard registrations are closed.");
    const entry = { extensionId, point, guard };
    this.entries.push(entry);
    return {
      dispose: () => {
        this.entries = this.entries.filter((item) => item !== entry);
      },
    };
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("Tool guards are closed.");
  }
  has(point: ToolGuardPoint): boolean {
    this.assertOpen();
    return this.entries.some((entry) => entry.point === point);
  }
  async run(
    point: ToolGuardPoint,
    invocation: ToolGuardInvocation,
    operation?: AbortSignal,
  ): Promise<void> {
    this.assertOpen();
    const entries = this.entries.filter((entry) => entry.point === point);
    if (!entries.length) return;
    const signal = operationSignal(this.lifetime, operation);
    cancelled(signal);
    const snapshot = Object.freeze({
      ...frozenClone(invocation),
      workspaceRoot: this.workspaceRoot,
      signal,
    });
    for (const entry of entries) {
      let decision: ToolGuardDecision;
      try {
        const result = await abortable(() => entry.guard(snapshot), signal);
        cancelled(signal);
        if (
          !result ||
          (result.action !== "continue" && result.action !== "deny")
        )
          throw new Error("Invalid guard decision.");
        if (result.action === "deny") {
          const reason = result.reason;
          if (
            typeof reason !== "string" ||
            !reason.trim() ||
            reason.length > 240
          )
            throw new Error("Invalid guard denial reason.");
          decision = { action: "deny", reason: reason.trim() };
        } else decision = { action: "continue" };
      } catch (error) {
        cancelled(signal);
        throw extensionFailure(
          "EXTENSION_HOOK_FAILED",
          `Extension ${entry.extensionId} failed at ${point}.`,
          { extensionId: entry.extensionId, hookPoint: point },
          error,
        );
      }
      if (decision.action === "deny")
        throw extensionFailure(
          "EXTENSION_HOOK_DENIED",
          `Extension ${entry.extensionId} denied ${point}: ${decision.reason.trim()}`,
          { extensionId: entry.extensionId, hookPoint: point },
        );
    }
  }
  seal(): void {
    this.sealed = true;
  }
  dispose(): void {
    this.closed = true;
    this.entries = [];
  }
}
