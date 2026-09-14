import Anthropic from "@anthropic-ai/sdk";
import { execa } from "execa";
import OpenAI from "openai";
import {
  loadGlobalConfig,
  loadProjectConfig,
  loadProjectInstructions,
} from "../config/load.js";
import { AgentLoop } from "../core/agent-loop.js";
import { buildSystemPrompt, type DynamicContext } from "../core/prompt.js";
import {
  AnthropicAdapter,
  AnthropicCompatibleAdapter,
} from "../providers/anthropic.js";
import { OpenAIAdapter, OpenAICompatibleAdapter } from "../providers/openai.js";
import { ApprovalGate, type ApprovalResolver } from "../security/approval.js";
import { CredentialStore } from "../security/credentials.js";
import { createSession, loadSession, saveSession } from "../sessions/store.js";
import { ToolRegistry } from "../tools/registry.js";
import type {
  AgentResult,
  ProviderAdapter,
  ProviderKind,
  ToolExecutionResult,
  ToolName,
} from "../types/domain.js";
import { exitCodeFor, OneShotRenderer } from "../ui/one-shot.js";

export interface RunEventHandlers {
  onText?(text: string): void;
  onThinking?(text: string): void;
  onToolStart?(name: string, input: Record<string, unknown>): void;
  onToolResult?(name: string, result: ToolExecutionResult): void;
}

export interface RunOptions {
  provider?: ProviderKind;
  model?: string;
  baseUrl?: string;
  yes?: boolean;
  allow?: string;
  json?: boolean;
  resume?: string;
  cwd?: string;
}

export class MissingApiKeyError extends Error {
  constructor(provider: ProviderKind) {
    super(
      `Для ${providerLabel(provider)} не найден API-ключ. Запустите "chisel setup" для быстрой настройки.`,
    );
    this.name = "MissingApiKeyError";
  }
}

export async function hasApiKey(
  provider: ProviderKind,
  keyRef?: string,
): Promise<boolean> {
  return Boolean(await resolveApiKey(provider, keyRef, new CredentialStore()));
}

export interface ConnectionCheckInput {
  provider: ProviderKind;
  baseUrl?: string;
  model?: string;
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
  const global = await loadGlobalConfig(options?.configPath);
  const providerConfig = global.providers[input.provider];
  const apiKey = await resolveApiKey(
    input.provider,
    providerConfig?.apiKeyRef,
    new CredentialStore(),
  );
  if (!apiKey)
    return {
      ok: false,
      message: `Нет API-ключа для ${providerLabel(input.provider)}: пройдите настройку заново и вставьте ключ.`,
    };
  const baseUrl = input.baseUrl ?? providerConfig?.baseUrl;
  let adapter: ProviderAdapter;
  try {
    adapter = createProvider(input.provider, apiKey, baseUrl);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  let models: { id: string }[];
  try {
    models = await withTimeout(
      adapter.listModels(),
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

function connectionErrorStatus(error: unknown): number | undefined {
  if (error instanceof OpenAI.APIError) return error.status;
  if (error instanceof Anthropic.APIError) return error.status;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function formatConnectionError(error: unknown, baseUrl?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = connectionErrorStatus(error);
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
): Promise<{ result: AgentResult; exitCode: number }> {
  const projectRoot = options.cwd ?? process.cwd();
  const config = await loadProjectConfig(projectRoot);
  const global = await loadGlobalConfig();
  const session = options.resume
    ? await loadSession(options.resume)
    : createSession(
        projectRoot,
        resolveProvider(options, global.defaultProvider),
        resolveModel(options, global.defaultModel),
      );

  if (session.projectPath !== projectRoot) {
    throw new Error(
      `Session ${session.id} belongs to ${session.projectPath}, not ${projectRoot}.`,
    );
  }

  const providerConfig = global.providers[session.provider];
  const credentials = new CredentialStore();
  const apiKey = await resolveApiKey(
    session.provider,
    providerConfig?.apiKeyRef,
    credentials,
  );
  if (!apiKey) throw new MissingApiKeyError(session.provider);
  const provider = createProvider(
    session.provider,
    apiKey,
    options.baseUrl ?? providerConfig?.baseUrl,
  );
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
  const registry = new ToolRegistry(
    projectRoot,
    config.ignorePatterns,
    approvalGate,
    session,
  );
  const dynamic = await collectDynamicContext(projectRoot);
  const system = buildSystemPrompt(
    await loadProjectInstructions(projectRoot),
    dynamic,
  );
  const loop = new AgentLoop(provider, registry, system, {
    onText,
    onThinking,
    onToolStart,
    onToolResult,
  });

  const result = await loop.run(session, prompt);
  await saveSession(result.session);
  if (
    !events.onText &&
    !events.onThinking &&
    !events.onToolStart &&
    !events.onToolResult
  )
    renderer.complete(result);
  return { result, exitCode: exitCodeFor(result) };
}

function resolveProvider(
  options: RunOptions,
  fallback?: ProviderKind,
): ProviderKind {
  return options.provider ?? fallback ?? "anthropic";
}

function resolveModel(options: RunOptions, fallback?: string): string {
  return options.model ?? fallback ?? "claude-opus-5";
}

function createProvider(
  kind: ProviderKind,
  apiKey: string | undefined,
  baseUrl: string | undefined,
): ProviderAdapter {
  if (kind === "anthropic") return new AnthropicAdapter({ apiKey });
  if (kind === "anthropic-compatible") {
    if (!apiKey) throw new MissingApiKeyError(kind);
    return new AnthropicCompatibleAdapter({ authToken: apiKey, baseUrl });
  }
  if (kind === "openai") return new OpenAIAdapter({ apiKey });
  return new OpenAICompatibleAdapter({ apiKey, baseUrl });
}

async function resolveApiKey(
  kind: ProviderKind,
  keyRef: string | undefined,
  credentials: CredentialStore,
): Promise<string | undefined> {
  const environmentName =
    kind === "anthropic-compatible"
      ? "ANTHROPIC_AUTH_TOKEN"
      : kind === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : "OPENAI_API_KEY";
  if (process.env[environmentName]) return process.env[environmentName];
  return keyRef ? credentials.get(keyRef) : undefined;
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
    gitStatus: gitStatus || undefined,
    fileTree: await collectFileTree(cwd),
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

async function collectFileTree(root: string): Promise<string> {
  const ignored = new Set([".git", "node_modules", ".chisel"]);
  const entries: string[] = [];
  for await (const file of new Bun.Glob("**/*").scan({
    cwd: root,
    onlyFiles: true,
  })) {
    const first = file.split(/[\\/]/)[0];
    if (first && ignored.has(first)) continue;
    entries.push(file);
    if (entries.length >= 200) break;
  }
  return entries.join("\n");
}

function providerLabel(provider: ProviderKind): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "anthropic-compatible") return "Anthropic-совместимого API";
  if (provider === "openai") return "OpenAI";
  return "OpenAI-совместимого API";
}

export const nonInteractiveResolver: ApprovalResolver = {
  async requestApproval() {
    return "unavailable";
  },
};
