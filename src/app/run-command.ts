import { randomUUID } from "node:crypto";
import { z } from "zod";
import { composeCommandProjection } from "../commands/slash.js";
import { loadGlobalConfig, loadProjectConfig } from "../config/load.js";
import type { RegisteredExtensionCommand } from "../extensions/commands.js";
import type { ExtensionCommandInvocation } from "../extensions/contracts.js";
import type { WorkspaceExtensionScope } from "../extensions/host.js";
import { frozenClone, operationSignal } from "../extensions/lifecycle.js";
import { captureConversation } from "../models/context.js";
import type {
  ModelRequestPort,
  ModelRequestResult,
} from "../models/contracts.js";
import {
  type ModelInvocation,
  ModelRequestService,
} from "../models/service.js";
import { getProviderCatalog } from "../providers/catalog.js";
import { builtinDefinitions } from "../providers/definitions/index.js";
import { resolveProfileModel, selectProfile } from "../providers/profiles.js";
import { DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { RuntimeEventBus } from "../runtime/events.js";
import type { ApprovalResolver } from "../security/approval.js";
import { resolveApprovalMode } from "../security/approval-mode.js";
import { SecretRedactor } from "../security/redaction.js";
import { attachSessionRecorder } from "../sessions/checkpoints.js";
import { initializeSessionState } from "../sessions/migrations.js";
import { projectSessionStore } from "../sessions/project-store.js";
import { ToolResultSchema } from "../sessions/schema.js";
import { createSession, sessionTitleForPrompt } from "../sessions/store.js";
import { invocableSkills, loadSkills } from "../skills/skills.js";
import { failure, normalizeResult } from "../tools/result.js";
import type { Session, ToolExecutionResult } from "../types/domain.js";
import {
  type CapturedCommandModel,
  commandModelInvocation,
} from "./model-command.js";
import { captureModelConfiguration } from "./model-runtime.js";
import type { RunEventHandlers, RunOptions } from "./run-prompt.js";
import { createSessionToolRuntime } from "./tool-runtime.js";

export interface PreparedExtensionCommand {
  readonly command: RegisteredExtensionCommand;
  readonly input: unknown;
}

/** Deterministic application operation: real tools/checkpoints, no model request/history. */
export async function runExtensionCommand(
  prepared: PreparedExtensionCommand,
  scope: WorkspaceExtensionScope,
  options: RunOptions,
  resolver: ApprovalResolver,
  handlers: RunEventHandlers = {},
  operation?: AbortSignal,
  modelOptions: {
    captured?: CapturedCommandModel;
    service?: ModelRequestService;
  } = {},
): Promise<{ session: Session; result: ToolExecutionResult }> {
  scope.assertUsable();
  if (prepared.command.executionPolicy !== "foreground")
    throw new Error("Side command requires the side-query dispatch lane.");
  const acceptedAt = Date.now();
  const signal = operationSignal(scope.signal, operation);
  cancelled(signal);
  const root = scope.workspaceRoot;
  const config = await loadProjectConfig(root);
  const global = await loadGlobalConfig(options.configPath);
  const store = await projectSessionStore(root);
  let session = options.resume
    ? await store.load((await store.resolve(options.resume)).id)
    : undefined;
  if (!session) {
    const { registry } = await getProviderCatalog();
    if (Object.keys(global.profiles).length) {
      const selected = selectProfile(global, {
        profile: options.profile,
        provider: options.provider,
      });
      session = createSession(
        root,
        selected.profile.providerId,
        resolveProfileModel(selected.profile, registry, options.model),
      );
      session.profileId = selected.profileId;
    } else {
      // Ordinary session metadata only: local commands can precede model/profile setup.
      const definition = registry.require(
        options.provider ??
          builtinDefinitions[0]?.id ??
          registry.list()[0]?.id ??
          "",
      );
      session = createSession(
        root,
        definition.id,
        options.model ?? definition.defaults.model ?? "",
      );
    }
    session.title = sessionTitleForPrompt(`/${prepared.command.name}`);
  }
  const mode = options.mode ?? session.mode ?? DEFAULT_AGENT_MODE;
  const approvalMode = resolveApprovalMode({
    ...options,
    saved: session.approvalMode,
    autoApprove: config.autoApprove,
    allowBypassPermissions:
      global.permissions?.allowBypassPermissions === true &&
      (options.isBypassAllowed?.() ?? true),
  });
  session.mode = mode;
  session.approvalMode = approvalMode;
  initializeSessionState(session);
  const invocationId = randomUUID();
  if (session.runtime) {
    session.runtime.turnId = invocationId;
    session.runtime.turnMode = mode;
    session.runtime.turnApprovalMode = approvalMode;
  }
  const bus = new RuntimeEventBus(session.id, invocationId);
  const redactor = new SecretRedactor();
  const tools = await createSessionToolRuntime({
    root,
    session,
    store,
    config,
    global,
    options,
    mode,
    approvalMode,
    scope,
    events: bus,
    resolver,
    signal,
    sanitizeExtra: (value) => redactor.value(value),
  });
  const detachRecorder = attachSessionRecorder(session, bus);
  const detach = bus.subscribe(async (event) => {
    await handlers.onEvent?.(event);
    if (event.type === "tool_started")
      handlers.onToolStart?.(
        event.name ?? "",
        event.input ?? {},
        event.toolSource,
      );
    if (
      (event.type === "tool_completed" || event.type === "tool_failed") &&
      event.result
    )
      handlers.onToolResult?.(event.name ?? "", event.result);
  });
  const outstanding = new Set<Promise<ToolExecutionResult>>();
  let blocked: ToolExecutionResult | undefined;
  const normalizedArtifacts = new Map<string, string>();
  let finished = false;
  let callbackClosed = false;
  const modelService = modelOptions.service ?? new ModelRequestService();
  const conversationCapture =
    modelOptions.captured?.capture ?? captureConversation(session);
  let modelInvocation: ModelInvocation | undefined;
  const modelRequests = new Set<Promise<ModelRequestResult>>();
  const model: ModelRequestPort = Object.freeze({
    request: (
      input: Parameters<ModelRequestPort["request"]>[0],
      observer?: Parameters<ModelRequestPort["request"]>[1],
    ) => {
      if (finished || callbackClosed)
        return Promise.reject(
          new RuntimeError("CANCELLED", "Model invocation is closed."),
        );
      const work = (async () => {
        if (!modelInvocation) {
          const { registry } = await getProviderCatalog();
          if (finished || signal.aborted)
            throw new RuntimeError("CANCELLED", "Model invocation is closed.");
          modelInvocation ??= commandModelInvocation({
            service: modelService,
            scope,
            session,
            store,
            prepared,
            signal,
            redactor,
            captured: modelOptions.captured
              ? { ...modelOptions.captured, invocationId }
              : {
                  model: captureModelConfiguration(
                    global,
                    registry,
                    options,
                    session,
                  ),
                  capture: conversationCapture,
                  acceptedAt,
                  conversationId: session.id,
                  generation: 0,
                  invocationId,
                },
          });
        }
        return modelInvocation.port.request(input, observer);
      })();
      modelRequests.add(work);
      void work.finally(() => modelRequests.delete(work)).catch(() => {});
      return work;
    },
  });
  const invocation: ExtensionCommandInvocation = Object.freeze({
    workspaceRoot: root,
    sessionId: session.id,
    invocationId,
    mode,
    approvalMode,
    signal,
    model,
    tools: Object.freeze({
      execute: (
        name: string,
        input: import("../types/domain.js").JsonObject,
      ) => {
        if (finished || callbackClosed)
          return Promise.resolve(
            failure(
              new RuntimeError("CANCELLED", "Command invocation is closed."),
            ),
          );
        // Capture input before waiting/refresh; the model/tool fingerprint sees this same value.
        const call = { id: randomUUID(), name, input: structuredClone(input) };
        const work = (async () => {
          let result: ToolExecutionResult;
          try {
            cancelled(signal);
            scope.assertUsable();
            await tools.refresh();
            result =
              (await tools.scheduler.execute([call], signal))[0] ??
              failure(
                new RuntimeError(
                  "TOOL_EXECUTION_FAILURE",
                  "Tool returned no result.",
                ),
              );
          } catch (error) {
            result = tools.sanitize(failure(error));
          }
          const snapshot = frozenClone(result);
          if (snapshot.artifact)
            normalizedArtifacts.set(snapshot.artifact.uri, snapshot.output);
          if (snapshot.isError || snapshot.requiresApproval)
            blocked ??= snapshot;
          return snapshot;
        })();
        outstanding.add(work);
        void work.finally(() => outstanding.delete(work)).catch(() => {});
        return work;
      },
    }),
  });
  let result: ToolExecutionResult;
  try {
    await tools.saveCheckpoint();
    handlers.onConversation?.(
      Object.freeze({
        sessionId: session.id,
        capture: () => captureConversation(session),
      }),
    );
    await bus.emit({ type: "checkpoint_saved" });
    cancelled(signal);
    const current = scope.commands.get(prepared.command.name);
    if (current !== prepared.command)
      throw new RuntimeError(
        "INVALID_TOOL_INPUT",
        "Command owner is no longer available.",
      );
    composeCommandProjection(
      invocableSkills(loadSkills(root)),
      scope.commands.descriptors(),
    );
    const callbackResult = await prepared.command.execute(
      invocation,
      prepared.input,
    );
    // Validate the existing result DTO, preserving pending/error/artifact semantics.
    result = ToolResultSchema.extend({
      rawOutput: z.string().optional(),
      details: z.record(z.string(), z.json()).optional(),
    }).parse(callbackResult);
  } catch (error) {
    result = failure(error);
  } finally {
    callbackClosed = true;
    // Already started requests remain owned even if the callback did not await.
    await Promise.allSettled([...modelRequests]);
    await modelInvocation?.close();
    if (!modelOptions.service) await modelService.dispose();
    finished = true;
    // A callback cannot relinquish conversation ownership with core tools still in flight.
    await Promise.allSettled([...outstanding]);
  }
  try {
    if (signal.aborted)
      result = failure(new RuntimeError("CANCELLED", "Command cancelled."));
    else if (blocked) result = blocked;
    result = tools.sanitize({
      ...result,
      details: {
        ...result.details,
        command: {
          name: prepared.command.name,
          extensionId: prepared.command.source.extensionId,
        },
      },
    });
    // Already normalized tool artifacts retain their identity and are not copied.
    if (
      !result.artifact ||
      result.rawOutput !== undefined ||
      normalizedArtifacts.get(result.artifact.uri) !== result.output
    )
      result = await normalizeResult(
        result,
        tools.context.artifacts,
        config.context?.maxInlineToolResultTokens,
      );
    await tools.saveCheckpoint();
    return { session, result };
  } finally {
    detach();
    detachRecorder();
    await tools.dispose();
  }
}
