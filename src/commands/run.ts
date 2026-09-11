import { execa } from "execa";
import {
  loadGlobalConfig,
  loadProjectConfig,
  loadProjectInstructions,
} from "../config/load.js";
import { AgentLoop } from "../core/agent-loop.js";
import { buildSystemPrompt, type DynamicContext } from "../core/prompt.js";
import { AnthropicAdapter } from "../providers/anthropic.js";
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
  if (kind === "openai") return new OpenAIAdapter({ apiKey });
  return new OpenAICompatibleAdapter({ apiKey, baseUrl });
}

async function resolveApiKey(
  kind: ProviderKind,
  keyRef: string | undefined,
  credentials: CredentialStore,
): Promise<string | undefined> {
  const environmentName =
    kind === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
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

export const nonInteractiveResolver: ApprovalResolver = {
  async requestApproval() {
    return "unavailable";
  },
};
