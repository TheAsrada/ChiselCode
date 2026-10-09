import { randomUUID } from "node:crypto";
import { composeCommandProjection } from "../commands/slash.js";
import { loadProjectInstructions } from "../config/load.js";
import type { SideQueryCommandInvocation } from "../extensions/contracts.js";
import type { WorkspaceExtensionScope } from "../extensions/host.js";
import { frozenClone, operationSignal } from "../extensions/lifecycle.js";
import {
  type ConversationCapture,
  captureConversation,
} from "../models/context.js";
import type {
  ModelRequestResult,
  SideQueryRecord,
} from "../models/contracts.js";
import type {
  ModelInvocation,
  ModelRequestService,
} from "../models/service.js";
import { estimateProviderCost } from "../providers/cost.js";
import { createDriverRegistry } from "../providers/drivers/index.js";
import { SecretRedactor } from "../security/redaction.js";
import {
  type ProjectSessionStore,
  projectSessionStore,
} from "../sessions/project-store.js";
import { createSession } from "../sessions/store.js";
import { invocableSkills, loadSkills } from "../skills/skills.js";
import type { Session } from "../types/domain.js";
import type { CapturedModelConfiguration } from "./model-runtime.js";
import { resolveCapturedModelRuntime } from "./model-runtime.js";
import type { PreparedExtensionCommand } from "./run-command.js";
import type { RunOptions } from "./run-prompt.js";

export interface CapturedCommandModel {
  model: CapturedModelConfiguration;
  capture: ConversationCapture;
  acceptedAt: number;
  conversationId: string;
  generation: number;
  invocationId?: string;
  assertAvailable?(): void;
  onRecord?(record: Readonly<SideQueryRecord>): void;
}

/** Both command lanes share this invocation-bound port and operation-only writer. */
export function commandModelInvocation(input: {
  service: ModelRequestService;
  scope: WorkspaceExtensionScope;
  session: Session;
  store: ProjectSessionStore;
  prepared: PreparedExtensionCommand;
  captured: CapturedCommandModel;
  signal: AbortSignal;
  redactor?: SecretRedactor;
}): ModelInvocation {
  const { captured, session, store, scope } = input;
  const records = new Map<string, SideQueryRecord>();
  const redactor = input.redactor ?? new SecretRedactor();
  return input.service.createInvocation({
    owner: Object.freeze({
      extensionId: input.prepared.command.source.extensionId,
      conversationId: captured.conversationId,
      sessionId: session.id,
      workspaceRoot: scope.workspaceRoot,
      generation: captured.generation,
    }),
    invocationId: captured.invocationId ?? randomUUID(),
    command: input.prepared.command.name,
    acceptedAt: captured.acceptedAt,
    capture: captured.capture,
    model: captured.model,
    signal: input.signal,
    redactor,
    assertAvailable: () => {
      scope.assertUsable();
      composeCommandProjection(
        invocableSkills(loadSkills(scope.workspaceRoot)),
        scope.commands.descriptors(),
      );
      captured.assertAvailable?.();
      if (
        scope.commands.get(input.prepared.command.name) !==
        input.prepared.command
      )
        throw new Error("Command owner is unavailable.");
    },
    resolveInstructions: () => loadProjectInstructions(scope.workspaceRoot),
    resolveAdapter: async () =>
      (
        await resolveCapturedModelRuntime(
          captured.model,
          createDriverRegistry(),
          redactor,
        )
      ).adapter,
    checkpoint: async (record) => {
      records.set(record.operationId, structuredClone(record));
      await store.patchSideQuery(session.id, record);
    },
    onRecord: captured.onRecord,
    onLateUsage: async (operationId, usage, usageSource) => {
      const previous = records.get(operationId);
      if (!previous) return;
      const cost = estimateProviderCost(
        captured.model.definition,
        captured.model.model,
        usage.inputTokens,
        usage.outputTokens,
      );
      const record = {
        ...previous,
        usage,
        usageSource,
        cost:
          usageSource === "observed" ? cost : { source: "unknown" as const },
        knownCost: cost.usd ?? 0,
        updatedAt: new Date().toISOString(),
        revision: previous.revision + 1,
      };
      records.set(operationId, record);
      await store.patchSideQuery(session.id, record);
      // Text/status are fenced; this callback can update only the original accounting.
      captured.onRecord?.(frozenClone(record));
    },
  });
}

/** A side invocation never owns/saves a full live foreground Session. */
export async function runSideQueryCommand(
  prepared: PreparedExtensionCommand,
  scope: WorkspaceExtensionScope,
  options: RunOptions,
  captured: CapturedCommandModel,
  service: ModelRequestService,
  operation: AbortSignal,
): Promise<{ sessionId: string; result: ModelRequestResult }> {
  scope.assertUsable();
  if (prepared.command.executionPolicy !== "side_query")
    throw new Error("Command requires the foreground lane.");
  const signal = operationSignal(scope.signal, operation);
  captured.assertAvailable?.();
  composeCommandProjection(
    invocableSkills(loadSkills(scope.workspaceRoot)),
    scope.commands.descriptors(),
  );
  const store = await projectSessionStore(scope.workspaceRoot);
  let session = options.resume
    ? await store.load((await store.resolve(options.resume)).id)
    : undefined;
  if (!session) {
    session = createSession(
      scope.workspaceRoot,
      captured.model.definition.id,
      captured.model.model,
    );
    session.profileId = captured.model.profileId;
    session.mode = options.mode;
    await store.save(session);
  }
  captured = {
    ...captured,
    invocationId: captured.invocationId ?? randomUUID(),
  };
  const invocation = commandModelInvocation({
    service,
    scope,
    session,
    store,
    prepared,
    captured,
    signal,
  });
  const context: SideQueryCommandInvocation = Object.freeze({
    workspaceRoot: scope.workspaceRoot,
    sessionId: session.id,
    conversationId: captured.conversationId,
    generation: captured.generation,
    invocationId: captured.invocationId ?? randomUUID(),
    mode: options.mode ?? session.mode ?? "build",
    approvalMode: session.approvalMode ?? "default",
    signal,
    model: invocation.port,
  });
  let callbackResult: unknown;
  let callbackError: unknown;
  try {
    callbackResult = await prepared.command.execute(context, prepared.input);
  } catch (error) {
    callbackError = error;
  } finally {
    await invocation.close();
  }
  // A callback cannot replace a core result with forged success/usage/identity.
  const result =
    invocation.results.find((item) => item === callbackResult) ??
    invocation.results.at(-1);
  if (!result)
    throw new Error(
      callbackError
        ? `/${prepared.command.name} · ${prepared.command.source.extensionId}: model request failed.`
        : "Side command did not start a model request.",
    );
  return { sessionId: session.id, result };
}

export const emptyConversationCapture = () => captureConversation();
