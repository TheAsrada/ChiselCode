import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadGlobalConfig, updateGlobalConfig } from "../config/load.js";
import { canonicalWorkspaceRoot } from "../extensions/host.js";
import { frozenClone } from "../extensions/lifecycle.js";
import { cancelled } from "../runtime/errors.js";
import type { ToolExecutionResult } from "../types/domain.js";
import { replaceAtomicFile } from "../utils/atomic-file.js";
import {
  catalogPlatformAvailable,
  catalogServer,
  LSP_SERVER_CATALOG,
} from "./catalog.js";
import {
  effectiveLspMode,
  globalLspDisabled,
  globalLspMode,
  type LspConfig,
  LspConfigSchema,
  type LspServerConfig,
  LspServerIdSchema,
  lspServerEnabled,
  type ProjectLspConfig,
  ProjectLspConfigSchema,
  resolveLspLaunch,
  selectLspServer,
  validateLspLaunch,
} from "./config.js";
import type { LspManagedInstance, LspState, LspStatus } from "./service.js";

export type LspSettingsScope = "global" | "project";
export type LspSettingsRevision = Pick<
  LspSettingsState,
  "globalRevision" | "projectRevision"
>;
export interface LspManagedServer {
  id: string;
  title: string;
  origin: "builtin" | "custom" | "missing";
  languages: readonly string[];
  enabled: boolean;
  source: "global" | "project" | "default";
  applicable: boolean;
  state: LspState;
  reason?: string;
  version?: string;
  prerequisites?: string;
  instances: readonly LspManagedInstance[];
}
export interface LspManagementSnapshot {
  scope: LspSettingsScope;
  workspaceRoot?: string;
  enabled: boolean;
  source: "global" | "project";
  globallyDisabled: boolean;
  strategy: "auto" | "custom";
  servers: readonly LspManagedServer[];
}

export interface LspSettingsState {
  workspaceRoot?: string;
  global: LspConfig;
  project: ProjectLspConfig;
  projectRevision: string;
  globalRevision: string;
  status: Omit<LspStatus, "workspaceRoot"> & { workspaceRoot?: string };
  management?: Readonly<{
    global: LspManagementSnapshot;
    project: LspManagementSnapshot;
  }>;
  applicationError?: string;
  launchRestriction?: string;
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
  setEnabled(
    scope: LspSettingsScope,
    enabled: boolean | undefined,
    expected: LspSettingsRevision,
  ): Promise<LspSettingsState>;
  setServerEnabled(
    scope: LspSettingsScope,
    serverId: string,
    enabled: boolean | undefined,
    expected: LspSettingsRevision,
  ): Promise<LspSettingsState>;
  setStrategy(
    scope: LspSettingsScope,
    mode: "auto" | "custom" | undefined,
    expected: LspSettingsRevision,
  ): Promise<LspSettingsState>;
  retryApply(): Promise<LspSettingsState>;
  subscribe?(changed: () => void): { dispose(): void };
}
export interface LspSettingsRuntime {
  assertOwner?(): void;
  launchRestriction?(): string | undefined;
  status(): Promise<LspStatus>;
  apply(): Promise<void>;
  restart(serverId?: string): Promise<ToolExecutionResult>;
  entries?(): readonly LspManagedInstance[];
  subscribe?(changed: () => void): { dispose(): void };
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
async function management(
  scope: LspSettingsScope,
  root: string | undefined,
  global: LspConfig,
  project: ProjectLspConfig,
  instances: readonly LspManagedInstance[],
  previews: Map<string, Promise<string | undefined>>,
): Promise<LspManagementSnapshot> {
  const configuration = {
    global,
    project: scope === "project" ? project : undefined,
    ignorePatterns: [],
  };
  const strategy =
    configuration.project?.mode === "off"
      ? configuration.project.serverId
        ? "custom"
        : globalLspMode(global) === "custom"
          ? "custom"
          : "auto"
      : (configuration.project?.mode ??
        (configuration.project?.serverId
          ? "custom"
          : globalLspMode(global) === "custom"
            ? "custom"
            : "auto"));
  const ids = [
    ...new Set([
      ...LSP_SERVER_CATALOG.map((server) => server.id),
      ...Object.keys(global.servers),
      ...Object.keys(global.serverOverrides ?? {}),
      ...Object.keys(configuration.project?.serverOverrides ?? {}),
      ...instances.map((instance) => instance.serverId),
    ]),
  ];
  const servers = await Promise.all(
    ids.map(async (id): Promise<LspManagedServer> => {
      const descriptor = catalogServer(id);
      const custom = global.servers[id];
      const permission = lspServerEnabled(configuration, id);
      const own = instances.filter((instance) => instance.serverId === id);
      const applicable = descriptor
        ? strategy === "auto"
        : !!custom && strategy === "custom";
      const selection = root
        ? await selectLspServer(root, configuration, id)
        : undefined;
      let reason =
        !descriptor && !custom
          ? "Сервер больше не настроен; удалите лишнее исключение."
          : descriptor && !catalogPlatformAvailable(descriptor)
            ? "Нет стандартного пакета для этой ОС/CPU. Используйте свою настройку."
            : !applicable
              ? "Сервер не используется выбранной стратегией."
              : selection?.reason;
      let state: LspState =
        !descriptor && !custom
          ? "unavailable"
          : descriptor && !catalogPlatformAvailable(descriptor)
            ? "unavailable"
            : !permission.enabled ||
                effectiveLspMode(configuration) === "off" ||
                !applicable
              ? "disabled"
              : (selection?.state ?? "stopped");
      if (state === "stopped" && root && selection) {
        let preview = previews.get(id);
        if (!preview) {
          preview = resolveLspLaunch(root, selection)
            .then(() => undefined)
            .catch((error: unknown) =>
              error instanceof Error
                ? error.message
                : "Проверьте пути сервера и SDK.",
            );
          previews.set(id, preview);
        }
        const unavailable = await preview;
        if (unavailable) {
          state = "unavailable";
          reason = unavailable;
        }
      }
      if (state === "stopped") {
        const actual =
          own.find((entry) => entry.state === "error") ??
          own.find((entry) =>
            ["starting", "restarting"].includes(entry.state),
          ) ??
          own.find((entry) => entry.state === "ready");
        if (actual) {
          state = actual.state;
          reason = actual.reason;
        }
      }
      return {
        id,
        title: descriptor?.title ?? id,
        origin: descriptor ? "builtin" : custom ? "custom" : "missing",
        languages:
          descriptor?.languages.map((language) => language.id) ??
          (custom?.backend === "generic"
            ? custom.languageIds
            : custom
              ? ["typescript", "javascript"]
              : []),
        ...permission,
        applicable,
        state,
        reason,
        version: descriptor?.version,
        prerequisites: descriptor?.prerequisites,
        instances: own,
      };
    }),
  );
  return frozenClone({
    scope,
    workspaceRoot: root,
    enabled: effectiveLspMode(configuration) !== "off",
    source:
      scope === "project" &&
      (project.enabled !== undefined || project.mode === "off")
        ? "project"
        : "global",
    globallyDisabled: globalLspDisabled(global),
    strategy: strategy === "custom" ? "custom" : "auto",
    servers,
  });
}
const projectWrites = new Map<string, Promise<void>>();
async function patchProject(
  rootPath: string | undefined,
  expected: string,
  update: (value: ProjectLspConfig) => ProjectLspConfig,
  assertOwner: () => void = () => {},
): Promise<void> {
  if (!rootPath) throw new Error("Для проектных настроек выберите папку.");
  const root = await canonicalWorkspaceRoot(rootPath);
  const pending = (projectWrites.get(root) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      assertOwner();
      const source = await projectSource(root);
      if (revision(source) !== expected)
        throw new Error(
          ".chiselrc изменён другим процессом. Обновите данные; draft сохранён.",
        );
      const raw = projectObject(source);
      const lsp = ProjectLspConfigSchema.parse(
        update(ProjectLspConfigSchema.parse(raw.lsp ?? {})),
      );
      const temporary = join(root, `.chiselrc.${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(
            `${JSON.stringify({ ...raw, lsp }, null, 2)}\n`,
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        await replaceAtomicFile(
          temporary,
          join(root, ".chiselrc"),
          async () => {
            assertOwner();
            if ((await projectSource(root)) !== source)
              throw new Error(
                ".chiselrc изменён во время сохранения; draft сохранён.",
              );
          },
        );
      } finally {
        await rm(temporary, { force: true });
      }
    });
  projectWrites.set(root, pending);
  try {
    await pending;
  } finally {
    if (projectWrites.get(root) === pending) projectWrites.delete(root);
  }
}
/** Only typed LSP fields are written. No install, shell evaluation or model credentials. */
export class LspSettingsStore implements LspSettingsActions {
  private pending: Promise<unknown> = Promise.resolve();
  private applicationError?: string;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly root: string | undefined,
    private readonly configPath: string | undefined,
    private readonly runtime: LspSettingsRuntime,
  ) {}
  async load(signal?: AbortSignal): Promise<LspSettingsState> {
    cancelled(signal);
    const root = this.root
      ? await canonicalWorkspaceRoot(this.root)
      : undefined;
    const [global, source, status] = await Promise.all([
      loadGlobalConfig(this.configPath),
      root ? projectSource(root) : Promise.resolve(""),
      root
        ? this.runtime.status().catch((error) => ({
            workspaceRoot: root,
            backend: "typescript",
            state: "unavailable" as const,
            generation: 0,
            trackedDocuments: 0,
            requiresRestart: false,
            reason:
              error instanceof Error
                ? error.message
                : "Не удалось прочитать состояние анализа.",
          }))
        : Promise.resolve({
            backend: "typescript",
            state: "unavailable" as const,
            generation: 0,
            trackedDocuments: 0,
            requiresRestart: false,
            reason: "Для проектного анализа выберите папку.",
          }),
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
    const project = raw.lsp ? ProjectLspConfigSchema.parse(raw.lsp) : {};
    const instances =
      this.runtime.entries?.() ??
      ((status as LspStatus).servers ?? []).map((entry) => ({
        ...entry,
        requiresRestart: false,
        capabilities: [],
        documents: [],
      }));
    const previews = new Map<string, Promise<string | undefined>>();
    const [globalView, projectView] = await Promise.all([
      management("global", root, lsp, project, instances, previews),
      management("project", root, lsp, project, instances, previews),
    ]);
    cancelled(signal);
    return {
      workspaceRoot: root,
      global: lsp,
      project,
      projectRevision: revision(source),
      globalRevision: revision(JSON.stringify(global.lsp ?? { servers: {} })),
      status,
      management: { global: globalView, project: projectView },
      applicationError: this.applicationError,
      launchRestriction: this.runtime.launchRestriction?.(),
    };
  }
  private write(work: () => Promise<void>): Promise<LspSettingsState> {
    const pending = this.pending
      .catch(() => {})
      .then(async () => {
        this.runtime.assertOwner?.();
        await work();
        this.applicationError = undefined;
        try {
          await this.runtime.apply();
        } catch {
          this.applicationError =
            "Настройки сохранены; завершение процесса не подтверждено. Повторите применение.";
        }
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            /* Passive subscribers do not own the write. */
          }
        }
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
        this.runtime.assertOwner?.();
        if (
          expectedRevision !== undefined &&
          revision(JSON.stringify(current.lsp ?? { servers: {} })) !==
            expectedRevision
        )
          throw new Error(
            "Настройки LSP изменились. Перезагрузите их перед сохранением; draft сохранён.",
          );
        for (const id of Object.keys(current.lsp?.servers ?? {})) {
          if (!config.servers[id] && config.serverOverrides)
            delete config.serverOverrides[id];
        }
        return { ...current, lsp: config };
      });
    });
  }
  saveProject(
    value: ProjectLspConfig,
    expectedRevision: string,
  ): Promise<LspSettingsState> {
    const config = ProjectLspConfigSchema.parse(value);
    return this.write(() =>
      patchProject(
        this.root,
        expectedRevision,
        () => config,
        () => this.runtime.assertOwner?.(),
      ),
    );
  }

  private patch(
    scope: LspSettingsScope,
    expected: LspSettingsRevision,
    update: (value: LspConfig | ProjectLspConfig) => void,
  ): Promise<LspSettingsState> {
    return this.write(async () => {
      if (scope === "global") {
        await updateGlobalConfig(this.configPath, (current) => {
          this.runtime.assertOwner?.();
          if (
            revision(JSON.stringify(current.lsp ?? { servers: {} })) !==
            expected.globalRevision
          )
            throw new Error(
              "Настройки LSP изменились. Обновите данные; draft сохранён.",
            );
          const lsp = structuredClone(current.lsp ?? { servers: {} });
          update(lsp);
          return { ...current, lsp: LspConfigSchema.parse(lsp) };
        });
      } else {
        await patchProject(
          this.root,
          expected.projectRevision,
          (lsp) => {
            update(lsp);
            return lsp;
          },
          () => this.runtime.assertOwner?.(),
        );
      }
    });
  }
  setEnabled(
    scope: LspSettingsScope,
    enabled: boolean | undefined,
    expected: LspSettingsRevision,
  ) {
    return this.patch(scope, expected, (value) => {
      if (enabled === undefined) delete value.enabled;
      else value.enabled = enabled;
      if (value.mode === "off") {
        if (enabled === undefined) delete value.mode;
        else if (scope === "global")
          value.mode = Object.keys((value as LspConfig).servers).length
            ? "custom"
            : "auto";
        else if ((value as ProjectLspConfig).serverId) value.mode = "custom";
        else delete value.mode;
      }
    });
  }
  setServerEnabled(
    scope: LspSettingsScope,
    serverId: string,
    enabled: boolean | undefined,
    expected: LspSettingsRevision,
  ) {
    const id = LspServerIdSchema.parse(serverId);
    return this.patch(scope, expected, (value) => {
      value.serverOverrides ??= {};
      if (enabled === undefined) delete value.serverOverrides[id];
      else value.serverOverrides[id] = { enabled };
      if (!Object.keys(value.serverOverrides).length)
        delete value.serverOverrides;
    });
  }
  setStrategy(
    scope: LspSettingsScope,
    mode: "auto" | "custom" | undefined,
    expected: LspSettingsRevision,
  ) {
    return this.patch(scope, expected, (value) => {
      if (mode === undefined) {
        delete value.mode;
        delete (value as ProjectLspConfig).serverId;
      } else value.mode = mode;
    });
  }
  retryApply() {
    return this.write(async () => {});
  }
  subscribe(changed: () => void): { dispose(): void } {
    this.listeners.add(changed);
    const subscription = this.runtime.subscribe?.(changed);
    return {
      dispose: () => {
        this.listeners.delete(changed);
        subscription?.dispose();
      },
    };
  }
  trust(serverId: string, allowed: boolean): Promise<LspSettingsState> {
    return this.write(async () => {
      if (!this.root) throw new Error("Для доверия проекту выберите папку.");
      const root = await canonicalWorkspaceRoot(this.root);
      await updateGlobalConfig(this.configPath, async (current) => {
        this.runtime.assertOwner?.();
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
    if (!this.root) throw new Error("Для проверки запуска LSP выберите папку.");
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
