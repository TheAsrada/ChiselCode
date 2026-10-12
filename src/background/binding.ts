import type { ToolContext, ToolPlan } from "../tools/types.js";
import type { WorkspaceAccess } from "../tools/workspace-coordinator.js";
import type { ToolCall, ToolExecutionResult } from "../types/domain.js";
import type { BackgroundPort, BackgroundTask } from "./contracts.js";
import type { ShellData, ShellInput } from "./input.js";

export type BackgroundRunner = (
  ticket: object,
  context: ToolContext,
  input: ShellData,
  signal: AbortSignal,
) => Promise<ToolExecutionResult>;
/** Core-bound service access. No PID, spawn function, raw environment or caller owner. */
export interface BackgroundToolBinding {
  readonly port: BackgroundPort;
  resourceBusy(
    taskId: unknown,
    invocationId: string,
  ): import("../types/chat-presentation.js").OwnedChatPresentation | undefined;
  prepareShell(
    context: ToolContext,
    input: ShellInput,
  ): Promise<ToolPlan<ShellData>>;
  submit(
    call: ToolCall,
    input: ShellInput,
    context: ToolContext,
    run: BackgroundRunner,
  ): Promise<ToolExecutionResult>;
  executeShell(
    context: ToolContext,
    plan: ToolPlan<ShellData>,
  ): Promise<ToolExecutionResult>;
  assertAccess(
    accesses: readonly WorkspaceAccess[],
    ticket?: object,
  ): Promise<void>;
  acquireAccess(
    accesses: readonly WorkspaceAccess[],
    signal?: AbortSignal,
    process?: boolean,
  ): Promise<import("../tools/workspace-coordinator.js").WorkspaceLease>;
  ticketData(ticket: object): ShellData;
  checkpointExecution(
    session: import("../types/domain.js").Session,
  ): Promise<void>;
  runtimeEvent(
    ticket: object,
    event: import("../runtime/events.js").RuntimeEvent,
  ): Promise<void>;
  foreground(
    context: ToolContext,
    plan: ToolPlan<ShellData>,
    promote: (signal: AbortSignal) => Promise<void>,
  ): Promise<ToolExecutionResult>;
}
export interface BackgroundControls {
  readonly port: BackgroundPort;
  list(): Promise<readonly BackgroundTask[]>;
  promote(id: string): Promise<BackgroundTask>;
  busy(): boolean;
  cancel(): Promise<void>;
  close(): Promise<void>;
  wait(): Promise<void>;
}
