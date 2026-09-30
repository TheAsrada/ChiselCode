import { execa } from "execa";
import {
  loadGlobalConfig,
  loadProjectConfig,
  loadProjectInstructions,
} from "../config/load.js";
import { ContextManager } from "../context/context-manager.js";
import { buildSystemPrompt, type DynamicContext } from "../core/prompt.js";
import { resolveCredential } from "../providers/auth.js";
import { getProviderCatalog } from "../providers/catalog.js";
import type { ProviderProfile } from "../providers/contracts.js";
import { resolveProfileModel, selectProfile } from "../providers/profiles.js";
import {
  checkAdapterHealth,
  resolveProviderRuntime,
} from "../providers/runtime.js";
import type { GlobalConfig } from "../types/domain.js";

export { MissingApiKeyError } from "../providers/runtime.js";

import { AgentRuntime } from "../runtime/agent-runtime.js";
import { type RuntimeEvent, RuntimeEventBus } from "../runtime/events.js";
import { ApprovalGate, type ApprovalResolver } from "../security/approval.js";
import { CredentialStore } from "../security/credentials.js";
import { projectSessionStore } from "../sessions/project-store.js";
import { createSession, sessionTitleForPrompt } from "../sessions/store.js";
import { loadSkills } from "../skills/skills.js";
import { createLocalToolRuntime } from "../tools/local-runtime.js";
import type {
  AgentResult,
  ModelInfo,
  ProviderAdapter,
  ProviderKind,
  ToolExecutionResult,
  ToolName,
} from "../types/domain.js";
import { exitCodeFor, OneShotRenderer } from "../ui/one-shot.js";

export interface RunEventHandlers {
  onEvent?(event: RuntimeEvent): void | Promise<void>;
  onText?(text: string): void;
  onThinking?(text: string): void;
  onToolStart?(name: string, input: Record<string, unknown>): void;
  onToolResult?(name: string, result: ToolExecutionResult): void;
}

export interface RunOptions {
  provider?: ProviderKind;
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
  provider: ProviderKind,
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
  provider: ProviderKind;
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
    const health = await checkAdapterHealth(adapter);
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
): Promise<{ result: AgentResult; exitCode: number }> {
  const projectRoot = options.cwd ?? process.cwd();
  const sessionStore = await projectSessionStore(projectRoot);
  const config = await loadProjectConfig(projectRoot);
  const global = await loadGlobalConfig();
  const { registry, drivers } = await getProviderCatalog();
  const previous = options.resume
    ? await sessionStore.load((await sessionStore.resolve(options.resume)).id)
    : undefined;
  if (previous && !options.provider && !options.profile)
    registry.require(previous.provider);
  const selected = selectProfile(
    global,
    options.profile || options.provider
      ? { profile: options.profile, provider: options.provider }
      : previous
        ? {
            profile:
              previous.profileId ??
              `${previous.provider.replaceAll("/", "-")}-default`,
          }
        : {},
  );
  const model =
    previous && !options.model && !options.provider && !options.profile
      ? previous.model
      : resolveProfileModel(selected.profile, registry, options.model);
  const session =
    previous ?? createSession(projectRoot, selected.profile.providerId, model);
  if (
    session.model !== model ||
    session.provider !== selected.profile.providerId
  )
    session.contextSnapshot = undefined;
  session.model = model;
  session.provider = selected.profile.providerId;
  session.profileId = selected.profileId;
  if (
    session.messages.length === 0 &&
    session.titleSource !== "user" &&
    prompt.trim()
  ) {
    session.title = sessionTitleForPrompt(prompt);
    session.titleSource = "auto";
  }

  const { adapter: provider } = await resolveProviderRuntime({
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
  const approvalGate = new ApprovalGate(
    config,
    {
      autoApprove: Boolean(options.yes),
      allowedTools: parseAllowedTools(options.allow),
      nonInteractive: !process.stdin.isTTY,
    },
    resolver,
  );
  const skills = loadSkills(projectRoot);
  const eventBus = new RuntimeEventBus(session.id);
  const detachEvents = eventBus.subscribe(async (event) => {
    await events.onEvent?.(event);
    if (event.type === "provider_text_delta") onText(event.text ?? "");
    if (event.type === "provider_thinking_delta") onThinking(event.text ?? "");
    if (event.type === "tool_started")
      onToolStart(event.name ?? "", event.input ?? {});
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
      signal,
      maxInlineTokens: config.context?.maxInlineToolResultTokens,
      maxParallelReads: config.tools?.maxParallelReads,
      requireFreshRead: config.editing?.requireFreshRead,
      checkpoint: () => sessionStore.save(session),
    },
  );
  const dynamic = await collectDynamicContext(projectRoot);
  session.gitBranch = dynamic.gitBranch;
  const system = buildSystemPrompt(
    await loadProjectInstructions(projectRoot),
    dynamic,
    skills,
  );
  const runtime = new AgentRuntime(
    provider,
    new ContextManager(config.context, eventBus),
    {
      selectForTurn: () => tools.catalog.selectForTurn(),
      execute: (calls, signal) => tools.scheduler.execute(calls, signal),
    },
    system,
    eventBus,
  );
  let result: AgentResult;
  try {
    result = await runtime.run(session, prompt, {
      signal,
      onCheckpoint: (current) => sessionStore.save(current),
    });
  } finally {
    detachEvents();
  }
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
    const result = await execa("git", args, { cwd, reject: false });
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
