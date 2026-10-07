import { execa } from "execa";
import {
  loadGlobalConfig,
  loadProjectConfig,
  loadProjectInstructions,
} from "../config/load.js";
import { ContextManager } from "../context/context-manager.js";
import { modelSummarizer } from "../context/model-summary.js";
import { buildSystemPrompt, type DynamicContext } from "../core/prompt.js";
import {
  contextCollection,
  type ExtensionDependencies,
  withExtensionWorkspace,
} from "../extensions/composition.js";
import type { WorkspaceExtensionScope } from "../extensions/host.js";
import { ExtensionLifecycleError } from "../extensions/lifecycle.js";
import { resolveCredential } from "../providers/auth.js";
import type { ModelCapabilities } from "../providers/capabilities.js";
import { getProviderCatalog } from "../providers/catalog.js";
import type { ProviderProfile } from "../providers/contracts.js";
import { resolveEndpoint } from "../providers/endpoint.js";
import { catalogModelLimits } from "../providers/model-metadata.js";
import { resolveProfileModel, selectProfile } from "../providers/profiles.js";
import {
  checkAdapterHealth,
  resolveProviderRuntime,
} from "../providers/runtime.js";
import type { GlobalConfig } from "../types/domain.js";

export { MissingApiKeyError } from "../providers/runtime.js";

import { McpConnectionManager } from "../mcp/manager.js";
import { McpRuntimeBinding } from "../mcp/runtime.js";
import { McpConfigStore } from "../mcp/storage.js";
import { type AgentMode, DEFAULT_AGENT_MODE } from "../runtime/agent-mode.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { type RuntimeEvent, RuntimeEventBus } from "../runtime/events.js";
import { ApprovalGate, type ApprovalResolver } from "../security/approval.js";
import {
  type ApprovalModeInput,
  resolveApprovalMode,
} from "../security/approval-mode.js";
import { CredentialStore } from "../security/credentials.js";
import { projectSessionStore } from "../sessions/project-store.js";
import { createSession, sessionTitleForPrompt } from "../sessions/store.js";
import { loadSkills } from "../skills/skills.js";
import { createLocalToolRuntime } from "../tools/local-runtime.js";
import type {
  AgentResult,
  ModelInfo,
  ProviderAdapter,
  ProviderId,
  ToolExecutionResult,
  ToolName,
} from "../types/domain.js";
import { exitCodeFor, OneShotRenderer } from "../ui/one-shot.js";
import { createWebToolProvider } from "../web/provider.js";
import { resolveWebConfig, type WebConfig } from "../web/schema.js";

export interface RunEventHandlers {
  onEvent?(event: RuntimeEvent): void | Promise<void>;
  onText?(text: string): void;
  onThinking?(text: string): void;
  onToolStart?(
    name: string,
    input: Record<string, unknown>,
    source?: import("../tools/types.js").ToolSource,
  ): void;
  onToolResult?(name: string, result: ToolExecutionResult): void;
}

export interface RunOptions {
  /** Shared across TUI turns/tabs of a project; headless runs own their manager. */
  mcpManager?: McpConnectionManager;
  /** Live user network configuration; repository restrictions are always reapplied. */
  getWebConfig?: () => WebConfig | undefined;
  mode?: AgentMode;
  approvalMode?: ApprovalModeInput;
  /** Internal live revocation hook; user config must also permit Bypass. */
  isBypassAllowed?: () => boolean;
  /** Internal harness override; not a CLI flag. */
  configPath?: string;
  provider?: ProviderId;
  profile?: string;
  model?: string;
  baseUrl?: string;
  yes?: boolean;
  allow?: string;
  json?: boolean;
  resume?: string;
  cwd?: string;
}

export async function hasApiKey(
  provider: ProviderId,
  keyRef?: string,
): Promise<boolean> {
  const { registry } = await getProviderCatalog();
  const d = registry.get(provider);
  if (!d) return false;
  if (!d.auth.required) return true;
  return Boolean(
    await resolveCredential(
      d,
      { providerId: provider, apiKeyRef: keyRef },
      new CredentialStore(),
    ),
  );
}

export interface ConnectionCheckInput {
  provider: ProviderId;
  profileId?: string;
  baseUrl?: string;
  model?: string;
  /**
   * Ключ, введённый, но ещё не сохранённый (из /settings). Приоритет над
   * сохранённым: проверка тестирует то, что на экране, а не прошлое.
   */
  apiKey?: string;
}

export interface ConnectionCheckResult {
  ok: boolean;
  message: string;
}

const CONNECTION_CHECK_TIMEOUT_MS = 25_000;

/** Read model limits through the configured connection, without a generation request. */
export async function getModelCapabilities(
  input: ConnectionCheckInput,
): Promise<ModelCapabilities> {
  const fallback: ModelCapabilities = {
    tokenCounting: "local_estimate",
    ...catalogModelLimits(input.provider, input.model ?? ""),
  };
  try {
    const runtime = await resolveConnectionRuntime(input);
    return (
      (await runtime.adapter.getCapabilities?.(input.model ?? "")) ?? fallback
    );
  } catch {
    return fallback;
  }
}

/**
 * Проверка подключения к провайдеру: ключ + адрес + список моделей.
 * Используется кнопкой «Проверить подключение» в /settings, чтобы вместо
 * «не работает» показать точную причину: 401 — ключ, 404 — адрес
 * (для OpenAI нужен /v1 в конце), model_not_found — название модели.
 */
export async function checkProviderConnection(
  input: ConnectionCheckInput,
  options?: { configPath?: string },
): Promise<ConnectionCheckResult> {
  let adapter: ProviderAdapter;
  let baseUrl: string | undefined;
  try {
    const runtime = await resolveConnectionRuntime(input, options?.configPath);
    adapter = runtime.adapter;
    baseUrl = runtime.profile.baseUrl;
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (adapter.checkConnection || !adapter.listModels) {
    let health: Awaited<ReturnType<typeof checkAdapterHealth>>;
    try {
      health = await withTimeout(
        checkAdapterHealth(adapter),
        CONNECTION_CHECK_TIMEOUT_MS,
        "Connection check timeout.",
      );
    } catch (error) {
      return { ok: false, message: formatConnectionError(error, baseUrl) };
    }
    return { ok: health.status !== "unhealthy", message: health.message };
  }
  let models: { id: string }[];
  try {
    models = await withTimeout(
      adapter.listModels
        ? adapter.listModels()
        : Promise.reject(
            new Error("Model listing unsupported; введите модель вручную."),
          ),
      CONNECTION_CHECK_TIMEOUT_MS,
      `Превышено время ожидания (${CONNECTION_CHECK_TIMEOUT_MS / 1000}с): проверьте адрес API и доступность сервера.`,
    );
  } catch (error) {
    return { ok: false, message: formatConnectionError(error, baseUrl) };
  }
  const shown = models.slice(0, 3).map((model) => model.id);
  let message =
    `Подключение OK${baseUrl ? `: ${baseUrl}` : ""} — моделей доступно: ${models.length}` +
    (shown.length ? ` (первые: ${shown.join(", ")})` : "");
  const wanted = input.model?.trim();
  if (
    wanted &&
    models.length > 0 &&
    !models.some(
      (model) =>
        model.id === wanted ||
        model.id.toLowerCase().includes(wanted.toLowerCase()),
    )
  )
    message += ` — модели «${wanted}» нет в списке шлюза, сверьте название в консоли провайдера.`;
  return { ok: true, message };
}

export type ModelListOutcome =
  | { ok: true; models: ModelInfo[] }
  | { ok: false; error: string };

/**
 * Список моделей провайдера для интерактивного выбора в /model.
 * Та же резолюция ключа и адреса, что и в checkProviderConnection:
 * введённый (но ещё не сохранённый) ключ приоритетнее сохранённого.
 * Сеть трогает только при наличии ключа и адреса.
 */
export async function listProviderModels(
  input: ConnectionCheckInput,
  options?: { configPath?: string },
): Promise<ModelListOutcome> {
  let adapter: ProviderAdapter;
  let baseUrl: string | undefined;
  try {
    const runtime = await resolveConnectionRuntime(input, options?.configPath);
    adapter = runtime.adapter;
    baseUrl = runtime.profile.baseUrl;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const models = await withTimeout(
      adapter.listModels
        ? adapter.listModels()
        : Promise.reject(
            new Error("Model listing unsupported; введите модель вручную."),
          ),
      CONNECTION_CHECK_TIMEOUT_MS,
      `Превышено время ожидания (${CONNECTION_CHECK_TIMEOUT_MS / 1000}с): проверьте адрес API и доступность сервера.`,
    );
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: formatConnectionError(error, baseUrl) };
  }
}

function connectionProfile(
  global: GlobalConfig,
  input: ConnectionCheckInput,
): ProviderProfile {
  if (input.profileId) {
    const profile = global.profiles[input.profileId];
    if (profile && profile.providerId !== input.provider)
      throw new Error("Profile/provider mismatch.");
    return profile ?? { providerId: input.provider };
  }
  const matches = Object.values(global.profiles).filter(
    (p) => p.providerId === input.provider,
  );
  if (matches.length > 1)
    throw new Error(
      "Multiple profiles; choose a profile before checking connection.",
    );
  return matches[0] ?? { providerId: input.provider };
}
async function resolveConnectionRuntime(
  input: ConnectionCheckInput,
  configPath?: string,
) {
  const global = await loadGlobalConfig(configPath);
  const { registry, drivers } = await getProviderCatalog();
  const profile = {
    ...connectionProfile(global, input),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
  };
  return resolveProviderRuntime({
    profile,
    profileId: input.profileId,
    registry,
    drivers,
    apiKey: input.apiKey,
  });
}

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatConnectionError(error: unknown, baseUrl?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number } | null)?.status;
  if (
    status === 401 ||
    /unauthenticated|unauthorized|incorrect api key|invalid api key|authentication/i.test(
      message,
    )
  )
    return `Сервер отклонил API-ключ (401): вставьте действующий ключ через «Пройти настройку заново». ${message}`;
  if (status === 404)
    return (
      `Сервер не нашёл адрес API (404${baseUrl ? `: ${baseUrl}` : ""}): ` +
      "для OpenAI-совместимого адрес должен заканчиваться /v1 " +
      "(например https://agentrouter.org/v1), для Anthropic-совместимого — быть корнем без /v1."
    );
  if (/model_not_found|no available channel|does not exist/i.test(message))
    return `Сервер не знает такую модель: ${message}`;
  return message;
}

export async function runPrompt(
  prompt: string,
  options: RunOptions,
  resolver: ApprovalResolver,
  events: RunEventHandlers = {},
  signal?: AbortSignal,
  extensions?: ExtensionDependencies,
): Promise<{ result: AgentResult; exitCode: number }> {
  let completed: { result: AgentResult; exitCode: number } | undefined;
  try {
    return await withExtensionWorkspace(
      options.cwd ?? process.cwd(),
      extensions,
      signal,
      async (scope, operation) => {
        completed = await runPromptInWorkspace(
          prompt,
          options,
          resolver,
          events,
          operation,
          scope,
        );
        return completed;
      },
    );
  } catch (error) {
    // Runtime returns failed results rather than throwing; retain that primary
    // failure if owned extension cleanup subsequently fails.
    if (
      completed?.result.error &&
      error instanceof ExtensionLifecycleError &&
      error.cleanupFailures.length
    )
      throw new ExtensionLifecycleError(
        `${completed.result.error} ${error.message}`,
        error.extensionId,
        completed.result,
        error.cleanupFailures,
      );
    throw error;
  }
}

async function runPromptInWorkspace(
  prompt: string,
  options: RunOptions,
  resolver: ApprovalResolver,
  events: RunEventHandlers,
  signal: AbortSignal,
  extensionScope: WorkspaceExtensionScope,
): Promise<{ result: AgentResult; exitCode: number }> {
  const startedAt = performance.now();
  const projectRoot = options.cwd ?? process.cwd();
  const sessionStore = await projectSessionStore(projectRoot);
  const config = await loadProjectConfig(projectRoot);
  const global = await loadGlobalConfig(options.configPath);
  const { registry, drivers } = await getProviderCatalog();
  const previous = options.resume
    ? await sessionStore.load((await sessionStore.resolve(options.resume)).id)
    : undefined;
  if (previous && !options.provider && !options.profile)
    registry.require(previous.providerId);
  const selected = selectProfile(
    global,
    options.profile || options.provider
      ? { profile: options.profile, provider: options.provider }
      : previous
        ? {
            profile:
              previous.profileId ??
              `${previous.providerId.replaceAll("/", "-")}-default`,
          }
        : {},
  );
  const model =
    previous && !options.model && !options.provider && !options.profile
      ? previous.model
      : resolveProfileModel(selected.profile, registry, options.model);
  const session =
    previous ?? createSession(projectRoot, selected.profile.providerId, model);
  const mode = options.mode ?? session.mode ?? DEFAULT_AGENT_MODE;
  session.mode = mode;
  const approvalMode = resolveApprovalMode({
    ...options,
    saved: session.approvalMode,
    autoApprove: config.autoApprove,
    allowBypassPermissions:
      global.permissions?.allowBypassPermissions === true &&
      (options.isBypassAllowed?.() ?? true),
  });
  session.approvalMode = approvalMode;
  if (
    session.model !== model ||
    session.providerId !== selected.profile.providerId ||
    session.profileId !== selected.profileId
  )
    session.contextSnapshot = undefined;
  session.model = model;
  session.providerId = selected.profile.providerId;
  session.profileId = selected.profileId;
  if (
    session.messages.length === 0 &&
    session.titleSource !== "user" &&
    prompt.trim()
  ) {
    session.title = sessionTitleForPrompt(prompt);
    session.titleSource = "auto";
  }

  const { adapter: provider, definition } = await resolveProviderRuntime({
    ...selected,
    registry,
    drivers,
    baseUrl: options.baseUrl,
  });
  const renderer = new OneShotRenderer({ json: Boolean(options.json) });
  const onText = events.onText ?? ((text: string) => renderer.text(text));
  const onThinking = events.onThinking ?? (() => renderer.thinking());
  const onToolStart =
    events.onToolStart ??
    ((name: string, input: Record<string, unknown>) =>
      renderer.toolStart(name, input));
  const onToolResult =
    events.onToolResult ??
    ((name: string, result: ToolExecutionResult) =>
      renderer.toolResult(name, result));
  const webConfig = resolveWebConfig(global.web, config.web);
  const web = await createWebToolProvider(webConfig);
  const approvalGate = new ApprovalGate(
    config,
    {
      autoApprove: Boolean(options.yes),
      approvalMode,
      allowBypassPermissions: () =>
        global.permissions?.allowBypassPermissions === true &&
        (options.isBypassAllowed?.() ?? true),
      allowedTools: parseAllowedTools(options.allow),
      nonInteractive: !process.stdin.isTTY,
      network: {
        scope: `${projectRoot}:${session.id}`,
        config: () =>
          resolveWebConfig(options.getWebConfig?.() ?? global.web, config.web),
      },
    },
    resolver,
  );
  const skills = loadSkills(projectRoot);
  const eventBus = new RuntimeEventBus(session.id);
  const mcp =
    global.mcp || config.mcp || options.mcpManager?.list().length
      ? (options.mcpManager ??
        new McpConnectionManager(
          new McpConfigStore(projectRoot, { globalPath: options.configPath }),
        ))
      : undefined;
  const sanitize = <T>(value: T): T =>
    web.redactor.value(mcp ? mcp.redactor.value(value) : value);
  eventBus.sanitize = sanitize;
  const saveCheckpoint = () => {
    session.messages = sanitize(session.messages);
    if (session.title) session.title = sanitize(session.title);
    if (session.context?.activeCheckpoint)
      Object.assign(
        session.context.activeCheckpoint.summary,
        sanitize(session.context.activeCheckpoint.summary),
      );
    for (const record of Object.values(session.runtime?.invocations ?? {})) {
      record.input = sanitize(record.input);
      if (record.result) record.result = sanitize(record.result);
      if (record.approvalPreview)
        record.approvalPreview = sanitize(record.approvalPreview);
    }
    return sessionStore.save(session);
  };
  const detachEvents = eventBus.subscribe(async (event) => {
    await events.onEvent?.(event);
    if (
      !events.onEvent &&
      event.type === "context_compaction_completed" &&
      event.compaction
    )
      renderer.compaction(event.compaction);
    if (event.type === "provider_text_delta") onText(event.text ?? "");
    if (event.type === "provider_thinking_delta") onThinking(event.text ?? "");
    if (event.type === "tool_started")
      onToolStart(event.name ?? "", event.input ?? {}, event.toolSource);
    if (
      (event.type === "tool_completed" || event.type === "tool_failed") &&
      event.result
    )
      onToolResult(event.name ?? "", event.result);
  });
  const tools = createLocalToolRuntime(
    projectRoot,
    config.ignorePatterns,
    approvalGate,
    session,
    skills,
    {
      events: eventBus,
      mode,
      approvalMode,
      signal,
      maxInlineTokens: config.context?.maxInlineToolResultTokens,
      maxParallelReads: config.tools?.maxParallelReads,
      requireFreshRead: config.editing?.requireFreshRead,
      checkpoint: saveCheckpoint,
      sanitizeResult: sanitize,
      sanitizeApproval: sanitize,
      toolGuards: extensionScope.toolGuards,
    },
  );
  await tools.catalog.addProvider(web);
  const dynamic = await collectDynamicContext(projectRoot);
  const mcpBinding = mcp
    ? new McpRuntimeBinding(mcp, tools.catalog)
    : undefined;
  session.gitBranch = dynamic.gitBranch;
  const system = buildSystemPrompt(
    await loadProjectInstructions(projectRoot),
    dynamic,
    skills,
  );
  let result: AgentResult | undefined;
  let runtimeFailure: unknown;
  let runtimeFailed = false;
  const cleanupErrors: unknown[] = [];
  try {
    // Resolve known credentials before the first transcript checkpoint or model request.
    await mcpBinding?.refresh(signal);
    const runtime = new AgentRuntime(
      provider,
      new ContextManager(
        config.context,
        eventBus,
        JSON.stringify([
          selected.profile.providerId,
          selected.profileId,
          resolveEndpoint(
            definition,
            options.baseUrl ?? selected.profile.baseUrl,
          ),
        ]),
        modelSummarizer,
      ),
      {
        getApprovalMode: tools.getApprovalMode,
        instructionsForTurn: (selected) =>
          tools.catalog.instructionsForTurn(selected),
        selectForTurn: async (input) => {
          await mcpBinding?.refresh(signal);
          return tools.catalog.selectForTurn(input);
        },
        execute: (calls, signal) =>
          tools.scheduler.execute(sanitize(calls), signal),
      },
      sanitize(system),
      eventBus,
    );
    result = await runtime.run(session, sanitize(prompt), {
      mode,
      approvalMode,
      signal,
      onCheckpoint: saveCheckpoint,
      contextProviders: contextCollection(extensionScope, sanitize),
    });
  } catch (error) {
    runtimeFailed = true;
    runtimeFailure = error;
  } finally {
    const cleanup = async (dispose: () => void | Promise<void>) => {
      try {
        await dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await cleanup(detachEvents);
    await cleanup(() => mcpBinding?.dispose());
    if (mcp && !options.mcpManager) await cleanup(() => mcp.dispose());
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [
        ...(runtimeFailed
          ? [runtimeFailure]
          : result?.error
            ? [sanitize(result.error)]
            : []),
        ...cleanupErrors,
      ],
      "Request resource cleanup failed; all cleanup operations were attempted.",
    );
  if (runtimeFailed) throw runtimeFailure;
  if (!result) throw new Error("Runtime returned no result.");
  result.elapsedMs = Math.max(0, performance.now() - startedAt);
  result.text = sanitize(result.text);
  if (result.error) result.error = sanitize(result.error);
  if (result.pendingApproval)
    result.pendingApproval = sanitize(result.pendingApproval);
  result.session.requestTimings ??= [];
  result.session.requestTimings.push({
    afterMessage: result.session.messages.length,
    elapsedMs: result.elapsedMs,
    status: result.status,
  });
  await sessionStore.save(result.session);
  if (
    !events.onText &&
    !events.onThinking &&
    !events.onToolStart &&
    !events.onToolResult
  )
    renderer.complete(result);
  return { result, exitCode: exitCodeFor(result) };
}

function parseAllowedTools(value: string | undefined): Set<ToolName> {
  if (!value) return new Set();
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean) as ToolName[];
  return new Set(names);
}

async function collectDynamicContext(cwd: string): Promise<DynamicContext> {
  const [gitBranch, gitStatus] = await Promise.all([
    runGit(["branch", "--show-current"], cwd),
    runGit(["status", "--short"], cwd),
  ]);
  return {
    os: `${process.platform} ${process.arch}`,
    cwd,
    date: new Date().toISOString(),
    gitBranch: gitBranch || undefined,
    gitStatus: gitStatus
      ? gitStatus.split("\n").slice(0, 30).join("\n").slice(0, 4000)
      : undefined,
  };
}

async function runGit(
  args: string[],
  cwd: string,
): Promise<string | undefined> {
  try {
    const result = await execa(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        reject: false,
      },
    );
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

export const nonInteractiveResolver: ApprovalResolver = {
  async requestApproval() {
    return "unavailable";
  },
};
