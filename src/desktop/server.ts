import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { runExtensionCommand } from "../app/run-command.js";
import {
  listProviderModels,
  type RunOptions,
  runPrompt,
} from "../app/run-prompt.js";
import type { SubagentControls } from "../app/subagent-binding.js";
import type { BackgroundControls } from "../background/binding.js";
import { BACKGROUND_LIMITS } from "../background/config.js";
import { loadGlobalConfig, updateGlobalConfig } from "../config/load.js";
import { ProfileIdSchema } from "../config/schema.js";
import { applicationExtensions } from "../extensions/composition.js";
import { canonicalWorkspaceRoot, ExtensionHost } from "../extensions/host.js";
import { gitCommand } from "../git/driver.js";
import { McpController } from "../mcp/controller.js";
import { McpConnectionManager } from "../mcp/manager.js";
import { McpServerIdSchema, McpServerSchema } from "../mcp/schema.js";
import { McpConfigStore } from "../mcp/storage.js";
import { getProviderCatalog } from "../providers/catalog.js";
import type {
  ApprovalResolver,
  ApprovalDecision as CoreDecision,
} from "../security/approval.js";
import { CredentialStore } from "../security/credentials.js";
import { SecretRedactor } from "../security/redaction.js";
import {
  projectSessionStore,
  SessionProjectRegistry,
} from "../sessions/project-store.js";
import { createSession } from "../sessions/store.js";
import { expandSkill, loadSkills } from "../skills/skills.js";
import type { Session as CoreSession } from "../types/domain.js";
import { readGitWorkingState } from "../ui/git-changes.js";
import { VERSION } from "../version.js";
import {
  DESKTOP_PROTOCOL,
  type EngineEvent,
  type Json,
  type Message,
  type Method,
  type PermissionMode,
  type Profile,
  type Session,
  type StartTurn,
} from "./protocol.js";

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolute, "Нужен абсолютный путь проекта.");
const sessionId = z.uuid();
const project = z.strictObject({ path });
const session = z.strictObject({ path, sessionId });
const empty = z.strictObject({});
const schemas = {
  "system/status": empty,
  initialize: z.strictObject({
    protocolMajor: z.number().int(),
    clientVersion: z.string().max(80),
  }),
  "projects/list": empty,
  "projects/open": project,
  "profiles/list": empty,
  "profiles/save": z.strictObject({
    id: ProfileIdSchema,
    providerId: z.string().min(1).max(128),
    label: z.string().max(100).optional(),
    model: z.string().min(1).max(256),
    baseUrl: z.url().optional(),
    apiKey: z.string().max(16_384).optional(),
  }),
  "models/list": z.strictObject({ profileId: ProfileIdSchema }),
  "sessions/list": project,
  "sessions/create": z.strictObject({
    path,
    profileId: ProfileIdSchema.optional(),
    model: z.string().max(256).optional(),
  }),
  "sessions/read": session,
  "sessions/rename": z.strictObject({
    path,
    sessionId,
    title: z.string().trim().min(1).max(120),
  }),
  "sessions/delete": session,
  "turn/start": z.strictObject({
    path,
    sessionId,
    prompt: z.string().trim().min(1).max(256_000),
    profileId: ProfileIdSchema.optional(),
    model: z.string().max(256).optional(),
    mode: z.enum(["plan", "build"]),
    approvalMode: z.enum(["default", "acceptEdits", "dontAsk"]),
  }),
  "turn/cancel": z.strictObject({ sessionId }),
  "approvals/respond": z.strictObject({
    requestId: z.uuid(),
    decision: z.enum([
      "approved",
      "approved_always",
      "approved_session",
      "denied",
    ]),
  }),
  "git/status": project,
  "git/diff": z.strictObject({ path, file: z.string().min(1).max(4096) }),
  "skills/list": project,
  "commands/list": project,
  "mcp/list": project,
  "mcp/save": z.strictObject({
    path,
    id: McpServerIdSchema,
    config: McpServerSchema,
  }),
  "mcp/action": z.strictObject({
    path,
    id: McpServerIdSchema,
    action: z.enum([
      "connect",
      "disconnect",
      "enable",
      "disable",
      "remove",
      "trust",
    ]),
  }),
  "tasks/list": session,
  "tasks/inspect": z.strictObject({
    sessionId,
    id: z.uuid(),
    view: z.enum(["history", "changes"]),
  }),
  "tasks/cancel": z.strictObject({ sessionId, id: z.uuid() }),
  "settings/read": empty,
  "settings/patch": z.strictObject({
    section: z.enum(["web", "lsp"]),
    value: z.unknown(),
  }),
  shutdown: empty,
} satisfies Record<Method, z.ZodType>;

export class DesktopError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
interface Conversation {
  path: string;
  abort: AbortController;
  turnId: string;
  run?: Promise<void>;
  children?: SubagentControls;
  background?: BackgroundControls;
  owner: AbortController;
}
/** UI-independent application adapter. Core retains all tools, policy and persistence. */
export class DesktopServer {
  private host?: Promise<ExtensionHost>;
  private managers = new Map<string, McpConnectionManager>();
  private conversations = new Map<string, Conversation>();
  private approvals = new Map<
    string,
    { sessionId: string; resolve(value: CoreDecision): void }
  >();
  private initialized = false;
  private closed = false;
  private sequence = 0;
  private redactor = new SecretRedactor();
  constructor(
    private readonly emit: (event: EngineEvent) => void | Promise<void>,
    private readonly configPath?: string,
  ) {}
  private json(value: unknown): Json {
    return JSON.parse(JSON.stringify(this.redactor.value(value))) as Json;
  }
  sanitizeError(error: unknown): string {
    return this.redactor.text(
      error instanceof Error ? error.message : "Не удалось выполнить действие.",
    );
  }
  private event(
    type: EngineEvent["params"]["type"],
    sessionId: string,
    turnId: string,
    data: unknown,
  ) {
    return this.emit({
      jsonrpc: "2.0",
      method: "event",
      params: {
        sequence: ++this.sequence,
        type,
        sessionId,
        turnId,
        data: this.json(data),
      },
    });
  }
  private async root(input: string): Promise<string> {
    const root = await canonicalWorkspaceRoot(input);
    if (!(await stat(root)).isDirectory())
      throw new DesktopError("INVALID_PROJECT", "Выберите папку проекта.");
    return root;
  }
  private extensions(): Promise<ExtensionHost> {
    this.host ??= applicationExtensions({
      configPath: this.configPath,
    }).then((definitions) => new ExtensionHost(definitions));
    return this.host;
  }
  private async scope(root: string) {
    return (await this.extensions()).open(root);
  }
  private async manager(root: string): Promise<McpConnectionManager> {
    let manager = this.managers.get(root);
    if (!manager) {
      manager = new McpConnectionManager(
        new McpConfigStore(root, { globalPath: this.configPath }),
      );
      this.managers.set(root, manager);
    }
    await manager.reload();
    return manager;
  }
  private async profiles() {
    const global = await loadGlobalConfig(this.configPath);
    const { registry } = await getProviderCatalog();
    const store = new CredentialStore();
    const profiles: Profile[] = [];
    for (const [id, item] of Object.entries(global.profiles)) {
      const key = item.apiKeyRef ? await store.get(item.apiKeyRef) : undefined;
      if (key) this.redactor.add(key);
      const definition = registry.get(item.providerId);
      for (const name of definition?.auth.envVars ?? [])
        if (process.env[name]) this.redactor.add(process.env[name]!);
      profiles.push({
        id,
        providerId: item.providerId,
        label: item.label ?? id,
        model: item.defaultModel ?? definition?.defaults.model ?? "",
        baseUrl: item.baseUrl,
        hasKey:
          Boolean(key) ||
          !definition?.auth.required ||
          Boolean(definition?.auth.envVars.some((name) => process.env[name])),
      });
    }
    return {
      profiles,
      providers: registry.list().map((item) => ({
        id: item.id,
        label: item.label,
        defaultModel: item.defaults.model,
        defaultBaseUrl: item.endpoint.defaultBaseUrl,
        requiresKey: item.auth.required,
        requiresEndpoint: item.endpoint.required,
      })),
      defaultProfileId: global.defaultProfileId,
    };
  }
  private view(core: CoreSession): Session {
    const messages: Message[] = [];
    const tools = new Map<string, string>();
    const presentations = new Map<
      number,
      NonNullable<CoreSession["chatPresentations"]>
    >();
    for (const record of core.chatPresentations ?? []) {
      const group = presentations.get(record.afterMessage) ?? [];
      group.push(record);
      presentations.set(record.afterMessage, group);
    }
    const appendPresentations = (afterMessage: number) => {
      for (const [index, record] of (
        presentations.get(afterMessage) ?? []
      ).entries()) {
        const view = record.presentation.view;
        const text = [
          view.summary,
          ...(view.cards ?? []).map((card) =>
            [
              card.title,
              card.subtitle,
              card.description,
              card.detail,
              card.status?.label,
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
        ]
          .filter(Boolean)
          .join("\n\n");
        if (text)
          messages.push({
            id: `${core.id}:command:${afterMessage}:${index}`,
            role: "command",
            text,
          });
      }
    };
    appendPresentations(0);
    for (const [i, message] of core.messages.entries()) {
      for (const [j, content] of message.content.entries()) {
        const id = `${core.id}:${i}:${j}`;
        if (content.type === "text" && content.text)
          messages.push({ id, role: message.role, text: content.text });
        if (content.type === "tool_use") tools.set(content.id, content.name);
        if (content.type === "tool_result") {
          const result = core.runtime?.invocations[content.toolUseId]?.result;
          const diff = core.fileDiffs?.[content.toolUseId] ?? result?.fileDiff;
          messages.push({
            id,
            role: "tool",
            tool: tools.get(content.toolUseId) ?? "Инструмент",
            text: content.content,
            isError: content.isError,
            diffs: result?.diffs ?? (diff ? [diff] : undefined),
          });
        }
      }
      appendPresentations(i + 1);
    }
    const approvalMode: PermissionMode =
      core.approvalMode === "acceptEdits" || core.approvalMode === "dontAsk"
        ? core.approvalMode
        : "default";
    return this.redactor.value({
      id: core.id,
      projectPath: core.projectPath,
      title: core.title ?? "Новая беседа",
      updatedAt: core.updatedAt,
      model: core.model,
      profileId: core.profileId ?? "",
      messageCount: core.messages.length,
      messages,
      mode: core.mode ?? "build",
      approvalMode,
      active: !!this.conversations.get(core.id)?.run,
      totalTokens: core.totalTokens.inputTokens + core.totalTokens.outputTokens,
      totalCost: core.totalCost,
      children: this.json(core.children ?? {}),
      backgroundTasks: this.json(core.backgroundTasks ?? {}),
    });
  }
  async dispatch(method: string, input: unknown): Promise<unknown> {
    if (this.closed)
      throw new DesktopError("SERVER_CLOSED", "Ядро завершает работу.");
    if (!Object.hasOwn(schemas, method))
      throw new DesktopError(
        "METHOD_NOT_FOUND",
        "Ядро не поддерживает это действие.",
      );
    const parsed = schemas[method as Method].safeParse(input);
    if (!parsed.success)
      throw new DesktopError(
        "INVALID_PARAMS",
        parsed.error.issues
          .map((item) => `${item.path.join(".")}: ${item.message}`)
          .join("; "),
      );
    if (method === "initialize") {
      const p = parsed.data as z.infer<typeof schemas.initialize>;
      if (p.protocolMajor !== DESKTOP_PROTOCOL.major)
        throw new DesktopError(
          "PROTOCOL_MISMATCH",
          "Версии desktop и ядра несовместимы. Установите подходящий выпуск приложения.",
        );
      this.initialized = true;
      await this.profiles();
      return {
        engineVersion: VERSION,
        protocol: DESKTOP_PROTOCOL,
        sessionSchemaVersion: 3,
        capabilities: [
          "sessions",
          "approvals",
          "git",
          "skills",
          "mcp",
          "commands",
          "subagents",
          "background",
          "worktrees",
          "settings",
        ],
      };
    }
    if (!this.initialized)
      throw new DesktopError(
        "NOT_INITIALIZED",
        "Сначала согласуйте протокол с ядром.",
      );
    switch (method as Method) {
      case "system/status":
        return {
          busy: [...this.conversations.values()].some(
            (conversation) =>
              !!conversation.run ||
              conversation.children?.busy() ||
              conversation.background?.busy(),
          ),
        };
      case "projects/list":
        return new SessionProjectRegistry().list();
      case "projects/open": {
        const p = parsed.data as z.infer<(typeof schemas)["projects/open"]>;
        return (await projectSessionStore(await this.root(p.path))).project;
      }
      case "profiles/list":
        return this.profiles();
      case "profiles/save": {
        const p = parsed.data as z.infer<(typeof schemas)["profiles/save"]>;
        const { registry } = await getProviderCatalog();
        registry.require(p.providerId);
        if (p.baseUrl) {
          const url = new URL(p.baseUrl);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new DesktopError(
              "INVALID_ENDPOINT",
              "Адрес API должен быть HTTP/HTTPS без пароля в URL.",
            );
        }
        const keyRef = `desktop-profile:${p.id}`;
        if (p.apiKey) {
          this.redactor.add(p.apiKey);
          await new CredentialStore().set(keyRef, p.apiKey);
        }
        await updateGlobalConfig(this.configPath, (global) => {
          const prior = global.profiles[p.id];
          global.profiles[p.id] = {
            providerId: p.providerId,
            label: p.label,
            defaultModel: p.model,
            ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
            ...(p.apiKey
              ? { apiKeyRef: keyRef }
              : prior?.providerId === p.providerId && prior.apiKeyRef
                ? { apiKeyRef: prior.apiKeyRef }
                : {}),
          };
          global.defaultProfileId ??= p.id;
          return global;
        });
        return (await this.profiles()).profiles.find(
          (item) => item.id === p.id,
        );
      }
      case "models/list": {
        const p = parsed.data as z.infer<(typeof schemas)["models/list"]>;
        const profile = (await this.profiles()).profiles.find(
          (item) => item.id === p.profileId,
        );
        if (!profile)
          throw new DesktopError(
            "PROFILE_NOT_FOUND",
            "Выберите настроенный профиль.",
          );
        const result = await listProviderModels(
          { provider: profile.providerId, profileId: profile.id },
          { configPath: this.configPath },
        );
        if (!result.ok) throw new Error(result.error);
        return result.models.map((model) => ({ id: model.id, name: model.id }));
      }
      case "sessions/list": {
        const p = parsed.data as z.infer<(typeof schemas)["sessions/list"]>;
        return (
          await (await projectSessionStore(await this.root(p.path))).list()
        ).filter((item) => !item.subagentOwnerId && !item.backgroundOwnerId);
      }
      case "sessions/create": {
        const p = parsed.data as z.infer<(typeof schemas)["sessions/create"]>;
        const root = await this.root(p.path);
        const catalog = await this.profiles();
        const profile =
          catalog.profiles.find(
            (item) => item.id === (p.profileId ?? catalog.defaultProfileId),
          ) ?? catalog.profiles[0];
        const item = createSession(
          root,
          profile?.providerId ?? "openai",
          p.model ?? profile?.model ?? "",
        );
        if (profile) item.profileId = profile.id;
        await (await projectSessionStore(root)).save(item);
        return this.view(item);
      }
      case "sessions/read": {
        const p = parsed.data as z.infer<(typeof schemas)["sessions/read"]>;
        const item = await (
          await projectSessionStore(await this.root(p.path))
        ).load(p.sessionId);
        if (item.subagent || item.backgroundExecution)
          throw new DesktopError(
            "CHILD_SESSION",
            "История задачи доступна через просмотр помощника.",
          );
        return this.view(item);
      }
      case "sessions/rename":
      case "sessions/delete": {
        const p = parsed.data as z.infer<(typeof schemas)["sessions/rename"]>;
        if (this.conversations.get(p.sessionId)?.run)
          throw new DesktopError(
            "SESSION_BUSY",
            "Дождитесь завершения задачи.",
          );
        const store = await projectSessionStore(await this.root(p.path));
        if (method === "sessions/rename")
          await store.rename(p.sessionId, p.title);
        else {
          await this.closeConversation(p.sessionId);
          await store.delete(p.sessionId);
        }
        return { ok: true };
      }
      case "turn/start":
        return this.start(parsed.data as StartTurn);
      case "turn/cancel": {
        const p = parsed.data as z.infer<(typeof schemas)["turn/cancel"]>;
        const conversation = this.conversations.get(p.sessionId);
        conversation?.abort.abort();
        await conversation?.children?.cancel();
        return { ok: true };
      }
      case "approvals/respond": {
        const p = parsed.data as z.infer<(typeof schemas)["approvals/respond"]>;
        const approval = this.approvals.get(p.requestId);
        if (!approval)
          throw new DesktopError(
            "APPROVAL_EXPIRED",
            "Запрос подтверждения уже закрыт.",
          );
        this.approvals.delete(p.requestId);
        approval.resolve(p.decision);
        return { ok: true };
      }
      case "git/status":
        return (
          (await readGitWorkingState(
            await this.root((parsed.data as { path: string }).path),
          )) ?? null
        );
      case "git/diff": {
        const p = parsed.data as z.infer<(typeof schemas)["git/diff"]>;
        const root = await this.root(p.path);
        if (isAbsolute(p.file) || p.file.split(/[\\/]/).includes(".."))
          throw new DesktopError(
            "INVALID_PATH",
            "Файл должен находиться в проекте.",
          );
        const patch = await gitCommand(root, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
          "--",
          p.file,
        ]).catch(() =>
          gitCommand(root, [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            p.file,
          ]),
        );
        return { patch: this.redactor.text(patch) };
      }
      case "skills/list":
        return loadSkills(
          await this.root((parsed.data as { path: string }).path),
        ).map((skill) => ({
          name: skill.name,
          description: skill.description ?? "",
          source: skill.source,
        }));
      case "commands/list":
        return (
          await this.scope(
            await this.root((parsed.data as { path: string }).path),
          )
        ).commands
          .descriptors()
          .map((item) => ({
            name: item.name,
            description: item.description,
            usage: item.usage,
          }));
      case "mcp/list":
        return this.json(
          (
            await this.manager(
              await this.root((parsed.data as { path: string }).path),
            )
          ).list(),
        );
      case "mcp/save": {
        const p = parsed.data as z.infer<(typeof schemas)["mcp/save"]>;
        const manager = await this.manager(await this.root(p.path));
        const controller = new McpController(manager);
        const draft = {
          id: p.id,
          config: p.config,
          scope: "global" as const,
          secrets: {},
        };
        try {
          await controller.test(draft);
          await controller.save(draft, p.config.permissions);
        } finally {
          await controller.discard();
        }
        return { ok: true };
      }
      case "mcp/action": {
        const p = parsed.data as z.infer<(typeof schemas)["mcp/action"]>;
        const actions = new McpController(
          await this.manager(await this.root(p.path)),
        );
        if (p.action === "trust") {
          const entry = actions.entry(p.id);
          await actions.trust(p.id, entry.fingerprint, entry.permissions);
        } else if (p.action === "enable" || p.action === "disable")
          await actions.enable(p.id, p.action === "enable");
        else await actions[p.action](p.id);
        return { ok: true };
      }
      case "tasks/list": {
        const p = parsed.data as z.infer<(typeof schemas)["tasks/list"]>;
        const core = await (
          await projectSessionStore(await this.root(p.path))
        ).load(p.sessionId);
        const background = this.conversations.get(p.sessionId)?.background;
        return this.json({
          children: core.children ?? {},
          background: background
            ? Object.fromEntries(
                (await background.list()).map((task) => [task.id, task]),
              )
            : (core.backgroundTasks ?? {}),
        });
      }
      case "tasks/inspect": {
        const p = parsed.data as z.infer<(typeof schemas)["tasks/inspect"]>;
        const conversation = this.conversations.get(p.sessionId);
        const background = conversation?.background;
        if (
          background &&
          (await background.list()).some((task) => task.id === p.id)
        ) {
          const task = await background.port.status(p.id);
          const output = await background.port.readOutput(
            p.id,
            undefined,
            BACKGROUND_LIMITS.pageBytes,
          );
          return {
            text: this.redactor.text(
              `${task.label}\n${task.state}\n\n${output.text}`,
            ),
          };
        }
        const controls = conversation?.children;
        if (!controls)
          throw new DesktopError(
            "TASK_UNAVAILABLE",
            "Просмотр живой задачи доступен в исходной беседе.",
          );
        return this.redactor.value(await controls.inspect(p.id, p.view));
      }
      case "tasks/cancel": {
        const p = parsed.data as z.infer<(typeof schemas)["tasks/cancel"]>;
        const conversation = this.conversations.get(p.sessionId);
        const background = conversation?.background;
        if (
          background &&
          (await background.list()).some((task) => task.id === p.id)
        ) {
          await background.port.stop(p.id);
          return { ok: true };
        }
        const controls = conversation?.children;
        if (!controls)
          throw new DesktopError(
            "TASK_UNAVAILABLE",
            "В этой беседе нет активных помощников.",
          );
        await controls.port.cancel(p.id);
        return { ok: true };
      }
      case "settings/read": {
        const config = await loadGlobalConfig(this.configPath);
        return this.json({
          web: config.web ?? {},
          lsp: config.lsp ?? {},
          permissions: config.permissions ?? {},
        });
      }
      case "settings/patch": {
        const p = parsed.data as z.infer<(typeof schemas)["settings/patch"]>;
        await updateGlobalConfig(this.configPath, (config) => ({
          ...config,
          [p.section]: p.value,
        }));
        return { ok: true };
      }
      case "shutdown":
        await this.dispose();
        return { ok: true };
    }
  }
  private async start(input: StartTurn) {
    const root = await this.root(input.path);
    const existing = this.conversations.get(input.sessionId);
    if (existing?.run)
      throw new DesktopError(
        "SESSION_BUSY",
        "В этой беседе уже выполняется задача.",
      );
    const stored = await (await projectSessionStore(root)).load(
      input.sessionId,
    );
    if (stored.subagent || stored.backgroundExecution)
      throw new DesktopError(
        "CHILD_SESSION",
        "Создайте обычную беседу для новой задачи.",
      );
    const turnId = randomUUID();
    const conversation: Conversation = existing ?? {
      path: root,
      abort: new AbortController(),
      turnId,
      owner: new AbortController(),
    };
    if (conversation.path !== root)
      throw new DesktopError(
        "INVALID_PROJECT",
        "Беседа принадлежит другому проекту.",
      );
    conversation.abort = new AbortController();
    conversation.turnId = turnId;
    this.conversations.set(input.sessionId, conversation);
    // Execution starts after the accepted response has been put on the transport.
    conversation.run = new Promise<void>((done) =>
      setTimeout(() => {
        void this.execute(input, conversation).finally(done);
      }, 0),
    );
    return { turnId, sessionId: input.sessionId };
  }
  private async execute(
    input: StartTurn,
    conversation: Conversation,
  ): Promise<void> {
    const { turnId, abort } = conversation;
    const resolver: ApprovalResolver = {
      requestApproval: (request, signal) =>
        new Promise((resolveApproval) => {
          const requestId = randomUUID();
          let settled = false;
          const finish = (decision: CoreDecision) => {
            if (settled) return;
            settled = true;
            this.approvals.delete(requestId);
            signal?.removeEventListener("abort", cancel);
            resolveApproval(decision);
            void this.event("approval.resolved", input.sessionId, turnId, {
              requestId,
            });
          };
          const cancel = () => finish("denied");
          if (signal?.aborted) {
            finish("denied");
            return;
          }
          this.approvals.set(requestId, {
            sessionId: input.sessionId,
            resolve: finish,
          });
          signal?.addEventListener("abort", cancel, { once: true });
          void Promise.resolve(
            this.event("approval.requested", input.sessionId, turnId, {
              requestId,
              sessionId: input.sessionId,
              turnId,
              tool: request.tool,
              preview: request.preview,
              command: request.command,
              diffs:
                request.diffs ?? (request.fileDiff ? [request.fileDiff] : []),
              ownerLabel: request.owner?.label,
            }),
          ).catch(cancel);
        }),
    };
    try {
      await this.event("turn.started", input.sessionId, turnId, {});
      const scope = await this.scope(conversation.path);
      const options: RunOptions = {
        cwd: conversation.path,
        resume: input.sessionId,
        profile: input.profileId || undefined,
        model: input.model || undefined,
        mode: input.mode,
        approvalMode: input.approvalMode,
        configPath: this.configPath,
        interactive: true,
        mcpManager: await this.manager(conversation.path),
        subagentOwner: {
          conversationId: input.sessionId,
          generation: 0,
          signal: conversation.owner.signal,
          assertAvailable: () => {
            if (conversation.owner.signal.aborted)
              throw new Error("Беседа закрыта.");
          },
          modelOptions: () => ({
            profile: input.profileId,
            model: input.model,
          }),
        },
      };
      const handlers = {
        onText: () => {},
        onThinking: () => {},
        onToolStart: () => {},
        onToolResult: () => {},
        onEvent: (event: unknown) =>
          this.event("runtime", input.sessionId, turnId, event),
        onSubagent: (event: unknown) => {
          void this.event("subagent", input.sessionId, turnId, event);
        },
        onSubagentControls: (controls: SubagentControls) => {
          conversation.children = controls;
        },
        onBackground: (event: unknown) => {
          void this.event("background", input.sessionId, turnId, event);
        },
        onBackgroundControls: (controls: BackgroundControls) => {
          conversation.background = controls;
        },
        onOpenWorktree: async (descriptor: { path: string }) => {
          await this.event(
            "worktree.opened",
            input.sessionId,
            turnId,
            descriptor,
          );
        },
      };
      const head = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(input.prompt);
      let result: { status?: string; error?: string };
      if (head) {
        const command = scope.commands.get(head[1]!);
        if (command) {
          if (command.executionPolicy === "side_query")
            throw new DesktopError(
              "SIDE_QUERY_UNAVAILABLE",
              "Побочные вопросы пока доступны в терминале. Откройте отдельную беседу для параллельного вопроса.",
            );
          const outcome = await runExtensionCommand(
            { command, input: command.parse(head[2] ?? "") },
            scope,
            options,
            resolver,
            handlers,
            abort.signal,
          );
          await this.event("runtime", input.sessionId, turnId, {
            type: "command_result",
            name: command.name,
            result: outcome.result,
          });
          result = {
            status: outcome.result.isError ? "failed" : "completed",
            error: outcome.result.isError ? outcome.result.output : undefined,
          };
        } else {
          const skill = loadSkills(conversation.path).find(
            (item) => item.name === head[1],
          );
          if (!skill)
            throw new DesktopError(
              "COMMAND_NOT_FOUND",
              "Команда недоступна. Используйте настройки приложения или выберите команду из списка.",
            );
          result = (
            await runPrompt(
              expandSkill(skill, head[2] ?? ""),
              options,
              resolver,
              handlers,
              abort.signal,
              { scope },
            )
          ).result;
        }
      } else
        result = (
          await runPrompt(
            input.prompt,
            options,
            resolver,
            handlers,
            abort.signal,
            { scope },
          )
        ).result;
      conversation.run = undefined;
      await this.event("turn.completed", input.sessionId, turnId, {
        status: result.status ?? "completed",
        error: result.error,
      });
    } catch (error) {
      conversation.run = undefined;
      await this.event("turn.completed", input.sessionId, turnId, {
        status: abort.signal.aborted ? "cancelled" : "failed",
        error: this.sanitizeError(error),
      });
    } finally {
      conversation.run = undefined;
    }
  }
  private async closeConversation(id: string) {
    const conversation = this.conversations.get(id);
    if (!conversation) return;
    conversation.owner.abort();
    conversation.abort.abort();
    for (const approval of this.approvals.values())
      if (approval.sessionId === id) approval.resolve("denied");
    await conversation.run;
    await Promise.allSettled([
      conversation.children?.close(),
      conversation.background?.close(),
    ]);
    this.conversations.delete(id);
  }
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(
      [...this.conversations.keys()].map((id) => this.closeConversation(id)),
    );
    await Promise.allSettled(
      [...this.managers.values()].map((manager) => manager.dispose()),
    );
    if (this.host) await (await this.host).dispose();
  }
}
