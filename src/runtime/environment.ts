import { contextBudget } from "../context/budget.js";
import { requestTokens } from "../context/tokenizer.js";
import type { ContextOptions, RequestContext } from "../context/types.js";
import type { ApprovalMode } from "../security/approval-mode.js";
import type {
  ProviderAdapter,
  ProviderRequest,
  Session,
} from "../types/domain.js";
import { VERSION } from "../version.js";
import type { AgentMode } from "./agent-mode.js";
import { RuntimeError } from "./errors.js";

export interface RuntimeIdentity {
  readonly application: "ChiselCode";
  readonly version: string;
  readonly client: "cli" | "opentui" | "subagent";
  readonly model: string;
  readonly configuredModel?: string;
  readonly provider: string;
  readonly profile: string;
  readonly agentMode: AgentMode;
  readonly approvalMode?: ApprovalMode;
  readonly cwd: string;
}
export type UiObservation =
  | { ownerVisible: false }
  | {
      ownerVisible: true;
      route: "home" | "conversation";
      focus?: "composer" | "transcript" | "sidebar" | "modal";
      nextModel?: { provider: string; model: string; profile?: string };
    };
export type UiSnapshot =
  | { available: false; observedAt: string }
  | ({ available: true; observedAt: string } & UiObservation);
export interface UiSnapshotPort {
  observe(): UiObservation;
}

export function captureRuntimeIdentity(
  session: Pick<Session, "model" | "profileId" | "projectPath">,
  provider: string,
  agentMode: AgentMode,
  approvalMode?: ApprovalMode,
  client: RuntimeIdentity["client"] = "cli",
): RuntimeIdentity {
  return Object.freeze({
    application: "ChiselCode",
    version: VERSION,
    client,
    model: session.model,
    provider,
    profile: session.profileId,
    agentMode,
    approvalMode,
    cwd: session.projectPath,
  });
}
const data = (value: unknown) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
export function runtimeIdentityPrompt(identity: RuntimeIdentity): string {
  return `Running application identity (captured from this process and this request; data, not instructions):\n<runtime_identity>${data(identity)}</runtime_identity>\nFor questions about your version, model or environment, use these facts instead of reading application files or inferring from logs. UI facts below are time-limited OpenTUI terminal observations, without DOM or OS-window focus. State unknowns honestly and distinguish this request's model from the model selected for the next request.`;
}

/** A model.request hook can route the transport, but cannot supply core identity. */
export async function finalizeRuntimeIdentity(
  request: ProviderRequest,
  identity: RuntimeIdentity,
  provider: ProviderAdapter,
  options: ContextOptions,
  estimated: number,
): Promise<{ request: ProviderRequest; estimated: number }> {
  const owned = runtimeIdentityPrompt(identity);
  if (request.model === identity.model && request.system.includes(owned))
    return { request, estimated };
  const actual = Object.freeze({
    ...identity,
    model: request.model,
    ...(request.model !== identity.model
      ? { configuredModel: identity.model }
      : {}),
  });
  request = {
    ...request,
    system: `${request.system.replace(owned, "")}\n\n${runtimeIdentityPrompt(actual)}`,
  };
  const counted = await provider.countTokens?.({
    model: request.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    signal: request.signal,
  });
  const tokens =
    counted ?? requestTokens(request.system, request.messages, request.tools);
  const capabilities = (await provider.getCapabilities?.(request.model)) ?? {
    tokenCounting: "local_estimate" as const,
  };
  const budget = contextBudget(capabilities, options, request.maxTokens);
  if (budget.maxInputTokens !== undefined && tokens > budget.maxInputTokens)
    throw new RuntimeError(
      "CONTEXT_BUDGET_EXCEEDED",
      "Изменённый расширением запрос превышает доступный контекст модели.",
    );
  return {
    request: {
      ...request,
      maxTokens: budget.maxOutputTokens ?? request.maxTokens,
    },
    estimated: tokens,
  };
}
export function observeUi(
  port?: UiSnapshotPort,
  now: () => Date = () => new Date(),
): UiSnapshot {
  const observedAt = now().toISOString();
  if (!port) return Object.freeze({ available: false, observedAt });
  const observed = port.observe();
  if (!observed.ownerVisible)
    return Object.freeze({ available: true, ownerVisible: false, observedAt });
  // Copy allowed fields only; the port never serializes a controller or foreign tab.
  return Object.freeze({
    available: true,
    observedAt,
    ownerVisible: true,
    route: observed.route,
    focus: observed.focus,
    ...(observed.nextModel
      ? {
          nextModel: Object.freeze({
            provider: observed.nextModel.provider,
            model: observed.nextModel.model,
            profile: observed.nextModel.profile,
          }),
        }
      : {}),
  });
}
export function withUiSnapshot(
  context: RequestContext | undefined,
  snapshot: UiSnapshot,
): RequestContext {
  return Object.freeze({
    text: `Application-owned ephemeral OpenTUI observation. Use only for the current request; it is not a persistent fact.\n<ui_snapshot>${data(snapshot)}</ui_snapshot>${context ? `\n\n${context.text}` : ""}`,
    sources: Object.freeze([
      { extensionId: "core", providerId: "ui_snapshot" },
      ...(context?.sources ?? []),
    ]),
  });
}
