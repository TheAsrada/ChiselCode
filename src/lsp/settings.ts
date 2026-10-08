import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadGlobalConfig, updateGlobalConfig } from "../config/load.js";
import { canonicalWorkspaceRoot } from "../extensions/host.js";
import { cancelled } from "../runtime/errors.js";
import type { ToolExecutionResult } from "../types/domain.js";
import {
  type LspConfig,
  LspConfigSchema,
  type LspServerConfig,
  type ProjectLspConfig,
  ProjectLspConfigSchema,
  validateLspLaunch,
} from "./config.js";
import type { LspStatus } from "./service.js";

export interface LspSettingsState {
  workspaceRoot: string;
  global: LspConfig;
  project: ProjectLspConfig;
  projectRevision: string;
  globalRevision: string;
  status: LspStatus;
}
export interface LspSettingsActions {
  load(signal?: AbortSignal): Promise<LspSettingsState>;
  saveGlobal(
    config: LspConfig,
    expectedRevision?: string,
  ): Promise<LspSettingsState>;
  saveProject(
    config: ProjectLspConfig,
    expectedRevision: string,
  ): Promise<LspSettingsState>;
  trust(serverId: string, allowed: boolean): Promise<LspSettingsState>;
  check(
    serverId: string,
    config: LspServerConfig,
    signal?: AbortSignal,
  ): Promise<string>;
  restart(serverId?: string): Promise<ToolExecutionResult>;
}
export interface LspSettingsRuntime {
  status(): Promise<LspStatus>;
  apply(): Promise<void>;
  restart(serverId?: string): Promise<ToolExecutionResult>;
}
const revision = (source: string) =>
  createHash("sha256").update(source).digest("hex");
async function projectSource(root: string): Promise<string> {
  try {
    return await readFile(join(root, ".chiselrc"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
function projectObject(source: string): Record<string, unknown> {
  try {
    const value = source ? JSON.parse(source) : {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new Error(
      "Некорректный .chiselrc JSON. Файл не изменён; исправьте его и повторите.",
    );
  }
}
/** Only typed LSP fields are written. No install, shell evaluation or model credentials. */
export class LspSettingsStore implements LspSettingsActions {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly root: string,
    private readonly configPath: string | undefined,
    private readonly runtime: LspSettingsRuntime,
  ) {}
  async load(signal?: AbortSignal): Promise<LspSettingsState> {
    cancelled(signal);
    const root = await canonicalWorkspaceRoot(this.root);
    const [global, source, status] = await Promise.all([
      loadGlobalConfig(this.configPath),
      projectSource(root),
      this.runtime.status(),
    ]);
    cancelled(signal);
    const raw = projectObject(source);
    const lsp = structuredClone(global.lsp ?? { servers: {} });
    // UI trust controls use the same canonical identities as runtime selection.
    await Promise.all(
      Object.values(lsp.servers).map(async (server) => {
        server.trustedWorkspaces = [
          ...new Set(
            await Promise.all(
              server.trustedWorkspaces.map(async (candidate) => {
                try {
                  return await canonicalWorkspaceRoot(candidate);
                } catch {
                  return candidate;
                }
              }),
            ),
          ),
        ];
      }),
    );
    cancelled(signal);
    return {
      workspaceRoot: root,
      global: lsp,
      project: raw.lsp ? ProjectLspConfigSchema.parse(raw.lsp) : {},
      projectRevision: revision(source),
      globalRevision: revision(JSON.stringify(global.lsp ?? { servers: {} })),
      status,
    };
  }
  private write(work: () => Promise<void>): Promise<LspSettingsState> {
    const pending = this.pending
      .catch(() => {})
      .then(async () => {
        await work();
        await this.runtime.apply();
        return this.load();
      });
    this.pending = pending;
    return pending;
  }
  saveGlobal(
    value: LspConfig,
    expectedRevision?: string,
  ): Promise<LspSettingsState> {
    const config = LspConfigSchema.parse(value);
    return this.write(async () => {
      await updateGlobalConfig(this.configPath, (current) => {
        if (
          expectedRevision !== undefined &&
          revision(JSON.stringify(current.lsp ?? { servers: {} })) !==
            expectedRevision
        )
          throw new Error(
            "Настройки LSP изменились. Перезагрузите их перед сохранением; draft сохранён.",
          );
        return { ...current, lsp: config };
      });
    });
  }
  saveProject(
    value: ProjectLspConfig,
    expectedRevision: string,
  ): Promise<LspSettingsState> {
    const config = ProjectLspConfigSchema.parse(value);
    return this.write(async () => {
      const root = await canonicalWorkspaceRoot(this.root);
      const source = await projectSource(root);
      if (revision(source) !== expectedRevision)
        throw new Error(
          ".chiselrc изменён другим процессом. Перезагрузите проектные настройки; ваш draft сохранён.",
        );
      const raw = projectObject(source);
      const next = { ...raw, lsp: config };
      const target = join(root, ".chiselrc");
      const temporary = join(root, `.chiselrc.${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if ((await projectSource(root)) !== source)
          throw new Error(
            ".chiselrc изменён во время сохранения. Перезагрузите настройки; draft сохранён.",
          );
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }
  trust(serverId: string, allowed: boolean): Promise<LspSettingsState> {
    return this.write(async () => {
      const root = await canonicalWorkspaceRoot(this.root);
      await updateGlobalConfig(this.configPath, async (current) => {
        const lsp = structuredClone(current.lsp ?? { servers: {} });
        const server = lsp.servers[serverId];
        if (!server) throw new Error("Сначала сохраните сервер.");
        const remaining: string[] = [];
        for (const candidate of server.trustedWorkspaces) {
          let canonical = candidate;
          try {
            canonical = await canonicalWorkspaceRoot(candidate);
          } catch {
            /* Keep unrelated missing roots. */
          }
          if (canonical !== root) remaining.push(candidate);
        }
        server.trustedWorkspaces = allowed ? [...remaining, root] : remaining;
        return { ...current, lsp };
      });
    });
  }
  async check(
    serverId: string,
    config: LspServerConfig,
    signal?: AbortSignal,
  ): Promise<string> {
    cancelled(signal);
    const launch = await validateLspLaunch(
      await canonicalWorkspaceRoot(this.root),
      serverId,
      config,
    );
    cancelled(signal);
    return config.backend === "typescript"
      ? `Пути доступны. language-server ${launch.serverVersion}, TypeScript ${launch.typescriptVersion}. Node version не выполнялась: требуется >=22.22.2. Сервер не запущен.`
      : "Пути доступны. Проверка не выполняла executable и не подтверждает его версию/совместимость. stdio handshake выполняется при явном запуске.";
  }
  restart(serverId?: string): Promise<ToolExecutionResult> {
    return this.runtime.restart(serverId);
  }
}
