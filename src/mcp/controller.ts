import { createHash, randomUUID } from "node:crypto";
import type { CredentialStorage } from "../security/credentials.js";
import { CredentialStore } from "../security/credentials.js";
import { McpCredentialResolver } from "./credentials.js";
import type { McpDoctorReport } from "./doctor.js";
import { diagnoseMcp } from "./doctor.js";
import {
  McpConnectionManager,
  type McpDiagnostic,
  type McpServerStatus,
  type McpToolInfo,
} from "./manager.js";
import {
  type McpPermissions,
  type McpServerConfig,
  McpServerSchema,
} from "./schema.js";
import {
  McpConfigStore,
  type McpServerEntry,
  mcpFingerprint,
} from "./storage.js";

export interface McpDraft {
  id: string;
  config: McpServerConfig;
  scope: "global" | "project";
  secrets: Record<string, string>;
}
export interface McpTestPreview {
  server: McpServerStatus;
  tools: McpToolInfo[];
  logs: McpDiagnostic[];
}
export interface OpenTuiMcpActions {
  load(): Promise<void>;
  subscribe(listener: () => void): () => void;
  servers(): McpServerStatus[];
  entry(id: string): McpServerEntry;
  tools(id: string): McpToolInfo[];
  logs(id: string): McpDiagnostic[];
  connect(id: string, signal?: AbortSignal): Promise<void>;
  disconnect(id: string): Promise<void>;
  enable(id: string, value: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  trust(
    id: string,
    fingerprint: string,
    permissions: McpPermissions,
  ): Promise<void>;
  permissions(id: string, value: McpPermissions): Promise<void>;
  authenticate(id: string, secret: string, signal?: AbortSignal): Promise<void>;
  doctor(id?: string, signal?: AbortSignal): Promise<McpDoctorReport[]>;
  test(draft: McpDraft, signal?: AbortSignal): Promise<McpTestPreview>;
  save(draft: McpDraft, permissions: McpPermissions): Promise<void>;
  discard(): Promise<void>;
}

class PreviewConfigStore extends McpConfigStore {
  constructor(
    projectRoot: string,
    private readonly draft: McpDraft,
  ) {
    super(projectRoot);
  }
  override async load(): Promise<McpServerEntry[]> {
    return [
      {
        id: this.draft.id,
        config: this.draft.config,
        scope: "global",
        projectRoot: this.projectRoot,
        fingerprint: mcpFingerprint(this.projectRoot, this.draft.config),
        trusted: true,
        permissions: this.draft.config.permissions,
      },
    ];
  }
}
/** Drafts are tested in memory and credentials are persisted only on Save. */
export class McpController implements OpenTuiMcpActions {
  private preview?: McpConnectionManager;
  private tested?: { signature: string; state: McpServerStatus["state"] };
  constructor(
    readonly manager: McpConnectionManager,
    readonly credentials: CredentialStorage = new CredentialStore(),
  ) {}
  load() {
    return this.manager.reload();
  }
  subscribe(listener: () => void) {
    return this.manager.subscribe(listener);
  }
  servers() {
    return this.manager.list();
  }
  entry(id: string) {
    return this.manager.entry(id);
  }
  tools(id: string) {
    return this.manager.tools(id);
  }
  logs(id: string) {
    return this.manager.logs(id);
  }
  connect(id: string, signal?: AbortSignal) {
    return this.manager.connect(id, signal);
  }
  disconnect(id: string) {
    return this.manager.disconnect(id);
  }
  enable(id: string, value: boolean) {
    return this.manager.setEnabled(id, value);
  }
  remove(id: string) {
    return this.manager.remove(id);
  }
  trust(id: string, fingerprint: string, permissions: McpPermissions) {
    return this.manager.trust(id, fingerprint, permissions);
  }
  permissions(id: string, value: McpPermissions) {
    return this.manager.setPermissions(id, value);
  }
  doctor(id?: string, signal?: AbortSignal) {
    return diagnoseMcp(this.manager, id, signal);
  }
  async authenticate(
    id: string,
    secret: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const entry = this.manager.entry(id);
    if (entry.config.transport.type !== "http" || !entry.trusted)
      throw new Error("Сначала проверьте и доверьте удалённое подключение.");
    if (!secret.trim()) throw new Error("Введите токен доступа.");
    const ref = draftSecretReference();
    await this.credentials.set(ref, secret);
    await this.manager.store.save(
      id,
      { ...entry.config, auth: { token: { secretRef: ref } } },
      entry.scope,
    );
    await this.manager.reload();
    if (entry.scope === "project")
      await this.manager.trust(
        id,
        this.manager.entry(id).fingerprint,
        entry.permissions,
      );
    await this.manager.connect(id, signal);
  }
  async test(draft: McpDraft, signal?: AbortSignal): Promise<McpTestPreview> {
    await this.discard();
    McpServerSchema.parse(draft.config);
    const memory: CredentialStorage = {
      get: async (name) => draft.secrets[name] ?? this.credentials.get(name),
      set: async () => {
        throw new Error("Тест не сохраняет секреты.");
      },
    };
    const manager = new McpConnectionManager(
      new PreviewConfigStore(this.manager.store.projectRoot, draft),
      { credentials: new McpCredentialResolver(memory) },
    );
    this.preview = manager;
    await manager.reload();
    try {
      await manager.connect(draft.id, signal);
    } catch {}
    if (signal?.aborted || this.preview !== manager) {
      if (this.preview === manager) {
        this.preview = undefined;
        this.tested = undefined;
      }
      await manager.dispose();
      throw new Error("Проверка MCP отменена; тестовое подключение закрыто.");
    }
    const server = manager.status(draft.id);
    if (!server) throw new Error("Проверка MCP не завершена.");
    this.tested = {
      signature: createHash("sha256")
        .update(JSON.stringify(draft))
        .digest("hex"),
      state: server.state,
    };
    return {
      server,
      tools: manager.tools(draft.id),
      logs: manager.logs(draft.id),
    };
  }
  async save(draft: McpDraft, permissions: McpPermissions): Promise<void> {
    if (
      !this.tested ||
      this.tested.signature !==
        createHash("sha256").update(JSON.stringify(draft)).digest("hex")
    )
      throw new Error("Сначала проверьте эту конфигурацию.");
    if (
      this.tested.state !== "connected" &&
      this.tested.state !== "authentication_required"
    )
      throw new Error(
        "Подключение не прошло проверку. Исправьте ошибку перед сохранением.",
      );
    if (
      (await this.manager.store.load()).some((entry) => entry.id === draft.id)
    )
      throw new Error("Этот MCP ID уже существует.");
    for (const [ref, secret] of Object.entries(draft.secrets))
      await this.credentials.set(ref, secret);
    await this.manager.store.save(
      draft.id,
      { ...draft.config, permissions },
      draft.scope,
    );
    await this.manager.reload();
    if (draft.scope === "project")
      await this.manager.trust(
        draft.id,
        this.manager.entry(draft.id).fingerprint,
        permissions,
      );
    await this.discard();
    try {
      await this.manager.connect(draft.id);
    } catch {}
  }
  async discard(): Promise<void> {
    const manager = this.preview;
    this.preview = undefined;
    this.tested = undefined;
    await manager?.dispose();
  }
}
export function draftSecretReference(): string {
  return `mcp/${randomUUID()}`;
}
