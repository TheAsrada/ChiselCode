import { createHash } from "node:crypto";
import { z } from "zod";
import { BackgroundSettingsStore } from "../background/settings.js";
import { toggleBrowser } from "../browser/settings.js";
import { loadGlobalConfig, loadProjectConfig } from "../config/load.js";
import type {
  BuiltinSettings,
  CatalogExtension,
  ExtensionCatalog,
  ExtensionOperation,
  ExtensionResult,
  ExtensionReview,
  ExtensionSettings,
  Json,
  RequestMap,
} from "../desktop/protocol.js";
import {
  LspConfigSchema,
  LspServerSchema,
  ProjectLspConfigSchema,
} from "../lsp/config.js";
import { type LspSettingsRuntime, LspSettingsStore } from "../lsp/settings.js";
import { SubagentSettingsStore } from "../subagents/settings.js";
import { VERSION } from "../version.js";
import type { ExtensionAutomations } from "./automations.js";
import { backgroundSettings } from "./builtins/background.js";
import { chatGptSettings } from "./builtins/chatgpt/index.js";
import { lspSettings } from "./builtins/lsp.js";
import { subagentsSettings } from "./builtins/subagents.js";
import {
  type ExtensionDiagnostic,
  safeExtensionText,
} from "./external/loader.js";
import {
  type ExtensionManifest,
  ExternalIdSchema,
} from "./external/manifest.js";
import { inspectPackage } from "./external/package.js";
import {
  readExtensionRegistry,
  receiptMatches,
  runtimeRecord,
  selectedVersion,
  withExtensionRegistry,
} from "./external/registry.js";
import { frozenClone } from "./lifecycle.js";
import { PackageManagementError } from "./packages/errors.js";
import {
  PackageManagementService,
  type PreparedPackage,
} from "./packages/service.js";
import {
  builtinAvailability,
  externalAllowed,
  type SettingsContribution,
} from "./settings-contributions.js";
import { ExtensionSettingsStore } from "./settings-store.js";

const builtinNames = {
  "builtin.browser": ["Браузер", "Локальная проверка интерфейсов в Chromium"],
  "builtin.chatgpt": ["ChatGPT", "Подписка, модели и лимиты"],
  "builtin.lsp": [
    "Анализ кода (LSP)",
    "Ошибки, определения и ссылки в коде",
    "tools.lsp",
    lspSettings,
  ],
  "builtin.subagents": [
    "Субагенты",
    "Помощники для чтения и работы в отдельных копиях",
    "tools.subagents",
    subagentsSettings,
  ],
  "builtin.background": [
    "Фоновые задачи",
    "Длительные локальные команды и их результаты",
    "tools.background",
    backgroundSettings,
  ],
  "builtin.worktrees": [
    "Рабочие копии",
    "Изолированные папки для независимых задач",
  ],
  "builtin.project": ["Проект", "Контекст и сведения о проекте"],
  "builtin.btw": [
    "Побочные вопросы",
    "Дополнительный вопрос в терминальной оболочке",
  ],
} as const;
export interface ManagedExtension extends CatalogExtension {
  automations?: ReturnType<ExtensionAutomations["list"]>;
  settingsSection?: SettingsContribution;
}

export const BuiltinIdSchema = z.enum([
  "builtin.lsp",
  "builtin.subagents",
  "builtin.background",
]);
type BuiltinId = z.infer<typeof BuiltinIdSchema>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function actualLabel(state: string): string {
  const labels: Record<string, string> = {
    active: "Работает",
    available: "Доступно в рабочем сеансе",
    not_started: "Не загружено в этом рабочем сеансе",
    loading: "Загружается",
    disabled: "Выключено в текущем рабочем сеансе",
    not_trusted: "Код не загружен: доверие не выдано",
    incompatible: "Код не загружен: несовместим",
    modified: "Код не загружен: содержимое изменено",
    invalid: "Код не загружен: пакет повреждён",
    load_failed: "Ошибка загрузки",
    activation_failed: "Ошибка активации",
    cleanup_failed: "Ошибка очистки ресурсов",
    unavailable: "Недоступно в этой оболочке",
    pending_restart: "Ожидает запуска рабочего сеанса",
  };
  return labels[state] ?? "Не работает";
}
function conflict(
  message = "Состояние изменилось после просмотра. Перечитайте список и подтвердите заново.",
): never {
  throw new PackageManagementError("PACKAGE_CONFLICT", message);
}
interface Operation {
  dto: ExtensionOperation;
  input: string;
  abort: AbortController;
  pending?: Promise<ExtensionReview>;
  candidate?: PreparedPackage;
  versionKey?: string;
  selectedDigest?: string;
  registryRevision?: number;
  commit?: Promise<ExtensionResult>;
  confirmation?: string;
  timer?: ReturnType<typeof setTimeout>;
}
interface Options {
  configPath?: string;
  diagnostics?: (root?: string) => readonly ExtensionDiagnostic[];
  scopeReady?: (root: string) => boolean;
  lsp?: (root: string) => LspSettingsRuntime;
  applySubagents?: () => Promise<void>;
  externalDisabled?: boolean;
  desktop?: boolean;
  applyUi?: (id: string) => Promise<boolean>;
  canApplyUi?: (id: string) => boolean;
  hasBuiltin?: (id: string) => boolean;
  builtinRecovery?: (id: string, root?: string) => boolean;
  applyBuiltin?: (id: string) => Promise<void>;
  disableExternal?: (id: string) => Promise<void>;
  enableExternal?: (id: string) => Promise<void>;
  automations?: (root: string) => ExtensionAutomations | undefined;
  externalNeedsRestart?: (id: string) => boolean;
}
/** One shared application service. UI receives data, never prepared handles. */
export class ExtensionManagementService {
  readonly packages = new PackageManagementService();
  private operations = new Map<string, Operation>();
  private closed = false;
  private listeners = new Set<(hide?: { id: string; root?: string }) => void>();
  subscribe = (changed: (hide?: { id: string; root?: string }) => void) => {
    this.listeners.add(changed);
    return () => {
      this.listeners.delete(changed);
    };
  };
  private notify(hide?: { id: string; root?: string }) {
    for (const changed of this.listeners) changed(hide);
  }
  /** Reconcile external CLI disable/remove and trust revocation with already published owners. */
  async reconcileExternalDisables() {
    if (this.closed || !this.options.disableExternal) return;
    const active =
      this.options.diagnostics?.().filter((item) => item.state === "active") ??
      [];
    if (!active.length) return;
    const invalid = (
      registry: Awaited<ReturnType<typeof readExtensionRegistry>>,
    ) =>
      new Set(
        active.flatMap((diagnostic) => {
          const row = registry.records.find(({ id }) => id === diagnostic.id);
          return row?.enabled &&
            !row.removedAt &&
            row.versions.some(
              (version) =>
                version.digest === diagnostic.packageDigest &&
                !!version.approvedAt,
            )
            ? []
            : [diagnostic.id];
        }),
      );
    if (!invalid(await readExtensionRegistry()).size) return;
    const cleanup: Promise<unknown>[] = [];
    await withExtensionRegistry((registry) => {
      for (const id of invalid(registry)) {
        const removing = this.options.disableExternal?.(id);
        this.notify({ id });
        cleanup.push(
          Promise.resolve(removing).then(() => this.options.applyUi?.(id)),
        );
      }
      return Promise.resolve();
    });
    if (cleanup.length) {
      await Promise.allSettled(cleanup);
      this.notify();
    }
  }
  automationsChanged() {
    this.notify();
  }
  async pauseAutomation(
    root: string,
    id: string,
    taskId: string,
    paused: boolean,
  ) {
    const automations = this.options.automations?.(root);
    if (!automations) throw new Error("Рабочая область автоматизации закрыта.");
    await automations.pause(id, taskId, paused);
    this.notify();
  }
  async builtinChanged(id: string, root?: string) {
    const [global, project] = await Promise.all([
      loadGlobalConfig(this.options.configPath),
      root ? loadProjectConfig(root) : undefined,
    ]);
    const { enabled, effective } = builtinAvailability(id, global, project);
    this.notify(
      !effective ? { id, root: enabled ? root : undefined } : undefined,
    );
    await this.options.applyBuiltin?.(id);
  }
  hasBuiltin(id: string): boolean {
    return this.options.hasBuiltin?.(id) !== false;
  }
  connectionContribution() {
    return !this.hasBuiltin("builtin.chatgpt") ? undefined : chatGptSettings;
  }
  constructor(private readonly options: Options = {}) {}
  private lsp(root?: string) {
    return new LspSettingsStore(
      root,
      this.options.configPath,
      (root ? this.options.lsp?.(root) : undefined) ?? {
        status: async () => ({
          workspaceRoot: root ?? "",
          backend: "typescript",
          state: "unavailable",
          generation: 0,
          trackedDocuments: 0,
          requiresRestart: false,
          reason:
            "Рабочий сеанс LSP ещё не открыт; просмотр настроек его не запускает.",
        }),
        apply: async () => {},
        restart: async () => ({
          output: "Сначала откройте рабочий сеанс проекта.",
          isError: true,
        }),
      },
    );
  }
  private store(id: BuiltinId, root?: string) {
    return id === "builtin.lsp"
      ? this.lsp(root)
      : id === "builtin.subagents"
        ? new SubagentSettingsStore(
            root,
            this.options.configPath,
            this.options.applySubagents,
          )
        : new BackgroundSettingsStore(root, this.options.configPath);
  }
  async builtinRead(id: string, root?: string): Promise<BuiltinSettings> {
    const state = await this.store(BuiltinIdSchema.parse(id), root).load();
    return frozenClone({
      id,
      global: state.global as unknown as Json,
      project: state.project as unknown as Json,
      globalRevision: state.globalRevision,
      projectRevision: state.projectRevision,
      ...("effective" in state
        ? { effective: state.effective as unknown as Json }
        : { status: state.status as unknown as Json }),
    });
  }
  async builtinSave(
    input: RequestMap["extensions/builtin/save"]["params"],
  ): Promise<BuiltinSettings> {
    const id = BuiltinIdSchema.parse(input.id),
      store = this.store(id, input.path);
    if (id === "builtin.lsp") {
      const lsp = store as LspSettingsStore;
      if (input.scope === "global")
        await lsp.saveGlobal(
          LspConfigSchema.parse(input.value),
          input.revision,
        );
      else
        await lsp.saveProject(
          ProjectLspConfigSchema.parse(input.value),
          input.revision,
        );
    } else if (id === "builtin.subagents") {
      const subagents = store as SubagentSettingsStore;
      if (input.scope === "global")
        await subagents.saveGlobal(
          input.value as Parameters<typeof subagents.saveGlobal>[0],
          input.revision,
        );
      else
        await subagents.saveProject(
          input.value as Parameters<typeof subagents.saveProject>[0],
          input.revision,
        );
    } else {
      const background = store as BackgroundSettingsStore;
      if (input.scope === "global")
        await background.saveGlobal(
          input.value as Parameters<typeof background.saveGlobal>[0],
          input.revision,
        );
      else
        await background.saveProject(
          input.value as Parameters<typeof background.saveProject>[0],
          input.revision,
        );
    }
    return this.builtinRead(id, input.path);
  }
  async lspAction(
    input: RequestMap["extensions/lsp/action"]["params"],
  ): Promise<{ text: string }> {
    const store = this.lsp(input.path);
    if (input.action === "trust") {
      await store.trust(input.serverId, input.allowed === true);
      return { text: "Доверие проекта сохранено." };
    }
    if (input.action === "check")
      return {
        text: await store.check(
          input.serverId,
          LspServerSchema.parse(input.value),
        ),
      };
    const result = await store.restart(input.serverId);
    if (result.isError) throw new Error(result.output);
    return { text: safeExtensionText(result.output) };
  }
  async list(
    root?: string,
  ): Promise<ExtensionCatalog & { items: ManagedExtension[] }> {
    const [global, project, packages, registry] = await Promise.all([
      loadGlobalConfig(this.options.configPath),
      root ? loadProjectConfig(root) : undefined,
      this.packages.list(),
      readExtensionRegistry(),
    ]);
    const diagnostics = this.options.diagnostics?.(root) ?? [];
    const items: ManagedExtension[] = Object.entries(builtinNames).map(
      ([id, [name, description, route, section]]) => {
        const { enabled, effective } = builtinAvailability(id, global, project);
        const configuration =
          id === "builtin.lsp"
            ? (global.lsp ?? { servers: {} })
            : id === "builtin.subagents"
              ? (global.subagents ?? {})
              : id === "builtin.background"
                ? (global.backgroundTasks ?? {})
                : id === "builtin.browser"
                  ? (global.browser ?? {})
                  : {};
        const desktopUnavailable = this.options.desktop && id === "builtin.btw";
        const recovering = this.options.builtinRecovery?.(id, root) === true;
        const available = this.hasBuiltin(id) && !desktopUnavailable;
        return {
          id,
          name,
          description,
          origin: "builtin",
          version: VERSION,
          source: "Встроено в ChiselCode",
          revision: 0,
          digest: hash(configuration),
          compatible: available,
          compatibility: desktopUnavailable
            ? "Побочные вопросы доступны в CLI"
            : `ChiselCode ${VERSION}`,
          trusted: true,
          desiredEnabled: enabled,
          actualState: recovering
            ? "cleanup_failed"
            : !effective
              ? "disabled"
              : !available
                ? "unavailable"
                : root && this.options.scopeReady?.(root)
                  ? "available"
                  : "not_started",
          state: recovering
            ? "error"
            : !effective
              ? "disabled"
              : !available
                ? "saved"
                : root && this.options.scopeReady?.(root)
                  ? "working"
                  : "saved",
          actualLabel: recovering
            ? actualLabel("cleanup_failed")
            : !effective
              ? actualLabel("disabled")
              : !available
                ? actualLabel("unavailable")
                : root && this.options.scopeReady?.(root)
                  ? actualLabel("available")
                  : actualLabel("not_started"),
          projectBlocked: enabled && !effective,
          restartRequired: recovering,
          deferredRemoval: false,
          actions:
            (route || id === "builtin.browser") && available && !recovering
              ? [
                  enabled && effective ? "disable" : "enable",
                  ...(route && effective ? ["settings" as const] : []),
                ]
              : [],
          ...(route ? { settingsRoute: route } : {}),
          ...(section && available && effective
            ? { settingsSection: section }
            : {}),
          versions: [],
          ...(!effective && enabled
            ? { reason: "Возможность запрещена настройками этого проекта." }
            : desktopUnavailable
              ? { reason: "Используйте CLI для /btw." }
              : {}),
        };
      },
    );
    for (const row of packages) {
      const actual = diagnostics.find((d) => d.id === row.id),
        selected = row.selected;
      if (row.removed && !row.versions.length && !actual) continue;
      const blocked =
        !!this.options.externalDisabled || !externalAllowed(row.id, project);
      let manifest: ExtensionManifest | undefined;
      if (selected && !row.removed)
        try {
          const candidate = await inspectPackage(selected.location);
          if (candidate.digest === selected.digest)
            manifest = candidate.manifest;
        } catch {
          /* The package status already reports damage. */
        }
      const loaded = actual?.state === "active";
      let settingsRevision = 0,
        settingsError: string | undefined;
      if (manifest)
        try {
          const settings = await new ExtensionSettingsStore(manifest).read();
          settingsRevision = settings.revision;
          if (settings.issues.length) settingsError = settings.issues.join(" ");
        } catch {
          settingsError =
            "Настройки расширения недоступны или повреждены; данные сохранены.";
        }
      const restart =
        !!this.options.externalNeedsRestart?.(row.id) ||
        (loaded
          ? row.removed ||
            !row.enabled ||
            selected?.digest !== actual.packageDigest ||
            actual.settingsRevision !== settingsRevision
          : row.enabled &&
            !blocked &&
            row.trusted &&
            row.compatible &&
            !row.removed &&
            (!actual ||
              actual.state === "disabled" ||
              actual.state === "not_trusted"));
      const failure =
        (!!settingsError && row.trusted) ||
        ["invalid", "modified", "incompatible"].includes(row.state) ||
        (!!actual &&
          ["load_failed", "activation_failed", "cleanup_failed"].includes(
            actual.state,
          ));
      const state: CatalogExtension["state"] = failure
        ? "error"
        : restart
          ? "restart_required"
          : loaded
            ? "working"
            : !row.trusted && !row.removed
              ? "not_trusted"
              : !row.enabled || blocked || row.removed
                ? "disabled"
                : "saved";
      const actions: CatalogExtension["actions"] = row.removed
        ? []
        : [
            ...(manifest && row.enabled && row.trusted && !blocked
              ? ["settings" as const]
              : []),
            "update",
            "versions",
            "remove",
          ];
      if (!row.removed && row.enabled) actions.unshift("disable");
      else if (
        !row.removed &&
        row.trusted &&
        row.compatible &&
        !failure &&
        !blocked
      )
        actions.unshift("enable");
      if (
        !row.removed &&
        !row.trusted &&
        row.compatible &&
        row.state === "not_trusted"
      )
        actions.unshift("trust");
      const section = manifest?.settings?.section;
      const settingsSection =
        manifest &&
        section &&
        row.enabled &&
        row.trusted &&
        row.compatible &&
        !blocked &&
        !row.removed &&
        !["invalid", "modified", "incompatible"].includes(row.state)
          ? {
              title: safeExtensionText(section.title),
              description: safeExtensionText(
                section.description ?? manifest.description ?? "",
              ),
              keywords: [
                row.id,
                row.name,
                ...(section.keywords ?? []).map(safeExtensionText),
              ],
              fields: (manifest.settings?.fields ?? []).map((field) => ({
                id: field.name,
                title: safeExtensionText(field.label),
                keywords: field.description
                  ? [safeExtensionText(field.description)]
                  : [],
              })),
            }
          : undefined;
      items.push({
        ...(settingsSection ? { settingsSection } : {}),
        id: row.id,
        name: row.name,
        description: safeExtensionText(manifest?.description ?? ""),
        origin: "installed",
        version: selected?.version ?? actual?.version ?? "—",
        ...(loaded ? { activeVersion: actual.version } : {}),
        lastWorkingVersion: row.lastWorkingVersion,
        failedVersion: row.failedVersion,
        source:
          selected?.source ?? selected?.location ?? "Удалённое подключение",
        ...(selected ? { digest: selected.digest } : {}),
        revision: row.revision,
        compatible: row.compatible,
        compatibility:
          manifest?.chiselVersion ??
          (row.compatible ? "API v1" : "Не прошёл проверку совместимости"),
        trusted: row.trusted,
        desiredEnabled: row.enabled,
        actualState:
          actual?.state ?? (!row.enabled ? "disabled" : "not_started"),
        actualLabel: actualLabel(
          actual?.state ?? (!row.enabled ? "disabled" : "not_started"),
        ),
        state,
        projectBlocked: blocked,
        restartRequired: !!restart,
        deferredRemoval:
          row.removed && row.versions.some((v) => v.kind === "managed"),
        actions,
        ...(failure
          ? {
              reason:
                settingsError ??
                actual?.reason ??
                row.reason ??
                "Содержимое изменено или несовместимо.",
            }
          : blocked
            ? {
                reason:
                  "Внешнее расширение запрещено для этого проекта/запуска.",
              }
            : row.removed
              ? {
                  reason:
                    "Подключение удалено. Занятые или не подтверждённые файлы сохранены; пользовательские данные остаются.",
                }
              : {}),
        versions: row.versions.map((v) => ({
          key: v.key,
          version: v.version,
          digest: v.digest,
          selected: v.key === selected?.key,
          trusted: !!v.approvedAt,
          inUse: row.uses.some((u) => u.digest === v.digest),
          location: v.location,
        })),
      });
    }
    const automations = root ? this.options.automations?.(root) : undefined;
    if (automations)
      for (const item of items) item.automations = automations.list(item.id);
    return frozenClone({ items, revision: registry.revision });
  }
  prepare(
    input: RequestMap["extensions/prepare"]["params"],
  ): Promise<ExtensionReview> {
    if (this.closed) throw new Error("Управление расширениями закрыто.");
    z.uuid().parse(input.requestId);
    const signature = JSON.stringify(input),
      existing = this.operations.get(input.requestId);
    if (existing) {
      if (existing.input !== signature)
        conflict("Идентификатор операции уже занят.");
      if (existing.pending) return existing.pending;
      if (existing.dto.review) return Promise.resolve(existing.dto.review);
      conflict();
    }
    for (const [key, op] of this.operations)
      if (
        this.operations.size >= 64 &&
        ["completed", "cancelled", "error"].includes(op.dto.phase)
      )
        this.operations.delete(key);
    if (
      this.operations.size >= 64 ||
      [...this.operations.values()].filter((op) =>
        ["preparing", "review", "committing"].includes(op.dto.phase),
      ).length >= 8
    )
      throw new Error("Сначала завершите открытые операции расширений.");
    const op: Operation = {
      dto: { requestId: input.requestId, phase: "preparing" },
      input: signature,
      abort: new AbortController(),
    };
    this.operations.set(input.requestId, op);
    op.pending = this.prepareOperation(input, op)
      .then((review) => {
        if (op.abort.signal.aborted) throw new Error("Операция отменена.");
        op.dto = { ...op.dto, phase: "review", review };
        op.timer = setTimeout(() => {
          void this.cancel(input.requestId).catch(() => {});
        }, 30 * 60_000);
        op.timer.unref();
        return review;
      })
      .catch(async (error) => {
        if (op.candidate) await this.packages.abortCandidate(op.candidate);
        op.dto = {
          ...op.dto,
          phase: op.abort.signal.aborted ? "cancelled" : "error",
          error: safeExtensionText(
            error instanceof Error
              ? error.message
              : "Не удалось проверить пакет.",
          ),
        };
        throw error;
      });
    return op.pending;
  }
  private async prepareOperation(
    input: RequestMap["extensions/prepare"]["params"],
    op: Operation,
  ): Promise<ExtensionReview> {
    if (input.kind === "install" || input.kind === "update") {
      if (!input.source || (input.kind === "update" && !input.id))
        throw new Error("Выберите подготовленную папку или ZIP.");
      const options = {
        signal: op.abort.signal,
        progress: (progress: NonNullable<ExtensionOperation["progress"]>) => {
          op.dto.progress = progress;
        },
      };
      op.candidate =
        input.kind === "install"
          ? await this.packages.prepareInstall(input.source, options)
          : await this.packages.prepareUpdate(input.id!, input.source, options);
      const p = op.candidate.preview,
        registry = await readExtensionRegistry();
      op.selectedDigest = p.oldDigest;
      if (p.expectedRevision === undefined)
        op.registryRevision = registry.revision;
      return frozenClone({
        kind: p.kind,
        id: p.id,
        name: p.name,
        version: p.version,
        digest: p.digest,
        location: p.location,
        bytes: p.bytes,
        files: p.files,
        sourceKind: p.sourceKind,
        oldVersion: p.oldVersion,
        oldDigest: p.oldDigest,
        incompatible: p.incompatible,
        requestedEnabled: p.requestedEnabled,
        trustRequired: p.trustRequired,
        downgrade: p.downgrade,
        description: p.description,
        entry: p.entry,
        compatibility: p.compatibility,
        requestId: input.requestId,
        revision: p.expectedRevision ?? registry.revision,
        contents: [...p.contents],
      });
    }
    const row = await this.packages.status(ExternalIdSchema.parse(input.id)),
      version =
        input.kind === "rollback"
          ? row.versions.find((v) => v.key === input.versionKey)
          : row.selected;
    if (!version || row.removed) conflict("Выбранная версия недоступна.");
    op.versionKey = version.key;
    op.selectedDigest = row.selected?.digest;
    const candidate =
      input.kind === "remove"
        ? undefined
        : await inspectPackage(version.location, op.abort.signal);
    if (candidate && candidate.digest !== version.digest)
      conflict("Сохранённая версия изменена; подготовьте новый пакет.");
    const trusted =
      !!candidate &&
      receiptMatches({ ...version, enabled: row.enabled }, candidate);
    return frozenClone({
      requestId: input.requestId,
      kind: input.kind,
      id: row.id,
      name: version.name ?? row.name,
      version: version.version,
      digest: version.digest,
      revision: row.revision,
      oldVersion: row.selected?.version,
      oldDigest: row.selected?.digest,
      location: version.location,
      bytes: version.bytes,
      files: version.files,
      incompatible: candidate?.incompatible,
      downgrade: input.kind === "rollback",
      trustRequired:
        input.kind === "trust" || (input.kind === "rollback" && !trusted),
      requestedEnabled: row.enabled,
      description: safeExtensionText(candidate?.manifest.description ?? ""),
      entry: version.entry,
      compatibility: candidate?.manifest.chiselVersion ?? "API v1",
      contents:
        candidate?.contents.map((f) => ({
          ...f,
          path: safeExtensionText(f.path),
        })) ?? [],
    });
  }
  operation(requestId: string): ExtensionOperation {
    const op = this.operations.get(requestId);
    if (!op) conflict("Операция недоступна; перечитайте список.");
    return frozenClone(op.dto);
  }
  async cancel(requestId: string): Promise<{ ok: boolean }> {
    const op = this.operations.get(requestId);
    if (!op || ["cancelled", "completed"].includes(op.dto.phase))
      return { ok: true };
    op.abort.abort();
    clearTimeout(op.timer);
    if (op.pending) await op.pending.catch(() => {});
    if (op.commit) await op.commit.catch(() => {});
    if (op.dto.phase !== "completed") {
      if (op.candidate) await this.packages.abortCandidate(op.candidate);
      op.dto = { requestId, phase: "cancelled" };
    }
    return { ok: true };
  }
  async commit(
    input: RequestMap["extensions/commit"]["params"],
  ): Promise<ExtensionResult> {
    if (this.operations.get(input.requestId)?.dto.phase === "cancelled")
      conflict("Review закрыт; подготовьте новое подтверждение.");
    const op = this.operations.get(input.requestId),
      review = op?.dto.review;
    if (
      !op ||
      !review ||
      input.digest !== review.digest ||
      input.revision !== review.revision
    )
      conflict(
        "Подтверждение не соответствует точному review/digest/revision.",
      );
    const signature = JSON.stringify(input);
    if (op.commit) {
      if (op.confirmation !== signature)
        conflict("Операция уже получила другое подтверждение.");
      return op.commit;
    }
    if (op.dto.phase !== "review" || op.abort.signal.aborted)
      conflict("Review закрыт; подготовьте новое подтверждение.");
    if (review.incompatible) throw new Error(review.incompatible);
    if (
      review.kind !== "remove" &&
      review.trustRequired &&
      review.kind !== "install" &&
      !input.trust
    )
      throw new Error("Новое доверие не выдано; прежняя версия сохранена.");
    if (input.enable && !input.trust && review.kind === "install")
      throw new Error("Включение требует явного доверия.");
    op.confirmation = signature;
    op.dto.phase = "committing";
    clearTimeout(op.timer);
    op.commit = (async () => {
      const expected = {
        digest: op.selectedDigest ?? review.digest,
        revision: review.revision,
      };
      const options = {
        registryRevision: op.registryRevision,
        ...(input.trust
          ? { digest: review.digest, acknowledgeProcessAccess: true }
          : {}),
        ...(input.enable !== undefined ? { enabled: input.enable } : {}),
        signal: op.abort.signal,
      };
      let result: ExtensionResult;
      if (op.candidate)
        result = await this.packages.commitCandidate(op.candidate, options);
      else if (review.kind === "trust")
        result = await this.packages.trust(review.id, expected, options);
      else if (review.kind === "rollback")
        result = await this.packages.rollback(
          review.id,
          op.versionKey!,
          expected,
          options,
        );
      else result = await this.packages.remove(review.id, expected);
      const disabled = review.kind === "remove" || input.enable === false;
      const disabling = disabled
        ? this.options.disableExternal?.(result.id)
        : undefined;
      const cleanup = disabling?.then(
        () => undefined,
        () => "Очистка расширения не подтверждена; ресурсы защищены.",
      );
      this.notify(disabled ? { id: result.id } : undefined);
      const warning = await cleanup;
      const appliedUi = await this.options
        .applyUi?.(result.id)
        .catch(() => false);
      op.dto = {
        requestId: input.requestId,
        phase: "completed",
        result: {
          id: result.id,
          restartRequired: !!warning || (result.restartRequired && !appliedUi),
          deferred: result.deferred,
          ...(warning || result.warning
            ? { warning: warning ?? result.warning }
            : {}),
        },
      };
      return op.dto.result!;
    })().catch(async (error) => {
      if (op.candidate) await this.packages.abortCandidate(op.candidate);
      op.dto = {
        requestId: input.requestId,
        phase: op.abort.signal.aborted ? "cancelled" : "error",
        error: safeExtensionText(
          error instanceof Error ? error.message : "Операция не завершена.",
        ),
      };
      throw error;
    });
    return op.commit;
  }
  async setEnabled(
    input: RequestMap["extensions/setEnabled"]["params"],
  ): Promise<ExtensionResult> {
    if (input.id.startsWith("builtin.")) {
      const item = (await this.list(input.path)).items.find(
        (i) => i.id === input.id,
      );
      if (
        !item ||
        item.digest !== input.digest ||
        (!item.settingsRoute && input.id !== "builtin.browser") ||
        !item.actions.includes(input.enabled ? "enable" : "disable")
      )
        conflict();
      if (input.id === "builtin.browser") {
        await toggleBrowser(
          input.path,
          this.options.configPath,
          input.enabled,
          item.projectBlocked,
          (global) => {
            if (hash(global.browser ?? {}) !== input.digest) conflict();
          },
        );
        await this.builtinChanged(input.id, input.path);
        return { id: input.id, restartRequired: false, deferred: false };
      }
      const id = BuiltinIdSchema.parse(input.id);
      const store = this.store(id, input.path);
      const projectOnly = item.projectBlocked && input.enabled;
      const setEnabled = async <
        T extends {
          global: { enabled: boolean };
          project: { enabled?: boolean };
          globalRevision: string;
          projectRevision: string;
        },
      >(settings: {
        load(): Promise<T>;
        saveGlobal(value: T["global"], revision: string): Promise<T>;
        saveProject(value: T["project"], revision: string): Promise<T>;
      }) => {
        const state = await settings.load();
        if (state.globalRevision !== input.digest) conflict();
        if (projectOnly)
          await settings.saveProject(
            { ...state.project, enabled: undefined },
            state.projectRevision,
          );
        else
          await settings.saveGlobal(
            { ...state.global, enabled: input.enabled },
            state.globalRevision,
          );
      };
      if (store instanceof LspSettingsStore) {
        const state = await store.load();
        if (state.globalRevision !== input.digest) conflict();
        await store.setEnabled(
          projectOnly ? "project" : "global",
          projectOnly ? undefined : input.enabled,
          state,
        );
      } else if (store instanceof SubagentSettingsStore) {
        await setEnabled(store);
      } else {
        await setEnabled(store);
      }
      await this.builtinChanged(id, input.path);
      return { id: input.id, restartRequired: false, deferred: false };
    }
    if (
      input.enabled &&
      input.path &&
      (await this.list(input.path)).items.find((i) => i.id === input.id)
        ?.projectBlocked
    )
      throw new Error("Расширение запрещено для этого проекта.");
    const result = await this.packages.setEnabled(
      input.id,
      input.enabled,
      input,
    );
    const changing = input.enabled
      ? this.options.enableExternal?.(result.id)
      : this.options.disableExternal?.(result.id);
    const cleanup = changing?.then(
      () => undefined,
      () =>
        "Очистка или активация расширения не подтверждена; ресурсы защищены.",
    );
    this.notify(input.enabled ? undefined : { id: result.id });
    const appliedUi = await this.options
      .applyUi?.(result.id)
      .catch(() => false);
    const warning =
      (await cleanup) ??
      (this.options.externalNeedsRestart?.(result.id) &&
      appliedUi === false &&
      input.enabled
        ? "Активация ждёт перезапуска."
        : undefined);
    this.notify();
    return {
      id: result.id,
      restartRequired:
        !!warning ||
        this.options.externalNeedsRestart?.(result.id) ||
        (result.restartRequired &&
          !appliedUi &&
          (input.enabled || !this.options.disableExternal)),
      deferred: result.deferred,
      ...(warning ? { warning } : {}),
    };
  }
  async settings(
    input: RequestMap["extensions/settings/read"]["params"],
    save?: RequestMap["extensions/settings/save"]["params"],
  ): Promise<ExtensionSettings> {
    const result = await withExtensionRegistry(async (registry) => {
      const row = registry.records.find(
          (r) => r.id === ExternalIdSchema.parse(input.id),
        ),
        version = row && selectedVersion(row);
      if (
        !row ||
        row.removedAt ||
        !row.enabled ||
        row.revision !== input.revision ||
        !version ||
        version.digest !== input.digest
      )
        conflict();
      const candidate = await inspectPackage(version.location);
      if (candidate.digest !== version.digest)
        conflict("Пакет изменён; настройки не сохранены.");
      const store = new ExtensionSettingsStore(candidate.manifest);
      const settings = await (save
        ? store.save({
            revision: save.settingsRevision,
            values: save.values,
            secrets: save.secrets,
            clearSecrets: save.clearSecrets,
            reset: save.reset,
          })
        : store.read());
      return !save &&
        candidate.manifest.kind === "ui" &&
        this.options.applyUi &&
        this.options.canApplyUi?.(input.id) !== false
        ? { ...settings, restartRequired: false }
        : settings;
    });
    if (save && (await this.options.applyUi?.(input.id).catch(() => false)))
      return { ...result, restartRequired: false };
    return result;
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.operations.keys()].map((id) => this.cancel(id)),
    );
    this.operations.clear();
    this.listeners.clear();
  }
}
